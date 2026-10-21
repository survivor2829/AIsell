const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAcquisitionAccount, namespaceFor } = require('./acquisition-account.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquisition-domain-owner-'));
try {
  const put = (rel, value) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  put('map-acquisition/state.json', { leads: [{ id: 'old-A-only' }] });
  put('precise-acquisition/state.json', { enterprises: [{ id: 'unclaimed-precise' }] });
  put('acquisition-accounts/map-legacy-owner.json', { namespace: namespaceFor('A'), completed: true });
  const accounts = createAcquisitionAccount({ dataDir: root, getLicenseStatus: () => ({ authorized: true, licenseId: 'B' }) });
  const b = accounts.identity();
  assert.equal(accounts.migration(b), true, 'unclaimed precise data remains independently importable');
  accounts.claim(b, b.namespace);
  assert.equal(fs.existsSync(path.join(b.directory, 'map-acquisition/state.json')), false, 'B must never reclaim A old map source');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.directory, 'precise-acquisition/state.json'))).enterprises[0].id, 'unclaimed-precise');
  assert.equal(accounts.migration(b), false, 'completed domain claims are idempotent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'map-acquisition/state.json'))).leads[0].id, 'old-A-only');
  console.log('acquisition domain ownership passed: existing map owner, independent precise claim, idempotence and original preservation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
