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
from mobile_releases import folder, read_envelope, validate_envelope


def digest_of(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def intact(file, size, digest):
    return not file.is_symlink() and file.is_file() and file.stat().st_size == size and digest_of(file) == digest


def check_advance(manifest, previous):
    """A new build must be a new APK with a higher version; a same-build republish (switches) changes nothing else."""
    if manifest["sequence"] <= previous["sequence"] or manifest["versionCode"] < previous["versionCode"]:
        raise ValueError("release_must_advance")
    if manifest["certSha256"] != previous["certSha256"]:
        raise ValueError("signing_certificate_changed")
    if manifest["versionCode"] == previous["versionCode"]:
        if any(manifest[key] != previous[key] for key in ("sha256", "size", "versionName")):
            raise ValueError("same_version_different_apk")
    else:
        version = lambda text: tuple(map(int, text.split(".")))
        if manifest["sha256"] == previous["sha256"] or version(manifest["versionName"]) <= version(previous["versionName"]):
            raise ValueError("new_version_needs_new_apk")


def promote(envelope_path, apk_path=None, root="/var/lib/ai-maintenance"):
    envelope = json.loads(Path(envelope_path).read_text(encoding="utf-8"))
    manifest = validate_envelope(envelope)
    digest, size = manifest["sha256"], manifest["size"]
    root = Path(root)
    artifacts, releases = root / "artifacts", folder(root, manifest["channel"])
    artifacts.mkdir(parents=True, exist_ok=True)
    releases.mkdir(parents=True, exist_ok=True)
    target = artifacts / (digest + ".apk")
    if apk_path is not None and not intact(Path(apk_path), size, digest):
        raise ValueError("artifact_hash")
    with publication_lock(root / "publish.lock"):
        latest = releases / "latest.json"
        if latest.exists() or latest.is_symlink():
            check_advance(manifest, json.loads(read_envelope(latest)["payload"]))
        if not intact(target, size, digest):
            if apk_path is None:
                raise ValueError("artifact_missing")
            # Hash what was actually copied, so the trusted name never holds unchecked bytes.
            temporary = artifacts / (digest + ".apk.part")
            shutil.copyfile(apk_path, temporary)
            with temporary.open("r+b") as stream:
                os.fsync(stream.fileno())
            if not intact(temporary, size, digest):
                temporary.unlink()
                raise ValueError("artifact_hash")
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
