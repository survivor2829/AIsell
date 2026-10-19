const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const namespaceFor = id => createHash('sha256').update(`xiaoxi-acquisition-v1:${id}`).digest('hex');

function createAcquisitionAccount({ dataDir, getLicenseStatus }) {
  const index = path.join(dataDir, 'acquisition-accounts', 'map-legacy-owner.json');
  const identity = () => {
    if (!getLicenseStatus) return { namespace: '', displayId: '本机隔离工作台', directory: dataDir, legacy: true };
    const status = getLicenseStatus();
    if (!status?.authorized || !status.licenseId) return null;
    const namespace = namespaceFor(status.licenseId);
    return { namespace, displayId: `渠道商 ${namespace.slice(0, 8)}`, directory: path.join(dataDir, 'acquisition-accounts', namespace) };
  };
  function migration(current) {
    if (!current || current.legacy) return false;
    const owner = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : null;
    if (owner && owner.namespace !== current.namespace || owner?.completed) return false;
    return ['map-acquisition'].some(domain => fs.existsSync(path.join(dataDir, domain, 'state.json')));
  }
  function claim(current, confirmedNamespace) {
    if (!current || confirmedNamespace !== current.namespace || !migration(current)) throw Error('请核对当前账号及旧资料归属');
    const prior = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : null;
    const copies = [];
    for (const domain of ['map-acquisition']) {
      const source = path.join(dataDir, domain, 'state.json');
      if (!fs.existsSync(source)) continue;
      const original = JSON.parse(fs.readFileSync(source, 'utf8'));
      for (const task of original.tasks || []) if (task.status === 'running') task.status = 'paused';
      const digest = createHash('sha256').update(JSON.stringify(original)).digest('hex');
      const target = path.join(current.directory, domain, 'state.json');
      if (fs.existsSync(target)) {
        const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
        const sameCopy = prior?.namespace === current.namespace && prior.digests?.[domain] === digest && createHash('sha256').update(JSON.stringify(saved)).digest('hex') === digest;
        if (!sameCopy && (saved.profile?.city || ['profiles', 'cards', 'enterprises', 'leads', 'tasks', 'sources', 'copyEvents', 'syncedFollowUps'].some(key => saved[key]?.length))) throw Error('当前账号已有资料，不能覆盖导入旧库');
      }
      copies.push({ domain, original, digest, target });
    }
    // Reserve the owner before copying. A crash can resume only for this account.
    writeJsonAtomic(index, { namespace: current.namespace, completed: false, digests: Object.fromEntries(copies.map(c => [c.domain, c.digest])) });
    for (const copy of copies) writeJsonAtomic(copy.target, copy.original);
    writeJsonAtomic(index, { namespace: current.namespace, completed: true });
  }
  function resume(current) {
    const prior = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : null;
    if (current && prior?.namespace === current.namespace && !prior.completed) claim(current, current.namespace);
  }
  return { identity, migration, claim, resume };
}
module.exports = { createAcquisitionAccount, namespaceFor };
