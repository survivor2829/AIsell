// Real published 104 -> this checkout's protocol-5 full installer. No mocks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createTransport } = require('../src/main/cloud-transport.cjs');
const { verifyManifest, compareVersions } = require('../src/shared/cloud-contract.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function disposable(env = process.env, platform = process.platform) {
  assert(platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows', 'GitHub disposable Windows runner required');
}
async function hash(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
async function until(action, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await action(); if (result) return result; await sleep(250); }
  throw Error('Acceptance condition timed out');
}
function powershell(args) {
  const child = spawn('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'protocol5-install-acceptance.ps1'), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve(out) : reject(Error(`Acceptance PowerShell ${code}: ${err}\n${out}`))); });
  // Fault watching starts before restart, but its failure is awaited after the job.
  done.catch(() => {}); return { child, done };
}
async function connect(port) {
  const page = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch { return null; } });
  const ws = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(); let id = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  return { close: () => ws.close(), evaluate: async expression => {
    const n = ++id;
    const result = await Promise.race([new Promise(resolve => { pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }), sleep(20 * 60_000).then(() => { throw Error('CDP evaluation timeout'); })]);
    assert(!result.error && !result.result.exceptionDetails, JSON.stringify(result)); return result.result.result.value;
  } };
}
async function main() {
  disposable(); // Before directory creation, downloads, installation, or process changes.
  const scenario = process.argv[2] || 'success';
  assert(['success', 'installer-interruption', 'startup-interruption'].includes(scenario));
  const report = path.join(process.env.RUNNER_TEMP, 'protocol5-install-acceptance'); fs.mkdirSync(report, { recursive: true });
  const inputs = path.join(process.env.RUNNER_TEMP, 'protocol5-install-inputs'); fs.mkdirSync(inputs, { recursive: true });
  const save = (name, data) => fs.writeFileSync(path.join(report, name + '.json'), JSON.stringify(data, null, 2));
  let fault, network, cdp;
  const profile = path.join(process.env.APPDATA, 'xiaoxi-active-touch-test');
  const program = path.join(process.env.LOCALAPPDATA, 'Programs', 'AI获客-测试版');
  const components = path.join(profile, 'data/cloud-maintenance/components'), jobs = path.join(components, 'jobs');
  try {
    assert(!fs.existsSync(profile) && !fs.existsSync(program), 'Fresh disposable profile and install required');
    const config = { ...require('../src/main/cloud-release-config.json').test, channel: 'test', caPem: fs.readFileSync(path.join(__dirname, '../src/main/cloud-test-ca.crt'), 'utf8') };
    network = createTransport(config);
    const sourceEnvelope = require('./fixtures/protocol5-source-1.1.104.json');
    const source = verifyManifest(sourceEnvelope, config);
    const targetEnvelope = await network.request('/v1/releases/test/latest');
    const target = verifyManifest(targetEnvelope, config); // Verifies and binds BOTH protocol-5 signed payloads.
    assert.equal(source.version, '1.1.104');
    assert.equal(target.version, require('../package.json').version, 'Latest must be this checkout, never a historical acceptance artifact');
    assert(compareVersions(target.version, source.version) > 0);
    assert(target.sequence > source.sequence);
    assert.equal(target.componentBase?.updateProtocol, 5); assert(targetEnvelope.componentBaseEnvelope);
    save('source-envelope', sourceEnvelope); save('target-envelope', targetEnvelope);
    const oldInstaller = path.join(inputs, 'source.exe'), newInstaller = path.join(inputs, 'target.exe');
    for (const [manifest, destination] of [[source, oldInstaller], [target, newInstaller]]) {
      await network.request(manifest.file, { destination, expected: manifest, maxBytes: manifest.size });
      assert.equal(fs.statSync(destination).size, manifest.size); assert.equal(await hash(destination), manifest.sha256);
    }
    await powershell(['-Mode', 'Install', '-File', oldInstaller]).done;
    const packageFile = path.join(program, 'resources/app/package.json');
    assert.equal(read(packageFile).version, source.version);
    const baseline = read(path.join(program, 'component-base.json'));
    assert.equal(baseline.base.fingerprint, source.componentBase.fingerprint);
    const exe = path.join(program, require('../product-brand.json').executableName + '-测试版.exe'); assert(fs.existsSync(exe));
    const cache = path.join(profile, 'data/cloud-maintenance'); fs.mkdirSync(cache, { recursive: true });
    const targetCached = path.join(cache, target.sha256 + '.exe'); fs.copyFileSync(newInstaller, targetCached);
    const receipt = path.join(profile, 'data/protocol5-acceptance-preserve.json');
    fs.writeFileSync(receipt, JSON.stringify({ outcome: 'outcome_unknown', scope: 'disposable protocol5 acceptance', nonce: crypto.randomUUID() }));
    const receiptHash = await hash(receipt), packageHash = await hash(packageFile);
    const server = require('node:net').createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
    spawn(exe, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { stdio: 'ignore' }).unref();
    cdp = await connect(port);
    await until(async () => cdp.evaluate('Boolean(window.xiaoxiCloudMaintenance?.check && window.xiaoxiCloudMaintenance?.restart)'));
    await powershell(['-Mode', 'Window', '-Executable', exe]).done;
    await cdp.evaluate('window.xiaoxiCloudMaintenance.check()');
    const checked = await until(async () => {
      const status = await cdp.evaluate('window.xiaoxiCloudMaintenance.status()');
      if (status.stage === 'error') throw Error('Published check failed: ' + JSON.stringify(status));
      return status.stage === 'ready' ? status : null;
    }, 20 * 60_000);
    save('real-check', checked);
    assert.equal(checked.stage, 'ready'); assert.equal(checked.nextVersion, target.version);
    if (scenario !== 'success') fault = powershell(['-Mode', 'Fault', '-Scenario', scenario, '-Executable', exe, '-File', targetCached, '-Jobs', jobs, '-PackageHash', packageHash, '-TargetVersion', target.version, '-Report', report]);
    // Published 104 preload -> trusted IPC -> updater.request -> beginInstall.
    const requested = await cdp.evaluate('window.xiaoxiCloudMaintenance.restart()'); save('real-restart', requested);
    assert(['waiting', 'preparing'].includes(requested.stage), 'Published update request was blocked: ' + JSON.stringify(requested));
    cdp.close(); cdp = null;
    const terminal = await until(async () => {
      if (!fs.existsSync(jobs)) return null;
      for (const name of fs.readdirSync(jobs).filter(x => x.endsWith('.status.json'))) {
        let state; try { state = read(path.join(jobs, name)); } catch { continue; }
        if (['error', 'complete'].includes(state.phase)) return { state, file: path.join(jobs, name) };
      } return null;
    }, 20 * 60_000);
    const jobFile = terminal.file.replace(/\.status\.json$/, '.json'), job = read(jobFile);
    assert.equal(job.currentVersion, source.version); assert.equal(job.targetVersion, target.version); assert.equal(job.prepared.kind, 'full');
    assert.equal(job.prepared.file, targetCached); assert(fs.existsSync(jobFile.replace(/\.json$/, '.ready.json')));
    assert(fs.existsSync(jobFile.replace(/\.json$/, '.commit.json')), 'Old helper must receive actual parent authorization');
    save('job', job); save('status', terminal.state);
    if (scenario !== 'success') {
      await fault.done;
      const injected = read(path.join(report, 'fault.json')); assert.equal(injected.scenario, scenario);
      assert.equal(terminal.state.phase, 'error'); assert.equal(terminal.state.failure.code, 'update_start_rolled_back');
      assert(job.programBackup.files.length > 0);
      for (const item of job.programBackup.files) {
        const restored = path.resolve(program, item.path); assert(restored.startsWith(path.resolve(program) + path.sep));
        assert.equal(fs.statSync(restored).size, item.size); assert.equal(await hash(restored), item.sha256, item.path);
      }
      const selection = read(path.join(components, 'selection.json'));
      assert.deepEqual(selection.active, job.programBackup.selection.active); assert.deepEqual(selection.previous, job.programBackup.selection.previous); assert(!selection.pending);
      assert.equal(read(packageFile).version, source.version);
    } else {
      assert.equal(terminal.state.phase, 'complete');
      const ack = read(jobFile.replace(/\.json$/, '.ack.json')); assert(ack.ok); assert.equal(ack.version, target.version); save('ack', ack);
      assert.equal(read(packageFile).version, target.version); assert.equal(read(path.join(program, 'component-base.json')).updateProtocol, 5);
      assert.equal(read(path.join(program, 'resources/app/src/shared/update-capabilities.json')).protocol, 5);
    }
    assert.equal(await hash(receipt), receiptHash);
    const window = await powershell(['-Mode', 'Window', '-Executable', exe]).done;
    save('result', { ok: true, source: source.version, target: target.version, scenario, publishedPreload: 'xiaoxiCloudMaintenance.check/restart', prevalidatedDownloadCache: true, programFilesVerified: scenario === 'success' ? 0 : job.programBackup.files.length, receiptHash, respondingWindow: JSON.parse(window), customerComputerVerified: false });
  } catch (error) { save('error', { message: error.message, stack: error.stack }); throw error; }
  finally {
    cdp?.close(); network?.close?.();
    if (fs.existsSync(jobs)) for (const name of fs.readdirSync(jobs).filter(x => x.endsWith('.json'))) fs.copyFileSync(path.join(jobs, name), path.join(report, name));
    if (fault && fault.child.exitCode === null) fault.child.kill();
  }
}
if (require.main === module) main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
module.exports = { disposable };
