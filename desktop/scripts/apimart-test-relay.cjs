const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cloudConfig } = require('../src/main/cloud-config.cjs');

const READY = 'XIAOXI_APIMART_RELAY_READY';
const REMOTE_PORT = 47891;

function relaySettings(environment = process.env) {
  const configured = String(environment.XIAOXI_APIMART_LOCAL_PROXY || environment.HTTPS_PROXY
    || environment.https_proxy || environment.ALL_PROXY || environment.all_proxy || 'http://127.0.0.1:7890');
  let proxy;
  try { proxy = new URL(configured); } catch { return null; }
  if (proxy.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(proxy.hostname)
    || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash
    || !Number.isInteger(Number(proxy.port)) || Number(proxy.port) < 1) return null;
  const config = cloudConfig({ developmentEdition: true });
  const host = new URL(config.origin).hostname;
  const user = String(environment.XIAOXI_APIMART_RELAY_SSH_USER || 'ubuntu');
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(user)) return null;
  const key = String(environment.XIAOXI_APIMART_RELAY_SSH_KEY
    || path.join(os.homedir(), '.ssh', 'ai-release-server_ed25519'));
  if (!fs.existsSync(key)) return null;
  const ssh = path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  if (!fs.existsSync(ssh)) return null;
  return { ssh, key, destination: `${user}@${host}`, proxyHost: proxy.hostname, proxyPort: proxy.port };
}

function startApimartTestRelay({ environment = process.env, report = console.error } = {}) {
  const settings = relaySettings(environment);
  if (!settings) {
    report('APIMart 测试通道未启动：本机代理或 SSH 运维配置不可用。');
    return { stop() {} };
  }
  let stopped = false;
  let child = null;
  let retry = null;
  let notifiedFailure = false;

  function launch() {
    if (stopped) return;
    const forward = `127.0.0.1:${REMOTE_PORT}:${settings.proxyHost}:${settings.proxyPort}`;
    const args = [
      '-T', '-R', forward, '-i', settings.key,
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      settings.destination, `printf ${READY}; exec sleep 86400`,
    ];
    try { child = spawn(settings.ssh, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch {
      if (!notifiedFailure) report('APIMart 测试通道暂不可用，正在重连。');
      notifiedFailure = true;
      retry = setTimeout(launch, 5000);
      return;
    }
    let ready = false;
    let output = '';
    const startupTimeout = setTimeout(() => { if (!ready) child?.kill(); }, 15000);
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-128);
      if (!ready && output.includes(READY)) {
        ready = true;
        clearTimeout(startupTimeout);
        notifiedFailure = false;
        report('APIMart 测试通道已连接。');
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(startupTimeout);
      child = null;
      if (stopped) return;
      if (!notifiedFailure) report('APIMart 测试通道暂不可用，正在重连。');
      notifiedFailure = true;
      retry = setTimeout(launch, 5000);
    });
  }
  launch();
  return { stop() {
    stopped = true;
    if (retry) clearTimeout(retry);
    child?.kill();
  } };
}

module.exports = { relaySettings, startApimartTestRelay };
