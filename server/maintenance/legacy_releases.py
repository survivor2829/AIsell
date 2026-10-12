"""Pinned legacy envelopes, enabled only by an SSH-only atomic publication.

No request identity can distinguish the bases of headerless clients. This route
offers one component base, never guesses from IP, and never rewrites signed data.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import zipfile

VERSION = re.compile(r"(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")
COMPONENTS = {"application", "content-engine", "product-detail", "video"}
HEADERS = ("X-Xiaoxi-Update-Protocol", "X-Xiaoxi-Version", "X-Xiaoxi-Base-Version", "X-Xiaoxi-Base-Fingerprint")
MAX_CONFIG = 128 * 1024
EMBEDDED_TARGET = "files/resources/app/src/main/legacy-update-target.json"


def version(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        raise ValueError("legacy_version_invalid")
    return tuple(map(int, value.split(".")))


def modern_request(headers):
    values = [headers.get(name) for name in HEADERS]
    if all(value is None for value in values):
        return False
    protocol, current, base, fingerprint = values
    if (protocol != "3" or not VERSION.fullmatch(current or "")
            or bool(base) != bool(fingerprint)
            or (base and (not VERSION.fullmatch(base) or not HEX.fullmatch(fingerprint)))):
        raise ValueError("update_capability_invalid")
    # Repeated headers are not a second, unauthenticated routing channel.
    if hasattr(headers, "get_all") and any(len(headers.get_all(name, [])) > 1 for name in HEADERS):
        raise ValueError("update_capability_invalid")
    return True


def read_document(file):
    if file.is_symlink() or file.stat().st_size > MAX_CONFIG:
        raise ValueError("legacy_config_invalid")
    document = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError("legacy_config_invalid")
    return document


def signed_manifest(envelope, public_key, channel, app_id, schema):
    if not isinstance(envelope, dict) or set(envelope) != {"payload", "signature"}:
        raise ValueError("legacy_envelope_invalid")
    payload, signature = envelope["payload"], envelope["signature"]
    if (not isinstance(payload, str) or len(payload.encode("utf-8")) > (16384 if schema == 1 else 32768)
            or not isinstance(signature, str) or len(signature) > 128):
        raise ValueError("legacy_envelope_invalid")
    try:
        signature = base64.b64decode(signature, validate=True)
    except ValueError as error:
        raise ValueError("legacy_signature_invalid") from error
    if len(signature) != 64 or public_key.is_symlink() or not public_key.is_file():
        raise ValueError("legacy_signature_invalid")
    # Same Ed25519/SPKI contract as desktop cloud-contract.cjs. Only the public
    # key is provisioned on the server, separately from candidate configuration.
    with tempfile.TemporaryDirectory(prefix="release-verify-") as temporary:
        root = Path(temporary)
        (root / "payload").write_bytes(payload.encode("utf-8"))
        (root / "signature").write_bytes(signature)
        result = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-rawin", "-inkey", str(public_key),
                                 "-in", str(root / "payload"), "-sigfile", str(root / "signature")],
                                capture_output=True, timeout=10, check=False)
        if result.returncode:
            raise ValueError("legacy_signature_invalid")
    manifest = json.loads(payload)
    if (not isinstance(manifest, dict) or manifest.get("schema") != schema or manifest.get("channel") != channel
            or manifest.get("appId") != app_id or manifest.get("platform") != "win32" or manifest.get("arch") != "x64"
            or type(manifest.get("sequence")) is not int or not 0 < manifest["sequence"] <= 9007199254740991
            or not isinstance(manifest.get("notes"), str) or len(manifest["notes"]) > 2000):
        raise ValueError("legacy_release_identity")
    version(manifest.get("version"))
    if schema == 2:
        base = manifest.get("base")
        if (not isinstance(base, dict) or not HEX.fullmatch(str(base.get("fingerprint", "")))
                or type(manifest.get("dataSchema")) is not int or manifest["dataSchema"] < 1
                or not isinstance(manifest.get("components"), dict) or set(manifest["components"]) != COMPONENTS):
            raise ValueError("legacy_component_identity")
        if version(base.get("version")) < version(manifest.get("minBaseVersion")):
            raise ValueError("legacy_component_base")
    return manifest


def artifact(root, item, kind, verify_hash):
    digest, size = item.get("sha256"), item.get("size")
    suffix, limit = ("exe", 8 * 1024**3) if kind == "artifacts" else ("zip", 512 * 1024**2)
    if (not isinstance(digest, str) or not HEX.fullmatch(digest) or type(size) is not int or not 0 < size <= limit
            or item.get("file") != f"/{kind}/{digest}.{suffix}"):
        raise ValueError("legacy_artifact_identity")
    file = root / kind / f"{digest}.{suffix}"
    if file.is_symlink() or not file.is_file() or file.stat().st_size != size:
        raise ValueError("legacy_artifact_missing")
    if verify_hash:
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                raise ValueError("legacy_artifact_hash")
    return file


def validate_embedded_target(file, expected):
    # Component entries are relative to the installed program root, not app/.
    try:
        with zipfile.ZipFile(file) as archive:
            entries = [entry for entry in archive.infolist() if entry.filename == EMBEDDED_TARGET]
            if len(entries) != 1 or entries[0].file_size > 32768:
                raise ValueError("legacy_embedded_target_mismatch")
            target = json.loads(archive.read(entries[0]))
    except (KeyError, ValueError, UnicodeError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise ValueError("legacy_embedded_target_mismatch") from None
    if target != expected:
        raise ValueError("legacy_embedded_target_mismatch")


def validate_config(document, root, channel, app_ids, verify_artifacts=True):
    if (set(document) != {"schema", "channel", "sourceVersion", "legacyFull", "legacyComponents", "finalFull"}
            or document.get("schema") != 1 or document.get("channel") != channel or channel not in app_ids):
        raise ValueError("legacy_config_invalid")
    public_key = root / "releases" / channel / "signing-public.pem"
    full, components, final = [signed_manifest(document[key], public_key, channel, app_ids[channel], schema)
                               for key, schema in (("legacyFull", 1), ("legacyComponents", 2), ("finalFull", 1))]
    if (version(full["version"]) > version(components["version"])
            or version(document["sourceVersion"]) >= version(components["version"])
            or version(final["version"]) <= version(components["version"])
            or final["sequence"] <= full["sequence"]):
        raise ValueError("legacy_version_order")
    for manifest in (full, final):
        artifact(root, manifest, "artifacts", verify_artifacts)
    for name, item in components["components"].items():
        if (not isinstance(item, dict) or item.get("name") != name or not HEX.fullmatch(str(item.get("treeSha256", "")))
                or type(item.get("fileCount")) is not int or not 1 <= item["fileCount"] <= 50000
                or type(item.get("expandedSize")) is not int or not 0 <= item["expandedSize"] <= 8 * 1024**3):
            raise ValueError("legacy_component_identity")
        file = artifact(root, item, "components", verify_artifacts)
        if name == "application" and verify_artifacts:
            # The final target returned after the first restart must be the same
            # signed envelope that was inspected before enabling this route.
            validate_embedded_target(file, document["finalFull"])
    return full, components, final


class LegacyReleaseRouter:
    def __init__(self, root, app_ids):
        self.root, self.app_ids = Path(root), app_ids
        self.lock, self.cache = threading.Lock(), {}

    def latest(self, channel, protocol, headers):
        modern = modern_request(headers)
        folder = self.root / "releases" / channel
        config = folder / "legacy-routing.json"
        if modern or (not config.exists() and not config.is_symlink()):
            file = folder / ("latest-components.json" if protocol == "2" else "latest.json")
            return read_document(file) if file.exists() else {"empty": True}
        public_key = folder / "signing-public.pem"
        with self.lock:
            stamp = tuple((file.stat().st_ino, file.stat().st_mtime_ns, file.stat().st_size) for file in (config, public_key))
            cached = self.cache.get(channel)
            if cached is None or cached[0] != stamp:
                document = read_document(config)
                validate_config(document, self.root, channel, self.app_ids)
                self.cache[channel] = (stamp, document)
            else:
                document = cached[1]
            return document["legacyComponents" if protocol == "2" else "legacyFull"]


def publish(candidate, root, app_ids, check_only=False):
    # Same lock as ordinary v1/v2 publishing; a single pointer contains BOTH
    # legacy envelopes, so an incomplete pair is never exposed by deployment.
    from promote_components import publication_lock
    root = Path(root)
    document = read_document(Path(candidate))
    channel = document.get("channel")
    if channel not in app_ids:
        raise ValueError("legacy_config_invalid")
    with publication_lock(root / "publish.lock"):
        full, components, final = validate_config(document, root, channel, app_ids)
        folder = root / "releases" / channel
        current = signed_manifest(read_document(folder / "latest.json"), folder / "signing-public.pem", channel, app_ids[channel], 1)
        if version(current["version"]) < version(final["version"]) or current["sequence"] < final["sequence"]:
            raise ValueError("legacy_final_not_published")
        published = read_document(folder / "latest.json") if current["version"] == final["version"] else read_document(folder / f'{final["sequence"]}.json')
        if published != document["finalFull"]:
            raise ValueError("legacy_final_not_published")
        file = folder / "legacy-routing.json"
        if file.exists():
            previous = read_document(file)
            old = validate_config(previous, root, channel, app_ids, verify_artifacts=False)
            for new, prior in zip((full, components, final), old):
                if version(new["version"]) < version(prior["version"]) or new["sequence"] < prior["sequence"]:
                    raise ValueError("legacy_route_must_not_regress")
            # Same sequence denotes exactly one signed release, never a rewrite.
            for key in ("legacyFull", "legacyComponents", "finalFull"):
                new, prior = json.loads(document[key]["payload"]), json.loads(previous[key]["payload"])
                if (new["sequence"] == prior["sequence"] or new["version"] == prior["version"]) and document[key] != previous[key]:
                    raise ValueError("legacy_sequence_reused")
        if not check_only:
            fd, temporary = tempfile.mkstemp(prefix="legacy-routing-", suffix=".tmp", dir=folder)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(document, stream, ensure_ascii=False)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(temporary, 0o644)  # Public signed envelopes, never keys or customer data.
                os.replace(temporary, file)
                if os.name != "nt":
                    directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return {"checked": True, "published": not check_only, "channel": channel, "bridgeVersion": components["version"],
                "base": components["base"], "targetVersion": final["version"]}


if __name__ == "__main__":
    from service import APP_IDS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate")
    parser.add_argument("--root", default="/var/lib/ai-maintenance")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    print(json.dumps(publish(args.candidate, args.root, APP_IDS, args.check)))
