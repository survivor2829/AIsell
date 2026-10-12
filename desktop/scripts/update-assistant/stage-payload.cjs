'use strict';
// OFFLINE ENGINEERING PREPARATION ONLY. Not called by the launcher or customers.
// Writes review resources, never compiles, signs, launches or publishes an EXE.
// Usage: node stage-payload.cjs <verified-probe-result.json> [inspect|update]
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { builtinModules } = require('node:module');
const desktop = path.resolve(__dirname, '../..');
const JSZip = require(path.join(desktop, 'node_modules/jszip'));
const { child, plain } = require('./coordinator.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const EXE = 'AI获客 V1.0版本-测试版.exe';
async function main(receiptFile, mode = 'inspect') {
  if (!['inspect', 'update'].includes(mode)) throw Error('mode_invalid');
  const receipt = json(plain(path.resolve(receiptFile)));
  if (receipt.ok !== true || !Array.isArray(receipt.results) || receipt.results.length < 1 ||
      receipt.results.some(row => row.ok !== true || !row.revoked || row.installerStarted !== false || !row.originalSourceUnchanged || row.electron !== '32.3.3')) throw Error('probe_not_accepted');
  const files = new Map();
  const modules = new Set(), dependencies = new Map(), builtins = new Set([...builtinModules, 'electron', 'original-fs']);
  const lock = json(path.join(desktop, 'package-lock.json'));
  const relativePath = absolute => {
    const relative = path.relative(desktop, plain(absolute)).replaceAll('\\', '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw Error('source_path_invalid');
    return relative;
  };
  function addFile(absolute) {
    const relative = relativePath(absolute);
    if (/\.(pem|key|pfx|p12|log|db|sqlite)$/i.test(relative) || /(^|\/)\.env/.test(relative) || !fs.lstatSync(absolute).isFile()) throw Error('private_file_excluded');
    files.set('helper-app/' + relative, fs.readFileSync(absolute));
  }
  async function copyPackage(name, base) {
    const source = plain(path.dirname(require.resolve(name + '/package.json', { paths: [base] })));
    const relative = relativePath(source);
    if (!relative.startsWith('node_modules/')) throw Error('dependency_path_invalid');
    if (dependencies.has(relative)) return;
    const pkg = json(path.join(source, 'package.json')), locked = lock.packages?.[relative];
    if (!locked || locked.version !== pkg.version || !locked.integrity) throw Error('dependency_lock_invalid');
    dependencies.set(relative, { path: relative, name: pkg.name, version: pkg.version, integrity: locked.integrity });
    function walk(directory) {
      for (const entry of fs.readdirSync(plain(directory), { withFileTypes: true })) {
        const absolute = plain(path.join(directory, entry.name));
        if (entry.name === 'node_modules' && entry.isDirectory()) continue;
        if (entry.isDirectory()) walk(absolute); else addFile(absolute);
      }
    }
    walk(source);
    for (const dependency of Object.keys(pkg.dependencies || {})) await copyPackage(dependency, source);
  }
  async function copyModule(absolute) {
    const relative = relativePath(absolute);
    if (!relative.startsWith('src/') && relative !== 'product-brand.json') throw Error('source_path_invalid');
    if (modules.has(relative)) return; modules.add(relative); addFile(absolute);
    if (!/\.(cjs|js)$/.test(absolute)) return;
    for (const match of fs.readFileSync(absolute, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)) {
      const ref = match[1];
      if (ref.startsWith('.')) await copyModule(require.resolve(path.resolve(path.dirname(absolute), ref)));
      else if (!ref.startsWith('node:') && !builtins.has(ref)) await copyPackage(ref, path.dirname(absolute));
    }
  }
  // Capability receipts prove the old runtime contract, not frozen application
  // dependencies. Always collect the complete CURRENT reviewed source closure.
  for (const relative of ['src/main/update-helper.cjs', 'src/main/cloud-config.cjs', 'src/main/cloud-transport.cjs']) await copyModule(child(desktop, relative));
  const profiles = json(path.join(desktop, 'src/main/cloud-release-config.json'));
  const config = profiles.test;
  if (config?.enabled !== true || config.appId !== 'com.aihuoke.desktop.test' || !config.origin?.startsWith('https://') || !config.signingPublicKey) throw Error('official_test_config_missing');
  // Include each declared public CA, because cloud-config selects a fixed profile.
  for (const profile of Object.values(profiles)) if (profile.caFile) {
    if (path.basename(profile.caFile) !== profile.caFile) throw Error('ca_path_invalid');
    const relative = 'src/main/' + profile.caFile;
    files.set('helper-app/' + relative, fs.readFileSync(child(desktop, relative)));
  }
  files.set('coordinator.cjs', fs.readFileSync(path.join(__dirname, 'coordinator.cjs')));
  files.set('job-admission.cjs', fs.readFileSync(path.join(__dirname, 'job-admission.cjs')));
  files.set('helper-app/bootstrap.cjs', fs.readFileSync(path.join(__dirname, 'helper-entry.cjs')));
  files.set('helper-app/package.json', Buffer.from(JSON.stringify({ name: 'xiaoxi-official-update-helper', version: '0.0.0', main: 'bootstrap.cjs' })));
  const runtimeCatalog = { schema: 1, profiles: [] };
  for (const result of receipt.results) {
    const source = plain(result.source), baseFile = child(source, 'component-base.json');
    const baseline = json(baseFile);
    if (baseline.schema !== 2 || !Array.isArray(baseline.files)) throw Error('baseline_invalid');
    const runtimeFiles = [];
    for (const file of baseline.files) {
      const relative = file.path;
      if (!(relative === EXE || relative === 'crashpad_handler.exe' || /^[^/]+\.(dll|pak|bin|dat)$/i.test(relative) || /^locales\/[^/]+\.pak$/i.test(relative))) continue;
      const absolute = child(source, relative), size = fs.statSync(absolute).size;
      const digest = hash(fs.readFileSync(absolute));
      if (size !== file.size || digest !== file.sha256) throw Error('runtime_source_changed');
      runtimeFiles.push({ path: relative, size, sha256: digest });
    }
    if (runtimeFiles.find(file => file.path === EXE)?.sha256 !== result.oldExeSha256) throw Error('runtime_source_changed');
    runtimeFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const id = 'electron-' + result.electron + '-' + hash(JSON.stringify(runtimeFiles)).slice(0, 16);
    if (!runtimeCatalog.profiles.some(profile => profile.id === id)) runtimeCatalog.profiles.push({ id, electron: result.electron, files: runtimeFiles });
  }
  // Mode is embedded and pinned in the resulting EXE, not a runtime override.
  // There is no --force/--unsafe/--skip-signature switch.
  const descriptor = { schema: 1, appId: 'com.aihuoke.desktop.test', channel: 'test', mode, entry: 'coordinator.cjs', files: [] };
  const zip = new JSZip();
  for (const [relative, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (bytes.includes(Buffer.from('PRIVATE KEY-----'))) throw Error('private_key_excluded');
    descriptor.files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
    zip.file(relative, bytes, { date: new Date('2000-01-01T00:00:00Z'), createFolders: false, unixPermissions: 0o100644 });
  }
  const payload = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' });
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor)), runtimeBytes = Buffer.from(JSON.stringify(runtimeCatalog));
  const outputRoot = child(desktop, '.build/update-assistant');
  await fsp.mkdir(outputRoot, { recursive: true });
  const destination = child(outputRoot, 'resources-' + crypto.randomUUID()); await fsp.mkdir(destination);
  for (const [name, bytes] of [['payload.zip', payload], ['payload-manifest.json', descriptorBytes], ['runtime-catalog.json', runtimeBytes]]) await fsp.writeFile(child(destination, name), bytes, { flag: 'wx' });
  const report = { schema: 1, mode, payloadBytes: payload.length, files: descriptor.files.length,
    descriptorSha256: hash(descriptorBytes), payloadSha256: hash(payload), runtimeCatalogSha256: hash(runtimeBytes), runtimeIds: runtimeCatalog.profiles.map(row => row.id),
    sourceClosureSha256: hash(JSON.stringify(descriptor.files.filter(file => file.path.startsWith('helper-app/src/')))),
    sourceFiles: [...modules].sort(), dependencies: [...dependencies.values()].sort((a, b) => a.path.localeCompare(b.path)),
    capabilityReceiptSha256: hash(fs.readFileSync(receiptFile)),
    executableBuilt: false, signed: false, installed: false };
  await fsp.writeFile(child(destination, 'review-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ directory: destination, ...report }));
}
if (require.main === module) main(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
