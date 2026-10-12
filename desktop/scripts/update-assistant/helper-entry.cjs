'use strict';
// Place at helper-app/bootstrap.cjs; helper-app/package.json.main points here.
// This does not load any original business bootstrap/main module.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const index = process.argv.indexOf('--xiaoxi-update-job');
const profile = path.join(process.env.APPDATA, 'xiaoxi-active-touch-test');
const jobs = path.join(profile, 'data/cloud-maintenance/components/jobs');
const file = index < 0 ? '' : path.resolve(process.argv[index + 1] || '');
if (!/^[a-f0-9-]{36}\.json$/.test(path.basename(file)) || path.dirname(file).toLowerCase() !== path.resolve(jobs).toLowerCase()) app.exit(2);
else {
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  const installed = path.join(process.env.LOCALAPPDATA, 'Programs/AI获客-测试版');
  if (job.channel !== 'test' || path.resolve(job.installedRoot).toLowerCase() !== path.resolve(installed).toLowerCase() ||
      path.resolve(job.executable).toLowerCase() !== path.join(installed, 'AI获客 V1.0版本-测试版.exe').toLowerCase()) app.exit(2);
  else require('./src/main/update-helper.cjs').runHelper({ jobFile: file, userData: profile }).catch(() => app.exit(1));
}
