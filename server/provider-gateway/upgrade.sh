#!/bin/sh
set -eu

[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=/opt/ai-provider-gateway
data_dir=/var/lib/ai-provider-gateway
[ -s "$app_dir/service.py" ] || {
  echo 'Existing provider gateway installation is required; use install.sh first.' >&2
  exit 1
}
[ -s "$source_dir/service.py" ] || { echo 'Missing deployment file: service.py' >&2; exit 1; }
[ -s "$source_dir/material_search.py" ] || { echo 'Missing deployment file: material_search.py' >&2; exit 1; }


python3 - "$source_dir/service.py" "$source_dir/material_search.py" <<'PY'
from pathlib import Path
import sys
for filename in sys.argv[1:]:
    compile(Path(filename).read_text(encoding="utf-8"), filename, "exec")
PY

backup="$data_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 "$backup"
cp -p "$app_dir/service.py" "$backup/service.py"
if [ -f "$app_dir/material_search.py" ]; then cp -p "$app_dir/material_search.py" "$backup/material_search.py"; fi
for file in local_acquisition.py acquisition_sync.py precise-public-sources.json; do
  if [ -f "$app_dir/$file" ]; then cp -p "$app_dir/$file" "$backup/$file"; fi
done
override_dir=/etc/systemd/system/ai-provider-gateway.service.d
override_file="$override_dir/20-operation-receipts.conf"
if [ -e "$override_file" ]; then
  cp -p "$override_file" "$backup/20-operation-receipts.conf"
fi

rollback() {
  echo "Provider gateway update failed; restoring previous code; keeping live receipts and diagnostic backup: $backup" >&2
  systemctl stop ai-provider-gateway || { echo 'Cannot stop service; preserving live data and backup for recovery.' >&2; return 1; }
  install -m 644 "$backup/service.py" "$app_dir/service.py"
  if [ -f "$backup/material_search.py" ]; then install -m 644 "$backup/material_search.py" "$app_dir/material_search.py"; else rm -f "$app_dir/material_search.py"; fi
  for file in local_acquisition.py acquisition_sync.py precise-public-sources.json; do
    if [ -f "$backup/$file" ]; then install -m 644 "$backup/$file" "$app_dir/$file"; else rm -f "$app_dir/$file"; fi
  done
  # Preserve post-start receipts and fee reservations, including unknown outcomes.
  # This deployment has no destructive migrations; backups are diagnostic only.
  if [ -e "$backup/20-operation-receipts.conf" ]; then
    install -m 644 "$backup/20-operation-receipts.conf" "$override_file"
  else
    rm -f "$override_file"
  fi
  systemctl daemon-reload
  systemctl restart ai-provider-gateway || true
}

systemctl stop ai-provider-gateway
restart_on_backup_failure() { systemctl start ai-provider-gateway || true; }
trap restart_on_backup_failure EXIT
for file in operation-receipts.sqlite3 operation-receipts.sqlite3.materials operation-receipts.sqlite3.acquisition-sync; do
  if [ -f "$data_dir/$file" ]; then
    python3 - "$data_dir/$file" "$backup/$file" <<'PY'
import os, sqlite3, sys
source = sqlite3.connect(sys.argv[1])
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
    assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
finally:
    destination.close()
    source.close()
metadata = os.stat(sys.argv[1])
os.chown(sys.argv[2], metadata.st_uid, metadata.st_gid)
os.chmod(sys.argv[2], 0o600)
PY
  fi
done
trap rollback EXIT
install -m 644 "$source_dir/service.py" "$source_dir/material_search.py" "$app_dir/"
install -d -m 755 "$override_dir"
printf '%s\n' '[Service]' 'ReadWritePaths=/var/lib/ai-provider-gateway' > "$override_file"
chmod 644 "$override_file"
systemctl daemon-reload
systemctl start ai-provider-gateway
python3 - <<'PY'
import json
import time
import urllib.request
for attempt in range(20):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8444/v1/provider-gateway/health", timeout=3) as response:
            payload = json.load(response)
            assert payload.get("ok") is True
            assert payload.get("runtime_revision") not in {None, "", "unversioned"}
            assert 30 <= int(payload.get("upstream_timeout_seconds", 0)) <= 180
        break
    except Exception:
        if attempt == 19:
            raise
        time.sleep(1)
PY
systemctl is-active --quiet ai-provider-gateway
trap - EXIT
echo "Provider gateway updated; previous code retained: $backup"
sha256sum "$app_dir/service.py" "$app_dir/material_search.py"
