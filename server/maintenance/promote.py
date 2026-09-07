"""SSH-only publication: verify artifact before atomically changing the channel pointer."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from service import APP_IDS, HEX, VERSION

def promote(envelope_path, installer_path, root="/var/lib/ai-maintenance"):
    envelope = json.loads(Path(envelope_path).read_text())
    manifest = json.loads(envelope["payload"])
    channel = manifest["channel"]
    if channel not in APP_IDS or manifest["appId"] != APP_IDS[channel] or not VERSION.fullmatch(manifest["version"]):
        raise ValueError("release_identity")
    digest = manifest["sha256"]
    if not HEX.fullmatch(digest) or manifest["file"] != f"/artifacts/{digest}.exe":
        raise ValueError("artifact_path")
    source = Path(installer_path)
    with source.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != digest or source.stat().st_size != manifest["size"]:
        raise ValueError("artifact_hash")
    root = Path(root)
    artifacts = root / "artifacts"
    releases = root / "releases" / channel
    artifacts.mkdir(exist_ok=True)
    releases.mkdir(parents=True, exist_ok=True)
    with (root / "publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        latest = releases / "latest.json"
        if latest.exists():
            previous = json.loads(json.loads(latest.read_text())["payload"])
            if manifest["sequence"] <= previous["sequence"] or tuple(map(int, manifest["version"].split("."))) <= tuple(map(int, previous["version"].split("."))):
                raise ValueError("release_must_advance")
        target = artifacts / (digest + ".exe")
        if not target.exists():
            temporary = artifacts / (digest + ".part")
            shutil.copyfile(source, temporary)
            with temporary.open("rb") as stream:
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        document = json.dumps(envelope)
        history = releases / (str(manifest["sequence"]) + ".json")
        with history.open("x") as stream:
            stream.write(document)
            stream.flush()
            os.fsync(stream.fileno())
        temporary = releases / "latest.tmp"
        temporary.write_text(document)
        os.replace(temporary, latest)
    return {"published": True, "version": manifest["version"], "channel": channel, "sha256": digest}

if __name__ == "__main__":
    print(json.dumps(promote(sys.argv[1], sys.argv[2])))
