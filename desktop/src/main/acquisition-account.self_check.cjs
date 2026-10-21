const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAcquisitionAccount, namespaceFor } = require('./acquisition-account.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquisition-domain-owner-'));
try {
  const put = (rel, value) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  put('map-acquisition/state.json', { tasks: [{ id: 'old-task', status: 'running' }], leads: [{ id: 'old-A-only' }] });
  put('precise-acquisition/state.json', { enterprises: [{ id: 'retired-preserved' }] });
  let id = 'A';
  const accounts = createAcquisitionAccount({ dataDir: root, getLicenseStatus: () => ({ authorized: true, licenseId: id }) });
  const a = accounts.identity();
  assert.equal(accounts.migration(a), true);
  assert.throws(() => accounts.claim(a, 'unconfirmed'), /核对/);
  accounts.claim(a, a.namespace);
  const copied = JSON.parse(fs.readFileSync(path.join(a.directory, 'map-acquisition/state.json')));
  assert.equal(copied.tasks[0].status, 'paused');
  assert.equal(copied.leads[0].id, 'old-A-only');
  assert.equal(fs.existsSync(path.join(a.directory, 'precise-acquisition/state.json')), false, 'retired domains must not be imported');
  assert.equal(accounts.migration(a), false);
  id = 'B'; const b = accounts.identity();
  assert.equal(accounts.migration(b), false, 'B cannot reclaim A map data or retired domains');
  assert.equal(fs.existsSync(path.join(b.directory, 'map-acquisition/state.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'map-acquisition/state.json'))).tasks[0].status, 'running', 'original is preserved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'precise-acquisition/state.json'))).enterprises[0].id, 'retired-preserved');
  console.log('acquisition ownership passed: confirmed map claim, original preservation, no retired migration and account isolation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
