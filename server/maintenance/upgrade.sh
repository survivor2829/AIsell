#!/bin/sh
set -eu

# Update an existing instance without replacing its TLS identity or release files.
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=/opt/ai-maintenance
data_dir=/var/lib/ai-maintenance
[ -f "$app_dir/service.py" ] && [ -f "$data_dir/reports.sqlite3" ] || {
  echo 'Existing maintenance installation is required; use install.sh for first installation.' >&2
  exit 1
}
for file in service.py feedback.py admin.html promote.py; do
  [ -s "$source_dir/$file" ] || { echo "Missing deployment file: $file" >&2; exit 1; }
done
python3 - "$source_dir" <<'PY'
from pathlib import Path
import sys
for name in ('service.py', 'feedback.py', 'promote.py'):
    file = Path(sys.argv[1]) / name
    compile(file.read_text(), str(file), 'exec')
PY

backup="$data_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 "$backup" "$backup/code"
for file in service.py feedback.py admin.html promote.py; do
  if [ -f "$app_dir/$file" ]; then cp -p "$app_dir/$file" "$backup/code/$file"; fi
done
python3 - "$data_dir/reports.sqlite3" "$backup/reports.sqlite3" <<'PY'
import sqlite3, sys
source = sqlite3.connect(sys.argv[1])
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
    assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
finally:
    destination.close()
    source.close()
PY
chmod 600 "$backup/reports.sqlite3"

rollback() {
  echo "Deployment failed; restoring previous code. Database backup: $backup" >&2
  for file in service.py feedback.py admin.html promote.py; do
    if [ -f "$backup/code/$file" ]; then install -m 644 "$backup/code/$file" "$app_dir/$file"; fi
  done
  systemctl restart ai-maintenance || true
}
systemctl stop ai-maintenance
trap rollback EXIT
for file in service.py feedback.py admin.html promote.py; do
  install -m 644 "$source_dir/$file" "$app_dir/$file"
done
systemctl start ai-maintenance
python3 - <<'PY'
import json, time, urllib.request
for attempt in range(20):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8081/api/overview', timeout=3) as response:
            assert isinstance(json.load(response), dict)
        break
    except Exception:
        if attempt == 19:
            raise
        time.sleep(1)
PY
systemctl is-active --quiet ai-maintenance
trap - EXIT
echo "Maintenance service updated; database and previous code retained: $backup"
sha256sum "$app_dir/service.py" "$app_dir/feedback.py" "$app_dir/admin.html" "$app_dir/promote.py"
