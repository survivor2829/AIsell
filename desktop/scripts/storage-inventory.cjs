// Read-only inventory. Explicit roots only; does not traverse junctions or remove anything.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { measureTree } = require('./space-usage.cjs');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function inventory(roots) {
  return roots.map(input => {
    const root = path.resolve(input);
    const source = fs.existsSync(path.join(root, '.git'));
    const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    const status = source ? git(['status', '--porcelain', '--untracked-files=all']) : null;
    const commit = source ? git(['rev-parse', 'HEAD']) : null;
    const packageInfo = readJson(path.join(root, 'desktop/package.json'));
    const refs = [];
    for (const name of ['internal-release-accepted-base.json', 'internal-release-test-components.json', 'internal-release-test.json']) {
      const record = readJson(path.join(root, 'desktop/.build', name));
      if (record) for (const key of ['root', 'candidateRoot', 'installer', 'manifestFile']) if (record[key]) refs.push({ record: name, key, path: record[key] });
    }
    const entries = fs.existsSync(root) && !fs.lstatSync(root).isSymbolicLink()
      ? fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() || item.isSymbolicLink()).map(item => {
        const full = path.join(root, item.name);
        return { path: full, ...measureTree(full) };
      }) : [];
    // Source totals are intentionally separate from child rows; never sum both.
    return { path: root, ...measureTree(root), version: packageInfo?.version || readJson(path.join(root, '版本清单.json'))?.version || null,
      commit: commit?.status === 0 ? commit.stdout.trim() : null,
      dirty: status ? status.status === 0 ? Boolean(status.stdout.trim()) : 'unknown' : null,
      references: refs, entries: entries.sort((a, b) => b.bytes - a.bytes), deletionAuthorized: false };
  });
}
if (require.main === module) {
  const roots = process.argv.slice(2);
  if (!roots.length) throw Error('Provide explicit directory roots to inventory; no files will be deleted.');
  console.log(JSON.stringify({ at: new Date().toISOString(), unit: 'logical bytes; links skipped; hard links deduplicated within each row; parent and child rows overlap', roots: inventory(roots) }, null, 2));
}
module.exports = { inventory };
