const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const namespaceFor = id => createHash('sha256').update(`xiaoxi-acquisition-v1:${id}`).digest('hex');

function createAcquisitionAccount({ dataDir, getLicenseStatus }) {
  const index = path.join(dataDir, 'acquisition-accounts', 'legacy-owner.json');
  const identity = () => {
    if (!getLicenseStatus) return { namespace: '', displayId: '本机隔离工作台', directory: dataDir, legacy: true };
    const status = getLicenseStatus();
    if (!status?.authorized || !status.licenseId) return null;
    const namespace = namespaceFor(status.licenseId);
    return { namespace, displayId: `渠道商 ${namespace.slice(0, 8)}`, directory: path.join(dataDir, 'acquisition-accounts', namespace) };
  };
  const domains = [['map-acquisition', 'map-legacy-owner.json']];
  const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  function candidates(current) {
    if (!current || current.legacy) return [];
    const combined = read(index);
    return domains.map(([domain, marker]) => {
      const file = path.join(dataDir, 'acquisition-accounts', marker);
      const prior = read(file) || combined;
      return { domain, file, prior, source: path.join(dataDir, domain, 'state.json') };
    }).filter(r => (!r.prior || r.prior.namespace === current.namespace && !r.prior.completed) && fs.existsSync(r.source));
  }
  const migration = current => candidates(current).length > 0;
  function copy(current, rows) {
    const copies = rows.map(row => {
      const original = read(row.source);
      for (const task of original.tasks || []) if (task.status === 'running') task.status = 'paused';
      const digest = createHash('sha256').update(JSON.stringify(original)).digest('hex');
      const target = path.join(current.directory, row.domain, 'state.json');
      const saved = read(target);
      if (saved) {
        const priorDigest = row.prior?.digest || row.prior?.digests?.[row.domain];
        const sameCopy = priorDigest === digest && createHash('sha256').update(JSON.stringify(saved)).digest('hex') === digest;
        const populated = saved.profile?.city || saved.brand?.name || Object.values(saved).some(v => Array.isArray(v) && v.length);
        if (!sameCopy && populated) throw Error('当前账号已有资料，不能覆盖导入旧库');
      }
      return { ...row, original, digest, target };
    });
    // Reserve every owner before copying; retries may only resume for that owner.
    for (const row of copies) writeJsonAtomic(row.file, { namespace: current.namespace, completed: false, digest: row.digest });
    for (const row of copies) {
      writeJsonAtomic(row.target, row.original);
      writeJsonAtomic(row.file, { namespace: current.namespace, completed: true });
    }
  }
  function claim(current, confirmedNamespace) {
    if (!current || confirmedNamespace !== current.namespace || !migration(current)) throw Error('请核对当前账号及旧资料归属');
    copy(current, candidates(current));
  }
  function resume(current) {
    copy(current, candidates(current).filter(row => row.prior?.namespace === current.namespace && !row.prior.completed));
  }
  return { identity, migration, claim, resume };
}
module.exports = { createAcquisitionAccount, namespaceFor };
