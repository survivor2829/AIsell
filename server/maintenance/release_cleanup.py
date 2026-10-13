"""Remove only published upload duplicates; never prune releases or business data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time
from promote_components import publication_lock
from service import APP_IDS

STAGING = re.compile(r"(?:ai-release-|ai-components-|incoming-|components-incoming-|components-preflight-|ai-components-preflight-)([0-9]+)")
HEX = re.compile(r"[0-9a-f]{64}")


def cleanup(root=Path('/var/lib/ai-maintenance'), upload_root=Path('/home/ubuntu'), *, apply=False,
            min_age_seconds=86400, require_free_bytes=0, verified_plan=None):
    root, upload_root = Path(root), Path(upload_root)
    if any(p.is_symlink() or p.resolve() != p.absolute() or p.parent == p for p in (root, upload_root)):
        raise ValueError('cleanup_root_invalid')
    verified = {}

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def file_hash(file, size, digest):
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != size:
            raise ValueError('duplicate_file_invalid')
        fingerprint = identity(info)
        if verified.get(str(file)) != (fingerprint, digest):
            with file.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                    raise ValueError('duplicate_hash_mismatch')
            verified[str(file)] = (fingerprint, digest)
        return fingerprint

    def reuse_verified_plan():
        # A root-owned dry-run receipt avoids rereading tens of GB for the
        # immediate apply. ctime must predate the audit START, so touching a
        # file during or after that audit invalidates reuse, even if mtime is reset.
        # Windows ctime is creation time, not the Linux metadata-change clock.
        if os.name != 'posix' or not verified_plan or verified_plan.get('schema') != 1:
            return
        started = verified_plan.get('createdAt', 0)
        if not 0 <= time.time() - started <= 3600:
            return
        for entry in verified_plan.get('candidates', []):
            directory = Path(entry['path'])
            if directory.parent not in (root, upload_root) or not STAGING.fullmatch(directory.name):
                continue
            try:
                info = directory.lstat()
                if directory.is_symlink() or [info.st_dev, info.st_ino] != list(entry['directoryIdentity']):
                    continue
                if {p.name for p in directory.iterdir()} != set(entry['identities']):
                    continue
                files = {name: (directory / name).lstat() for name in entry['identities']}
                if any(not stat.S_ISREG(info.st_mode) or list(identity(info)[:4]) != old[:4]
                       or info.st_ctime > started for name, info in files.items()
                       for old in [list(entry['identities'][name])]):
                    continue
                document = 'latest.json' if 'latest.json' in files else 'latest-components.json'
                manifest = json.loads(json.loads((directory / document).read_text())['payload'])
                items = manifest['components'].values() if document == 'latest-components.json' else [manifest]
                for item in items:
                    digest, size = item['sha256'], item['size']
                    if not HEX.fullmatch(digest):
                        continue
                    component = document == 'latest-components.json'
                    name = digest + '.zip' if component else 'installer.exe'
                    canonical = root / ('components' if component else 'artifacts') / (digest + ('.zip' if component else '.exe'))
                    current = canonical.lstat()
                    if stat.S_ISREG(current.st_mode) and current.st_size == size and current.st_ctime <= started:
                        verified[str(canonical)] = (identity(current), digest)
                    if name in files and files[name].st_size == size:
                        verified[str(directory / name)] = (identity(files[name]), digest)
            except (OSError, ValueError, KeyError, TypeError):
                continue

    def candidate(directory, sequence):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or time.time() - info.st_mtime < min_age_seconds:
            raise ValueError('recent_or_not_directory')
        names = {p.name for p in directory.iterdir()}
        document = 'latest.json' if 'latest.json' in names else 'latest-components.json'
        source = directory / document
        if not source.is_file() or source.is_symlink():
            raise ValueError('published_document_missing')
        envelope = json.loads(source.read_text())
        manifest = json.loads(envelope['payload'])
        channel = manifest['channel']
        if (channel not in APP_IDS or manifest.get('appId') != APP_IDS[channel]
                or manifest['sequence'] != sequence or manifest['schema'] not in (1, 2)):
            raise ValueError('published_identity_mismatch')
        component = manifest['schema'] == 2
        if component != (document == 'latest-components.json'):
            raise ValueError('published_schema_mismatch')
        history = root / 'releases' / channel / (f'components-{sequence}.json' if component else f'{sequence}.json')
        if history.is_symlink() or json.loads(history.read_text()) != envelope:
            raise ValueError('published_history_mismatch')
        artifacts = {}
        if component:
            for item in manifest['components'].values():
                digest = item['sha256']
                if not HEX.fullmatch(digest) or item['file'] != f'/components/{digest}.zip':
                    raise ValueError('artifact_path_invalid')
                artifacts[f'{digest}.zip'] = (root / 'components' / f'{digest}.zip', item['size'], digest)
        else:
            digest = manifest['sha256']
            if not HEX.fullmatch(digest) or manifest['file'] != f'/artifacts/{digest}.exe':
                raise ValueError('artifact_path_invalid')
            artifacts['installer.exe'] = (root / 'artifacts' / f'{digest}.exe', manifest['size'], digest)
        if not names <= {document, *artifacts} or (not component and names != {document, 'installer.exe'}):
            raise ValueError('unique_or_unexpected_files')
        for canonical, size, digest in artifacts.values():
            file_hash(canonical, size, digest)
        identities, size = {}, 0
        for name in sorted(names):
            file = directory / name
            if name != document:
                _, expected_size, digest = artifacts[name]
                identities[name] = file_hash(file, expected_size, digest)
            else:
                entry = file.lstat()
                if not stat.S_ISREG(entry.st_mode):
                    raise ValueError('document_invalid')
                identities[name] = identity(entry)
            size += identities[name][2]
        return {'path': str(directory), 'bytes': size, 'sequence': sequence,
                'version': manifest['version'], 'identities': identities,
                'directoryIdentity': (info.st_dev, info.st_ino)}

    result = {'schema': 1, 'apply': apply, 'createdAt': time.time(), 'candidates': [], 'retained': [], 'removed': [], 'errors': []}
    with publication_lock(root / 'publish.lock'):
        reuse_verified_plan()
        before = shutil.disk_usage(root).free
        for parent in (root, upload_root):
            for directory in sorted(parent.iterdir()):
                match = STAGING.fullmatch(directory.name)
                if not match:
                    continue
                try:
                    entry = candidate(directory, int(match[1]))
                except (OSError, ValueError, KeyError, TypeError) as error:
                    result['retained'].append({'path': str(directory), 'reason': type(error).__name__ + ':' + str(error)[:100]})
                    continue
                result['candidates'].append(entry)
        if apply:
            audit = root / 'cleanup-audit.jsonl'
            for entry in result['candidates']:
                directory = Path(entry['path'])
                try:
                    info = directory.lstat()
                    if directory.is_symlink() or (info.st_dev, info.st_ino) != entry['directoryIdentity']:
                        raise ValueError('staging_identity_changed')
                    if {p.name for p in directory.iterdir()} != set(entry['identities']):
                        raise ValueError('staging_contents_changed')
                    for name, expected_identity in entry['identities'].items():
                        info = (directory / name).lstat()
                        if identity(info) != expected_identity:
                            raise ValueError('staging_contents_changed')
                    descriptor = os.open(audit, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                    with os.fdopen(descriptor, 'a') as stream:
                        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                            raise ValueError('audit_file_invalid')
                        stream.write(json.dumps({'operation': 'remove-published-duplicate', **entry}) + '\n')
                        stream.flush()
                        os.fsync(stream.fileno())
                    shutil.rmtree(directory)
                    result['removed'].append(entry['path'])
                except (OSError, ValueError) as error:
                    result['errors'].append({'path': str(directory), 'reason': str(error)[:100]})
        result.update(beforeFreeBytes=before, afterFreeBytes=shutil.disk_usage(root).free)
        result['releasedBytes'] = result['afterFreeBytes'] - before
        result['spaceSufficient'] = result['afterFreeBytes'] >= require_free_bytes
        if apply:
            with tempfile.NamedTemporaryFile(mode='w', dir=root, prefix='.cleanup-', delete=False) as stream:
                temporary = Path(stream.name)
                json.dump(result, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, root / 'cleanup-latest.json')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--min-age-hours', type=float, default=24)
    parser.add_argument('--require-free-bytes', type=int, default=0)
    parser.add_argument('--verified-plan', type=Path)
    args = parser.parse_args()
    if args.min_age_hours < 0 or args.require_free_bytes < 0:
        parser.error('age and space limits must be nonnegative')
    plan = None
    if args.verified_plan:
        descriptor = os.open(args.verified_plan, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                parser.error('verified plan must be a private file owned by the current maintenance user')
            plan = json.load(stream)
    result = cleanup(apply=args.apply, min_age_seconds=args.min_age_hours * 3600,
                     require_free_bytes=args.require_free_bytes, verified_plan=plan)
    print(json.dumps(result))
    raise SystemExit(0 if result['spaceSufficient'] and not result['errors'] else 1)
