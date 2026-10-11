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
override_dir=/etc/systemd/system/ai-provider-gateway.service.d
override_file="$override_dir/20-operation-receipts.conf"
if [ -e "$override_file" ]; then
  cp -p "$override_file" "$backup/20-operation-receipts.conf"
fi

rollback() {
  echo 'Provider gateway update failed; restoring previous code.' >&2
  install -m 644 "$backup/service.py" "$app_dir/service.py"
  if [ -f "$backup/material_search.py" ]; then install -m 644 "$backup/material_search.py" "$app_dir/material_search.py"; fi
  if [ -e "$backup/20-operation-receipts.conf" ]; then
    install -m 644 "$backup/20-operation-receipts.conf" "$override_file"
  else
    rm -f "$override_file"
  fi
  systemctl daemon-reload
  systemctl restart ai-provider-gateway || true
}

systemctl stop ai-provider-gateway
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
