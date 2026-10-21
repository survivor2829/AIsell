const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { createAcquisitionSync } = require('./acquisition-sync.cjs');
const { createPreciseAcquisitionController } = require('./precise-acquisition.cjs');
const { namespaceFor, createAcquisitionAccount } = require('./acquisition-account.cjs');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquisition-sync-'));
  const brokenDir = path.join(root, 'disk-failure');
  const broken = createAcquisitionSync({ dataDir: brokenDir, namespace: 'isolated', request: async () => { throw Error('must not call network'); },
    getState: () => ({ profile: { city: 'fixture' }, enterprises: [], cards: [], sources: [], copyEvents: [] }), applyRecords() {} });
  fs.mkdirSync(path.join(brokenDir, 'precise-acquisition', 'sync.json'), { recursive: true });
  await broken.sync();
  assert.equal(broken.status().busy, false, 'write failure must release sync lock');
  assert.ok(broken.status().error);
  assert.doesNotThrow(() => broken.schedule(), 'background write failure must remain visible and retryable');
  broken.dispose();
  const python = process.env.PRECISE_TEST_PYTHON || 'python';
  const script = `import json,sys,tempfile\nfrom datetime import datetime,timedelta,timezone\nfrom service import GatewayConfig,GatewayServer,Handler\nc=GatewayConfig(keys={});c.receipt_db_path=sys.argv[1]\ns=GatewayServer(('127.0.0.1',0),Handler,c)\nt=c.sessions.issue('isolated-account',datetime.now(timezone.utc)+timedelta(hours=1))[0]\nprint(json.dumps({'port':s.server_port,'token':t}),flush=True)\ns.serve_forever()`;
  const child = spawn(python, ['-u', '-c', script, path.join(root, 'server.db')], { cwd: path.resolve(__dirname, '../../../server/provider-gateway'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const instances = [];
  try {
    const connection = await new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error('Local sync server timeout')), 10000); child.once('error', reject); child.stdout.on('data', data => { output += data; if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0])); } }); child.once('exit', () => { clearTimeout(timer); reject(Error('Local sync server exited')); }); });
    let loseReceipt = false, blockNetwork = false;
    const request = async (action, body) => {
      if (blockNetwork) throw Error('offline');
      const r = await fetch(`http://127.0.0.1:${connection.port}/v1/provider-gateway/local-acquisition/sync/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw Error('rejected'); const result = await r.json();
      if (loseReceipt && action === 'push') { loseReceipt = false; throw Error('lost response'); } return result;
    };
    const device = name => {
      const dir = path.join(root, name), c = createPreciseAcquisitionController({ dataDir: dir });
      const s = createAcquisitionSync({ dataDir: dir, namespace: namespaceFor('isolated-account'), request, getState: c.exportState, applyRecords: c.applyRecords });
      instances.push({ c, s }); return { c, s };
    };
    const a = device('a');
    await a.c.dispatch('save-profile', { city: '嘉兴市', equipment: ['洗地机'], services: ['sale'] });
    loseReceipt = true; await a.s.sync(); assert.equal(a.s.status().pending, 1);
    await a.s.sync(); assert.equal(a.s.status().pending, 0);
    const b = device('b'); await b.s.sync(); assert.equal(b.c.snapshot().profile.city, '嘉兴市'); assert.equal(b.s.status().conflicts.length, 0);
    blockNetwork = true;
    await a.c.dispatch('save-profile', { city: '杭州市', equipment: ['洗地机'], services: ['sale'] }); await a.s.sync();
    assert.equal(a.s.status().pending, 1);
    await b.c.dispatch('save-profile', { city: '宁波市', equipment: ['扫地机'], services: ['rental'] });
    blockNetwork = false; await b.s.sync(); await a.s.sync();
    assert.equal(a.s.status().conflicts.length, 1); assert.equal(a.c.snapshot().profile.city, '杭州市');
    await b.c.dispatch('save-profile', { city: '绍兴市', equipment: ['洗地机'], services: ['sale'] }); await b.s.sync(); await a.s.sync();
    assert.equal(a.s.status().conflicts[0].remote.data.profile.city, '绍兴市');
    // A later cloud version can become identical to the unresolved local copy.
    const localProfile = a.c.exportState();
    b.c.applyRecords([{ collection: 'profile', id: 'main', data: { profile: localProfile.profile, profiles: localProfile.profiles } }]);
    await b.s.sync(); await a.s.sync();
    assert.equal(a.s.status().conflicts[0].remote.data.profile.city, '杭州市');
    a.s.resolve(a.s.status().conflicts[0].id, 'remote'); await a.s.sync(); assert.equal(a.c.snapshot().profile.city, '杭州市');
    const source = '隔离采购 嘉兴市 洗地机采购 2026-10-15 2099-01-01 隔离公司';
    await a.c.dispatch('import-source', { url: 'https://example.com/isolated', text: source, facts: { quote: source, projectName: '隔离采购', projectCity: '嘉兴市', eventDate: '2026-10-15', deadline: '2099-01-01', equipment: ['洗地机'], services: ['sale'], signal: 'procurement', organizations: [{ name: '隔离公司' }] } });
    await a.c.dispatch('save-follow-up', { enterpriseId: a.c.snapshot().enterprises[0].id, content: '隔离测试，没有联系客户' });
    await a.s.sync(); await b.s.sync();
    assert.equal(b.c.snapshot().enterprises[0].followUps.length, 1); assert.equal(b.c.snapshot().sources.length, 1);
    await b.s.sync(); assert.equal(b.c.snapshot().enterprises[0].followUps.length, 1);
    await assert.rejects(request('pull', { expectedNamespace: namespaceFor('another-account') }));
    const old = path.join(root, 'legacy'); fs.mkdirSync(path.join(old, 'map-acquisition'), { recursive: true });
    const original = JSON.stringify({ tasks: [], leads: [{ id: 'keep', name: '原企业' }] }); fs.writeFileSync(path.join(old, 'map-acquisition/state.json'), original);
    let id = 'A'; const accounts = createAcquisitionAccount({ dataDir: old, getLicenseStatus: () => ({ authorized: true, licenseId: id }) });
    const owner = accounts.identity(); accounts.claim(owner, owner.namespace); assert.equal(accounts.migration(owner), false);
    id = 'B'; assert.equal(accounts.migration(accounts.identity()), false); assert.notEqual(owner.directory, accounts.identity().directory);
    assert.equal(fs.readFileSync(path.join(old, 'map-acquisition/state.json'), 'utf8'), original);
    // Simulate an interrupted copy before the completion marker was written.
    const digest = require('node:crypto').createHash('sha256').update(original).digest('hex');
    fs.writeFileSync(path.join(old, 'acquisition-accounts/map-legacy-owner.json'), JSON.stringify({ namespace: owner.namespace, completed: false, digests: { 'map-acquisition': digest } }));
    id = 'A'; accounts.resume(accounts.identity());
    assert.equal(accounts.migration(owner), false);
    assert.equal(fs.readFileSync(path.join(owner.directory, 'map-acquisition/state.json'), 'utf8').includes('原企业'), true);
    assert.equal(fs.readFileSync(path.join(old, 'map-acquisition/state.json'), 'utf8'), original);
    console.log('acquisition sync passed: real local HTTP + two controllers, lost receipt, offline conflict, shared evidence/history, identity binding, non-destructive migration');
  } finally { for (const { c, s } of instances) { s.dispose(); c.dispose(); } child.kill(); await new Promise(r => child.once('exit', r)); try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { console.error("Isolated artifacts retained:", root); } }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
