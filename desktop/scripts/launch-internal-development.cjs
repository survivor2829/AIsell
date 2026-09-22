const { spawn } = require('node:child_process');
const path = require('node:path');
const { startApimartTestRelay } = require('./apimart-test-relay.cjs');

const relay = startApimartTestRelay();
const childEnvironment = { ...process.env };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const electron = spawn(path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], {
  cwd: path.join(__dirname, '..'),
  env: childEnvironment,
  stdio: 'inherit',
});
electron.on('error', (error) => {
  console.error(`Electron 启动失败：${error.message}`);
  relay.stop();
  process.exitCode = 1;
});
electron.on('exit', (code) => {
  relay.stop();
  process.exitCode = code || 0;
});
process.on('SIGINT', () => { electron.kill(); relay.stop(); });
process.on('SIGTERM', () => { electron.kill(); relay.stop(); });
