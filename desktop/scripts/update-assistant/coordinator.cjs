'use strict';
// Mode is fixed by the hash-pinned embedded manifest: inspect never installs.
// No command-line/environment override or arbitrary installation-root argument.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const run = promisify(execFile);
const EXE = 'AI获客 V1.0版本-测试版.exe';
const APP_ID = 'com.aihuoke.desktop.test';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root, file) => file && (same(root, file) || path.resolve(file).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
const identity = row => `${row.pid}@${row.created}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function plain(file) {
  const full = path.resolve(file);
  if (full.startsWith('\\\\')) throw Error('path_invalid');
  for (let current = full; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw Error('path_invalid');
    if (path.dirname(current) === current) break;
  }
  return full;
}
function child(root, relative) {
  if (typeof relative !== 'string' || /[\\\x00-\x1f<>:"|?*]/.test(relative) || relative.startsWith('/') ||
      relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('path_invalid');
  const full = plain(path.join(root, relative));
  if (!inside(root, full) || same(root, full)) throw Error('path_invalid');
  return full;
}
async function hashFile(file) {
  plain(file); const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function checkFiles(root, files) {
  if (!Array.isArray(files) || !files.length || files.length > 4096) throw Error('trust_invalid');
  const seen = new Set();
  for (const item of files) {
    const file = child(root, item.path), key = item.path.toLowerCase();
    if (seen.has(key) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw Error('trust_invalid');
    seen.add(key);
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size !== item.size || await hashFile(file) !== item.sha256) throw Error('file_changed');
  }
}
function safeCode(error) {
  const value = String(error?.code || error?.message || 'update_failed');
  return /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(value) ? value : 'update_failed';
}
let lastPhase = 'initialize';
function send(phase, percent = 0, code) { lastPhase = phase; process.stdout.write(JSON.stringify({ phase, percent, ...(code ? { code: safeCode({ code }) } : {}) }) + '\n'); }
function installationMetadata(installed, contract, componentContract) {
  const baseline = read(child(installed, 'component-base.json'));
  const pkg = read(child(installed, 'resources/app/package.json'));
  const edition = read(child(installed, 'resources/app/dist/build-edition.json'));
  // Older packages embed their channel configuration in cloud-config.cjs.
  // Never execute that business code; use this assistant's pinned configuration.
  const releaseFile = child(installed, 'resources/app/src/main/cloud-release-config.json');
  const release = fs.existsSync(releaseFile) ? read(releaseFile) : null;
  if (pkg.name !== 'xiaoxi-active-touch-desktop' || pkg.main !== 'src/main/bootstrap.cjs' || !contract.VERSION.test(pkg.version) ||
      (release && release.test?.appId !== APP_ID) || edition.edition !== 'development' || edition.artifactType !== 'internal-evaluation' ||
      baseline.schema !== 2 || !contract.VERSION.test(baseline.base?.version) || !componentContract.HEX.test(baseline.base?.fingerprint) ||
      !Number.isSafeInteger(baseline.dataSchema) || baseline.dataSchema < 1 || !Array.isArray(baseline.files)) throw Error('installation_unrecognized');
  componentContract.validateFiles(baseline.files);
  if (baseline.files.some(file => !['base', ...componentContract.COMPONENTS].includes(file.component)) ||
      componentContract.treeHash(baseline.files.filter(file => file.component === 'base')) !== baseline.base.fingerprint) throw Error('installation_unrecognized');
  return { baseline, version: pkg.version };
}
async function processRows() {
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,Name | ConvertTo-Json -Compress';
  const result = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 8 * 1024 ** 2, timeout: 15000 });
  const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  return (Array.isArray(value) ? value : [value]).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, created: row.CreationDate, executable: row.ExecutablePath, name: row.Name }));
}
async function acquireLease(installed, profile) {
  const key = sha(path.resolve(installed).toLowerCase() + '\n' + path.resolve(profile).toLowerCase());
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(Error('already_running')));
    server.listen({ path: '\\\\.\\pipe\\xiaoxi-official-update-' + key, exclusive: true }, resolve);
  });
  return server;
}
async function main(contextFile) {
  if (process.platform !== 'win32' || process.versions.electron !== '32.3.3' || process.env.ELECTRON_RUN_AS_NODE !== '1') throw Error('runtime_unrecognized');
  const root = plain(__dirname), parent = plain(path.join(process.env.LOCALAPPDATA, 'AI获客更新助手'));
  if (!same(path.dirname(root), parent) || !/^[a-f0-9-]{36}$/.test(path.basename(root)) || !same(contextFile, child(root, 'launch-context.json'))) throw Error('path_invalid');
  const context = read(contextFile);
  if (context.schema !== 1 || context.session !== path.basename(root) || !Number.isInteger(context.launcherPid) || context.launcherPid <= 0) throw Error('trust_invalid');
  const descriptorBytes = fs.readFileSync(child(root, 'verified-descriptor.json'));
  const catalogBytes = fs.readFileSync(child(root, 'verified-runtime-catalog.json'));
  if (sha(descriptorBytes) !== context.descriptorSha256 || sha(catalogBytes) !== context.runtimeCatalogSha256) throw Error('trust_invalid');
  const descriptor = JSON.parse(descriptorBytes), catalog = JSON.parse(catalogBytes);
  if (descriptor.schema !== 1 || descriptor.appId !== APP_ID || descriptor.channel !== 'test' || !['inspect', 'update'].includes(descriptor.mode) || descriptor.entry !== 'coordinator.cjs') throw Error('trust_invalid');
  await checkFiles(root, descriptor.files);
  const installed = plain(path.join(process.env.LOCALAPPDATA, 'Programs/AI获客-测试版'));
  const profile = plain(path.join(process.env.APPDATA, 'xiaoxi-active-touch-test'));
  if (!same(process.execPath, child(installed, EXE)) || !fs.statSync(profile).isDirectory()) throw Error('installation_unrecognized');
  const runtime = catalog.profiles?.find(item => item.id === context.runtimeId);
  if (!runtime || catalog.schema !== 1 || runtime.electron !== '32.3.3') throw Error('runtime_unrecognized');
  await checkFiles(installed, runtime.files);
  const payload = child(root, 'helper-app');
  // Only the C#-verified official payload is executable. Fixture config is refused.
  const config = require(child(payload, 'src/main/cloud-config.cjs')).cloudConfig({ channel: 'test' });
  if (!config.enabled || config.appId !== APP_ID || config.channel !== 'test' || !config.origin?.startsWith('https://')) throw Error('trust_invalid');
  const helper = require(child(payload, 'src/main/update-helper.cjs'));
  const contract = require(child(payload, 'src/shared/cloud-contract.cjs'));
  const componentContract = require(child(payload, 'src/shared/component-contract.cjs'));
  const components = require(child(payload, 'src/main/component-paths.cjs'));
  const transport = require(child(payload, 'src/main/cloud-transport.cjs')).createTransport(config);
  const paths = components.updatePaths(profile);
  plain(paths.directory);
  const metadata = installationMetadata(installed, contract, componentContract), baseline = metadata.baseline;
  const lease = await acquireLease(installed, profile);
  let cancelled = false, committed = false, reserved = false, created, helperProcess, reservation;
  const input = createInterface({ input: process.stdin });
  let cancelFailure;
  const cancel = () => { if (committed) return; cancelled = true; transport.close(); if (created) try { helper.revokeUpdateJob(created.file); } catch (error) { cancelFailure = error; } };
  input.on('line', line => { if (line === '{"command":"cancel"}') cancel(); });
  input.on('close', cancel);
  const checkCancelled = () => { if (cancelled) throw Error('cancelled'); };
  const activeFile = child(paths.directory, 'active-job.json');
  let tracked = [];
  const scopes = [installed, child(paths.directory, 'generations'), child(paths.directory, 'helper-runtime')];
  const names = new Set([EXE.toLowerCase(), 'ai-update-helper.exe', ...(baseline.files || []).filter(file => /\.exe$/i.test(file.path)).map(file => path.basename(file.path).toLowerCase())]);
  async function waitForBusinessExit() {
    while (true) {
      checkCancelled();
      const rows = await processRows(), self = rows.find(row => row.pid === process.pid);
      if (!self?.created || !same(self.executable, process.execPath)) throw Error('process_identity_unknown');
      const owned = new Set(helper.descendants(rows, process.pid).map(identity));
      if (rows.some(row => !owned.has(identity(row)) && !row.executable && names.has(String(row.name).toLowerCase()))) throw Error('process_identity_unknown');
      const roots = rows.filter(row => !owned.has(identity(row)) && scopes.some(scope => inside(scope, row.executable)));
      for (const candidate of roots) tracked = helper.descendants(rows, candidate.pid, tracked);
      tracked = [...new Map(tracked.map(row => [identity(row), row])).values()];
      const alive = tracked.filter(row => !owned.has(identity(row)) && rows.some(current => identity(current) === identity(row)));
      if (!alive.length) return;
      send('waiting'); await pause(1000);
    }
  }
  async function selectedVersion(id) {
    if (!id) return metadata.version;
    const generation = components.generationPath(paths, id, installed); plain(generation);
    return (await components.verifySelected(generation, installed, config)).version;
  }
  function requireNoCompetingUpdate() {
    if (fs.existsSync(activeFile) && !(reserved && read(activeFile).id === reservation.id && read(activeFile).pid === process.pid)) throw Error('existing_update');
    const selected = fs.existsSync(paths.selection) ? read(paths.selection) : {};
    if (selected.pending) throw Error('existing_update');
    return selected;
  }
  try {
    send('detecting');
    // Download can run while business finishes. Retire failed authority only
    // after normal process exit, immediately before exclusive installation.
    const selected = fs.existsSync(paths.selection) ? read(plain(paths.selection)) : {};
    const activeVersion = await selectedVersion(selected.active);
    const version = contract.compareVersions(activeVersion, metadata.version) > 0 ? activeVersion : metadata.version;
    let beforeSelection = JSON.stringify(selected);
    const envelope = await transport.request('/v1/releases/test/latest', { headers: {
      'X-Xiaoxi-Update-Protocol': '3', 'X-Xiaoxi-Version': version,
      'X-Xiaoxi-Base-Version': baseline.base.version, 'X-Xiaoxi-Base-Fingerprint': baseline.base.fingerprint
    } });
    checkCancelled();
    if (envelope.empty === true) { send('current'); return; }
    const manifest = contract.verifyManifest(envelope, config);
    if (contract.compareVersions(manifest.version, version) <= 0) { send('current'); return; }
    const oldStateFile = child(profile, 'data/cloud-maintenance/state.json');
    const oldState = fs.existsSync(oldStateFile) ? read(oldStateFile) : {};
    if (Number.isSafeInteger(oldState.sequence) && manifest.sequence < oldState.sequence) throw Error('release_rollback');
    const downloads = child(parent, 'downloads'); await fsp.mkdir(downloads, { recursive: true }); plain(downloads);
    const final = child(downloads, manifest.sha256 + '.exe'), temporary = child(downloads, manifest.sha256 + '.part');
    const valid = fs.existsSync(final) && fs.statSync(final).size === manifest.size && await hashFile(final) === manifest.sha256;
    if (!valid) {
      if (fs.existsSync(final)) throw Error('cached_file_invalid');
      const storage = require(child(payload, 'src/main/update-storage.cjs'));
      await storage.checkCopySpace([{ path: downloads, bytes: manifest.size * 2 }]);
      send('downloading'); let last = -1;
      await transport.request(manifest.file, { destination: temporary, expected: manifest, maxBytes: manifest.size, resume: true,
        onProgress: bytes => { const percent = Math.floor(bytes / manifest.size * 100); if (percent !== last) { last = percent; send('downloading', percent); } }
      });
      checkCancelled(); plain(temporary);
      if (await hashFile(temporary) !== manifest.sha256) throw Error('download_invalid');
      await fsp.rename(temporary, final);
    }
    await waitForBusinessExit();
    if (JSON.stringify(fs.existsSync(paths.selection) ? read(plain(paths.selection)) : {}) !== beforeSelection) throw Error('installation_changed');
    if (descriptor.mode === 'inspect') { send('review_stop'); return; }
    const reconciled = await require(child(root, 'job-admission.cjs')).reconcile({ paths, installed, executable: process.execPath, selected,
      rows: await processRows(), child, plain, verifyVersion: selectedVersion, saveSelection: components.saveSelection,
      verifyJob: async job => {
        if (!contract.VERSION.test(job.currentVersion) || !contract.VERSION.test(job.targetVersion) || !['full', 'components'].includes(job.prepared?.kind)) throw Error('prior_update_unresolved');
        const manifest = job.prepared.kind === 'full' ? contract.verifyManifest(job.prepared.envelope, config) :
          await components.verifySelected(plain(components.generationPath(paths, path.basename(job.prepared.generationRoot || ''), installed)), installed, config);
        if (manifest.version !== job.targetVersion) throw Error('prior_update_unresolved');
      }
    });
    beforeSelection = JSON.stringify(reconciled);
    if (JSON.stringify(requireNoCompetingUpdate()) !== beforeSelection) throw Error('installation_changed');
    await checkFiles(installed, runtime.files);
    if (JSON.stringify(installationMetadata(installed, contract, componentContract)) !== JSON.stringify(metadata)) throw Error('installation_changed');
    // Update mode follows the existing helper contract. It needs real isolated
    // handoff/NSIS/ACK acceptance before any distribution; inspect stops above.
    await fsp.mkdir(paths.directory, { recursive: true }); plain(paths.directory);
    const selfIdentity = (await processRows()).find(row => row.pid === process.pid);
    if (!selfIdentity?.created) throw Error('process_identity_unknown');
    reservation = { id: crypto.randomUUID(), pid: process.pid, created: selfIdentity.created, ownerSession: context.session };
    const handle = await fsp.open(activeFile, 'wx');
    try { await handle.writeFile(JSON.stringify(reservation)); await handle.sync(); reserved = true; } finally { await handle.close(); }
    await waitForBusinessExit(); // Detect a launch which passed bootstrap before reservation.
    if (JSON.stringify(requireNoCompetingUpdate()) !== beforeSelection) throw Error('installation_changed');
    checkCancelled(); send('preparing');
    global.__xiaoxiComponents = { installedRoot: installed, applicationRoot: payload };
    created = await helper.createUpdateJob({ userData: profile, prepared: { kind: 'full', version: manifest.version, file: final, envelope }, currentVersion: version, channel: 'test' });
    checkCancelled();
    if (!same(created.job.executable, process.execPath) || !same(created.job.installedRoot, installed) || !inside(child(paths.directory, 'helper-runtime'), created.job.helperExecutable)) throw Error('job_invalid');
    const currentOwner = read(activeFile);
    if (currentOwner.id !== reservation.id || currentOwner.pid !== process.pid || currentOwner.ownerSession !== context.session) throw Error('job_ownership_changed');
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    helperProcess = spawn(created.job.helperExecutable, ['--xiaoxi-update-job', created.file], {
      env: environment, cwd: path.dirname(created.job.helperExecutable), windowsHide: true, detached: true, stdio: 'ignore'
    });
    await new Promise((resolve, reject) => { helperProcess.once('spawn', resolve); helperProcess.once('error', reject); });
    helperProcess.unref();
    const launchedIdentity = (await processRows()).find(row => row.pid === helperProcess.pid);
    if (!launchedIdentity?.created || !same(launchedIdentity.executable, created.job.helperExecutable) || launchedIdentity.parent !== process.pid) throw Error('helper_not_ready');
    const deadline = Date.now() + 30000, readyFile = created.file.replace(/\.json$/, '.ready.json');
    while (!fs.existsSync(readyFile)) { checkCancelled(); if (Date.now() >= deadline) throw Error('helper_not_ready'); await pause(100); }
    const ready = read(readyFile), owner = read(activeFile);
    const readyIdentity = (await processRows()).find(row => row.pid === helperProcess.pid);
    if (!readyIdentity || identity(readyIdentity) !== identity(launchedIdentity) || !same(readyIdentity.executable, created.job.helperExecutable) ||
        ready.pid !== helperProcess.pid || owner.id !== created.job.id || owner.pid !== helperProcess.pid) throw Error('helper_not_ready');
    checkCancelled(); send('committing');
    helper.authorizeUpdateJob(created.file, created.job); committed = true;
    send('handoff');
  } catch (error) {
    if (created && !committed) helper.revokeUpdateJob(created.file);
    if (cancelFailure) throw cancelFailure;
    if (cancelled || error.message === 'cancelled') send('cancelled'); else throw error;
  } finally {
    // Cancellation during preparation must not leave another full program copy.
    // Once a helper was launched, its own terminal receipts control reclamation.
    let cleanupFailure;
    try { if (created && !helperProcess?.pid && !committed) {
      helper.revokeUpdateJob(created.file);
      const { writeJsonAtomic } = require(child(payload, 'src/main/atomic-file.cjs'));
      writeJsonAtomic(created.file.replace(/\.json$/, '.status.json'), { phase: 'error',
        failure: { phase: 'prepare', code: cancelled ? 'update_request_cancelled' : 'helper_not_started' } });
      const storage = require(child(payload, 'src/main/update-storage.cjs'));
      const directory = path.dirname(created.job.helperExecutable);
      await storage.removeOwnedDirectory({ parent: path.dirname(directory), directory, identity: created.job.helperIdentity });
      const backup = created.job.programBackup;
      const registry = require(child(payload, 'src/main/update-backups.cjs')).readRegistry(profile);
      if (backup?.owned && !registry.sets.some(set => inside(backup.owned.directory, set.programBackup.program))) {
        await storage.removeOwnedDirectory(backup.owned);
      }
    } } catch (error) { cleanupFailure = error; }
    if (reserved && fs.existsSync(activeFile)) {
      const owner = read(activeFile);
      if (owner.id === reservation.id && owner.pid === process.pid && owner.ownerSession === context.session) await fsp.unlink(activeFile);
    }
    input.close(); transport.close();
    await new Promise(resolve => lease.close(resolve));
    if (cleanupFailure) throw Object.assign(Error('temporary_cleanup_deferred'), { cause: cleanupFailure });
  }
}
module.exports = { child, plain, checkFiles, inside, safeCode, installationMetadata };
if (require.main === module) main(process.argv[2]).catch(error => {
  // Keep actionable locations without persisting raw error messages, URLs,
  // credentials, customer paths or business payloads.
  try {
    const parent = plain(path.join(process.env.LOCALAPPDATA, 'AI获客更新助手'));
    if (same(path.dirname(plain(__dirname)), parent) && /^[a-f0-9-]{36}$/.test(path.basename(__dirname))) {
      const frames = [...String(error?.stack || '').matchAll(/[\\/]([a-zA-Z0-9_.-]+\.(?:cjs|js)):(\d+):(\d+)/g)]
        .slice(0, 12).map(match => ({ file: match[1], line: Number(match[2]), column: Number(match[3]) }));
      const commandError = /FullyQualifiedErrorId\s*:\s*([a-zA-Z0-9_.,\[\]-]{1,240})/.exec(String(error?.stderr || ''))?.[1];
      fs.writeFileSync(child(__dirname, 'failure-diagnostic.json'), JSON.stringify({ schema: 1, code: safeCode(error), phase: lastPhase,
        type: ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AggregateError'].includes(error?.name) ? error.name : 'Error', frames,
        ...(Number.isInteger(error?.code) ? { childExit: error.code } : {}), ...(commandError ? { commandError } : {}),
        ...(error?.killed === true ? { childKilled: true } : {}), ...(['SIGTERM', 'SIGKILL'].includes(error?.signal) ? { signal: error.signal } : {}) }));
    }
  } catch { /* Diagnostic failure must not replace the original failure. */ }
  send('error', 0, safeCode(error)); process.exitCode = 1;
});
