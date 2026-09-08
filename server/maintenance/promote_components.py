"""SSH-only v2 publication. Signed client envelope is locally verified by publisher."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from contextlib import contextmanager
from service import APP_IDS, HEX, VERSION

COMPONENTS = {"application", "content-engine", "product-detail", "video"}

@contextmanager
def publication_lock(file):
    # Production is Linux; Windows branch supports the isolated publication fixture.
    with file.open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.write(b"0")
            lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)

def promote(envelope_path, incoming_dir, root="/var/lib/ai-maintenance"):
    envelope = json.loads(Path(envelope_path).read_text(encoding="utf-8"))
    manifest = json.loads(envelope["payload"])
    channel = manifest.get("channel")
    if (manifest.get("schema") != 2 or channel not in APP_IDS or manifest.get("appId") != APP_IDS[channel]
            or not VERSION.fullmatch(str(manifest.get("version", "")))
            or manifest.get("platform") != "win32" or manifest.get("arch") != "x64"
            or type(manifest.get("sequence")) is not int or manifest["sequence"] < 1
            or set(manifest.get("components", {})) != COMPONENTS):
        raise ValueError("release_identity")
    root, incoming = Path(root), Path(incoming_dir)
    root.mkdir(parents=True, exist_ok=True)
    artifacts, releases = root / "components", root / "releases" / channel
    artifacts.mkdir(exist_ok=True)
    releases.mkdir(parents=True, exist_ok=True)
    with publication_lock(root / "publish.lock"):
        latest = releases / "latest-components.json"
        if latest.exists():
            previous = json.loads(json.loads(latest.read_text(encoding="utf-8"))["payload"])
            if (manifest["sequence"] <= previous["sequence"] or
                    tuple(map(int, manifest["version"].split("."))) <= tuple(map(int, previous["version"].split(".")))):
                raise ValueError("release_must_advance")
        for name, component in manifest["components"].items():
            digest = component.get("sha256", "")
            if (component.get("name") != name or not HEX.fullmatch(digest)
                    or component.get("file") != f"/components/{digest}.zip"
                    or type(component.get("size")) is not int or not 0 < component["size"] <= 512 * 1024**2):
                raise ValueError("component_path")
            target = artifacts / (digest + ".zip")
            source = target if target.exists() else incoming / target.name
            if source.is_symlink() or not source.is_file():
                raise ValueError("component_missing")
            with source.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != digest or source.stat().st_size != component["size"]:
                raise ValueError("component_hash")
            if source != target:
                temporary = artifacts / (digest + ".part")
                shutil.copyfile(source, temporary)
                with temporary.open("r+b") as stream:
                    os.fsync(stream.fileno())
                os.replace(temporary, target)
        document = json.dumps(envelope)
        history = releases / f'components-{manifest["sequence"]}.json'
        with history.open("x", encoding="utf-8") as stream:
            stream.write(document)
            stream.flush()
            os.fsync(stream.fileno())
        temporary = releases / "latest-components.tmp"
        with temporary.open("w", encoding="utf-8") as stream:
            stream.write(document)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, latest)
    return {"published": True, "version": manifest["version"], "channel": channel}

if __name__ == "__main__":
    print(json.dumps(promote(sys.argv[1], sys.argv[2])))
