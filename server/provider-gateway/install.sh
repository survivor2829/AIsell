#!/bin/sh
set -eu

[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=/opt/ai-provider-gateway
data_dir=/var/lib/ai-provider-gateway
config_file=/etc/ai-maintenance/provider-gateway.env

id ai-gateway >/dev/null 2>&1 || useradd --system --home "$data_dir" --shell /usr/sbin/nologin ai-gateway
install -d -m 755 "$app_dir"
install -d -o ai-gateway -g ai-gateway -m 750 "$data_dir"
# Both service accounts need to traverse this shared directory, while the
# certificate/key and provider env files remain protected by their file modes
# and service-specific groups.
install -d -m 751 -o root -g ai-gateway /etc/ai-maintenance
install -m 644 "$source_dir/service.py" "$app_dir/service.py"

if [ ! -f "$config_file" ]; then
  umask 077
  session_secret=$(openssl rand -hex 32)
  {
    printf '%s\n' "XIAOXI_GATEWAY_SESSION_SECRET=$session_secret"
    printf '%s\n' 'XIAOXI_GATEWAY_SESSION_TTL_SECONDS=86400'
    printf '%s\n' 'XIAOXI_GATEWAY_UPSTREAM_TIMEOUT_SECONDS=180'
    printf '%s\n' '# XIAOXI_GATEWAY_RUNTIME_REVISION=release-commit-or-build-id'
    printf '%s\n' '# Add provider credentials here; never put them in the desktop package.'
    printf '%s\n' '# XIAOXI_GATEWAY_DEEPSEEK_API_KEY='
    printf '%s\n' '# XIAOXI_GATEWAY_BAILIAN_API_KEY='
    printf '%s\n' '# XIAOXI_GATEWAY_VOLCENGINE_API_KEY='
    printf '%s\n' '# XIAOXI_GATEWAY_VOLCENGINE_ARK_API_KEY='
    printf '%s\n' '# XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY='
    printf '%s\n' '# ASR requires its own API key, or the legacy APP ID + Access Token pair.'
    printf '%s\n' '# XIAOXI_GATEWAY_VOLCENGINE_ASR_API_KEY='
    printf '%s\n' '# XIAOXI_GATEWAY_VOLCENGINE_ASR_APP_ID='
    printf '%s\n' '# XIAOXI_GATEWAY_VOLCENGINE_ASR_ACCESS_TOKEN='
    printf '%s\n' '# XIAOXI_GATEWAY_APIMART_API_KEY='
  } > "$config_file"
fi
chown root:ai-gateway "$config_file"
chmod 640 "$config_file"

cat > /etc/systemd/system/ai-provider-gateway.service <<'UNIT'
[Unit]
Description=AIhuoke authenticated provider gateway
After=network.target

[Service]
User=ai-gateway
Group=ai-gateway
EnvironmentFile=/etc/ai-maintenance/provider-gateway.env
ExecStart=/usr/bin/python3 /opt/ai-provider-gateway/service.py --host 127.0.0.1 --port 8444
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=512M
TasksMax=64

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ai-provider-gateway
systemctl restart ai-provider-gateway
systemctl is-active --quiet ai-provider-gateway
echo 'Provider gateway installed; credentials remain in the root-owned environment file.'
