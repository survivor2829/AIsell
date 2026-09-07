#!/bin/sh
set -eu
# Run as root after copying this directory to the server. Existing data stays put.
server_ip="${1:?server IP is required}"
case "$server_ip" in *[!0-9.]*|'') exit 2;; esac
id ai-maintenance >/dev/null 2>&1 || useradd --system --home /var/lib/ai-maintenance --shell /usr/sbin/nologin ai-maintenance
install -d -m 755 /opt/ai-maintenance
install -m 644 "$(dirname "$0")/service.py" "$(dirname "$0")/admin.html" "$(dirname "$0")/promote.py" /opt/ai-maintenance/
install -d -o ai-maintenance -g ai-maintenance -m 750 /var/lib/ai-maintenance
install -d -m 750 -o root -g ai-maintenance /etc/ai-maintenance
if [ ! -f /etc/ai-maintenance/server.key ]; then
  umask 077
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
    -keyout /etc/ai-maintenance/server.key -out /etc/ai-maintenance/server.crt \
    -subj "/CN=$server_ip" -addext "subjectAltName=IP:$server_ip" \
    -addext 'basicConstraints=critical,CA:TRUE'
fi
chown root:ai-maintenance /etc/ai-maintenance/server.key /etc/ai-maintenance/server.crt
chmod 640 /etc/ai-maintenance/server.key /etc/ai-maintenance/server.crt
cat > /etc/systemd/system/ai-maintenance.service <<'UNIT'
[Unit]
Description=AIhuoke update and diagnostics test service
After=network.target
[Service]
User=ai-maintenance
Group=ai-maintenance
ExecStart=/usr/bin/python3 /opt/ai-maintenance/service.py --port 443 --cert /etc/ai-maintenance/server.crt --key /etc/ai-maintenance/server.key
Restart=on-failure
RestartSec=3
UMask=0027
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/ai-maintenance
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
MemoryMax=384M
TasksMax=64
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ai-maintenance
systemctl restart ai-maintenance
systemctl is-active ai-maintenance
