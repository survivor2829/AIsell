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
for file in service.py feedback.py materials.py tutorials.py tutorials-admin.js admin.html promote.py promote_components.py legacy_releases.py; do
  [ -s "$source_dir/$file" ] || { echo "Missing deployment file: $file" >&2; exit 1; }
done
python3 - "$source_dir" <<'PY'
from pathlib import Path
import sys
for name in ('service.py', 'feedback.py', 'materials.py', 'tutorials.py', 'promote.py', 'promote_components.py', 'legacy_releases.py'):
    file = Path(sys.argv[1]) / name
    compile(file.read_text(), str(file), 'exec')
PY

backup="$data_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 "$backup" "$backup/code"
for file in service.py feedback.py materials.py tutorials.py tutorials-admin.js admin.html promote.py promote_components.py legacy_releases.py; do
  if [ -f "$app_dir/$file" ]; then cp -p "$app_dir/$file" "$backup/code/$file"; fi
done
systemctl stop ai-maintenance
restart_on_backup_failure() { systemctl start ai-maintenance || true; }
trap restart_on_backup_failure EXIT
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
if [ -d "$data_dir/official-materials" ]; then
  cp -a "$data_dir/official-materials" "$backup/official-materials"
  python3 - "$backup/official-materials/catalog.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
fi

if [ -f "$data_dir/tutorials/catalog.sqlite3" ]; then
  python3 - "$data_dir/tutorials/catalog.sqlite3" "$backup/tutorials.sqlite3" <<'PY'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as destination:
    source.backup(destination)
    assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
  chmod 600 "$backup/tutorials.sqlite3"
  # Recordings are immutable, content-addressed and untouched by deployment.
fi

rollback() {
  echo "Deployment failed; restoring previous code; keeping live data and diagnostic backup: $backup" >&2
  systemctl stop ai-maintenance || { echo 'Cannot stop service; preserving live data and backup for recovery.' >&2; return 1; }
  for file in service.py feedback.py materials.py tutorials.py tutorials-admin.js admin.html promote.py promote_components.py legacy_releases.py; do
    if [ -f "$backup/code/$file" ]; then install -m 644 "$backup/code/$file" "$app_dir/$file"; else rm -f "$app_dir/$file"; fi
  done
  # No destructive migrations: new code may have accepted writes before health failed.
  # Never replace live reports/catalog/files with the pre-start snapshot.
  systemctl restart ai-maintenance || true
}
trap rollback EXIT
for file in service.py feedback.py materials.py tutorials.py tutorials-admin.js admin.html promote.py promote_components.py legacy_releases.py; do
  install -m 644 "$source_dir/$file" "$app_dir/$file"
done
# Account administration: the token file is created by the provider gateway upgrade.
if [ -s /etc/ai-maintenance/accounts-admin.env ]; then
  install -d -m 755 /etc/systemd/system/ai-maintenance.service.d
  printf '%s\n' '[Service]' 'EnvironmentFile=/etc/ai-maintenance/accounts-admin.env' > /etc/systemd/system/ai-maintenance.service.d/30-accounts-admin.conf
  chmod 644 /etc/systemd/system/ai-maintenance.service.d/30-accounts-admin.conf
  systemctl daemon-reload
fi
systemctl start ai-maintenance
python3 - <<'PY'
import json, time, urllib.request
for attempt in range(20):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8081/api/overview', timeout=3) as response:
            assert isinstance(json.load(response), dict)
        with urllib.request.urlopen('http://127.0.0.1:8081/api/tutorials', timeout=3) as response:
            assert json.load(response)['schema'] == 1
        break
    except Exception:
        if attempt == 19:
            raise
        time.sleep(1)
PY
systemctl is-active --quiet ai-maintenance
trap - EXIT
echo "Maintenance service updated; database and previous code retained: $backup"
sha256sum "$app_dir/service.py" "$app_dir/feedback.py" "$app_dir/materials.py" "$app_dir/tutorials.py" "$app_dir/tutorials-admin.js" "$app_dir/admin.html" "$app_dir/promote.py"
