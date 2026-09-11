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

python3 - "$source_dir/service.py" <<'PY'
from pathlib import Path
import sys
compile(Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")
PY

backup="$data_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 "$backup"
cp -p "$app_dir/service.py" "$backup/service.py"

rollback() {
  echo 'Provider gateway update failed; restoring previous code.' >&2
  install -m 644 "$backup/service.py" "$app_dir/service.py"
  systemctl restart ai-provider-gateway || true
}

systemctl stop ai-provider-gateway
trap rollback EXIT
install -m 644 "$source_dir/service.py" "$app_dir/service.py"
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
        break
    except Exception:
        if attempt == 19:
            raise
        time.sleep(1)
PY
systemctl is-active --quiet ai-provider-gateway
trap - EXIT
echo "Provider gateway updated; previous code retained: $backup"
sha256sum "$app_dir/service.py"
