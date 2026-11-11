"""SSH-only publication of an Android release: verify the APK, then atomically move the channel pointer.

    python3 promote_mobile.py <latest.json> [app.apk]

Without the APK the envelope must point at an APK already on the server: that publishes switches only
(minimum version, paused platforms) for the same build.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
from promote_components import publication_lock
from mobile_releases import folder, validate_envelope


def digest_of(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def promote(envelope_path, apk_path=None, root="/var/lib/ai-maintenance"):
    envelope = json.loads(Path(envelope_path).read_text(encoding="utf-8"))
    manifest = validate_envelope(envelope)
    digest, size = manifest["sha256"], manifest["size"]
    root = Path(root)
    artifacts, releases = root / "artifacts", folder(root, manifest["channel"])
    artifacts.mkdir(parents=True, exist_ok=True)
    releases.mkdir(parents=True, exist_ok=True)
    target = artifacts / (digest + ".apk")
    if apk_path is not None:
        source = Path(apk_path)
        if source.is_symlink() or not source.is_file() or source.stat().st_size != size or digest_of(source) != digest:
            raise ValueError("artifact_hash")
    with publication_lock(root / "publish.lock"):
        latest = releases / "latest.json"
        if latest.exists():
            previous = json.loads(json.loads(latest.read_text(encoding="utf-8"))["payload"])
            if manifest["sequence"] <= previous["sequence"] or manifest["versionCode"] < previous["versionCode"]:
                raise ValueError("release_must_advance")
            if manifest["versionCode"] == previous["versionCode"] and digest != previous["sha256"]:
                raise ValueError("same_version_different_apk")
        if apk_path is None:
            if target.is_symlink() or not target.is_file() or target.stat().st_size != size or digest_of(target) != digest:
                raise ValueError("artifact_missing")
        elif not target.exists():
            temporary = artifacts / (digest + ".apk.part")
            shutil.copyfile(source, temporary)
            with temporary.open("r+b") as stream:
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        document = json.dumps(envelope)
        with (releases / f'{manifest["sequence"]}.json').open("x", encoding="utf-8") as stream:
            stream.write(document)
            stream.flush()
            os.fsync(stream.fileno())
        temporary = releases / "latest.tmp"
        with temporary.open("w", encoding="utf-8") as stream:
            stream.write(document)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, latest)
    return {"published": True, "channel": manifest["channel"], "versionName": manifest["versionName"],
            "versionCode": manifest["versionCode"], "sequence": manifest["sequence"], "sha256": digest}


if __name__ == "__main__":
    print(json.dumps(promote(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)))
