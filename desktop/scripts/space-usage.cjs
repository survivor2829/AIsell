// Observations only: never follows links, deletes build inputs, or changes release gates.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');

function measureTree(root, seen = new Set()) {
  const result = { bytes: 0, files: 0, linksSkipped: 0, errors: 0, exists: fs.existsSync(root) };
  const pending = [root];
  while (pending.length) {
    const file = pending.pop();
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink()) { result.linksSkipped++; continue; }
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file)) pending.push(path.join(file, name));
      } else if (stat.isFile()) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (stat.ino && seen.has(identity)) continue;
        if (stat.ino) seen.add(identity);
        result.bytes += Number(stat.size);
        result.files++;
      }
    } catch (error) { if (error.code !== 'ENOENT') result.errors++; }
  }
  return result;
}

function snapshot(roots) {
  const seen = new Set();
  const paths = [...new Set(roots.map(root => path.resolve(root)))].sort((a, b) => a.length - b.length)
    .filter((root, index, all) => !all.slice(0, index).some(parent => root.startsWith(parent + path.sep)));
  const directories = paths.map(root => ({ path: root, ...measureTree(root, seen) }));
  const volumes = [...new Set(paths.map(root => path.parse(root).root))].map(root => {
    try { const stat = fs.statfsSync(root); return { path: root, freeBytes: stat.bavail * stat.bsize }; }
    catch { return { path: root, freeBytes: null }; }
  });
  return { at: new Date().toISOString(), directories, volumes, bytes: directories.reduce((sum, row) => sum + row.bytes, 0) };
}

function startSpaceRun(operation, roots = [path.join(desktop, '.build'), path.resolve(desktop, '../release')]) {
  const started = performance.now();
  let previousElapsedMs = 0;
  const reportDir = path.join(desktop, '.build', 'space-usage');
  const id = `${Date.now()}-${process.pid}-${operation}`;
  const reportFile = path.join(reportDir, `${id}.json`);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: desktop, encoding: 'utf8', windowsHide: true });
  const state = spawnSync('git', ['status', '--porcelain'], { cwd: desktop, encoding: 'utf8', windowsHide: true });
  const record = { schema: 1, id, operation, version: require('../package.json').version,
    commit: git.status === 0 ? git.stdout.trim() : null,
    sourceDirty: state.status === 0 ? Boolean(state.stdout.trim()) : null, status: 'running',
    measurement: 'Stage observations; logical file bytes; hard links deduplicated; junctions skipped. Not a continuous peak or whole-disk attribution.',
    uploads: null, localDownloadBytes: null, remoteCiArtifactBytes: null, ownedTemporaryPaths: [], samples: [], failedStages: [] };
  function save() {
    fs.mkdirSync(reportDir, { recursive: true });
    require('../src/main/atomic-file.cjs').writeJsonAtomic(reportFile, record);
  }
  function observe(stage, details = {}) {
    try {
      const scanStarted = performance.now();
      const usage = snapshot(roots);
      const elapsedMs = performance.now() - started;
      record.samples.push({ stage, ...usage, elapsedMs,
        stageElapsedMs: elapsedMs - previousElapsedMs,
        measurementMs: performance.now() - scanStarted, details });
      previousElapsedMs = elapsedMs;
      save();
    }
    catch (error) {
      record.failedStages.push(stage);
      console.warn(`Space observation unavailable (${error.code || 'measurement'}); build continues.`);
    }
  }
  observe('start');
  return {
    reportFile,
    observe,
    recordUploads(bytes, files) { record.uploads = { successfulFileBytes: bytes, files, includesProtocolOverhead: false }; },
    ownTemporary(root) {
      roots.push(root); record.ownedTemporaryPaths.push(root);
      try { save(); } catch { /* Observation failure must not change the build. */ }
    },
    finish(status, details = {}) {
      observe('end', details);
      try {
        record.status = status;
        record.elapsedMs = performance.now() - started;
        record.observedPeakBytes = Math.max(0, ...record.samples.map(row => row.bytes));
        record.netChangeBytes = record.samples.length > 1 ? record.samples.at(-1).bytes - record.samples[0].bytes : null;
        record.incomplete = record.failedStages.length > 0 || record.samples.some(row => row.directories.some(dir => dir.errors > 0));
        save();
        // These are our small generated measurement reports, not release/rollback artifacts.
        require('./artifact-retention.cjs').retainArtifacts(reportDir, 'space-observations', [reportFile], 30);
        console.log(`Space report: ${reportFile}`);
      } catch (error) { console.warn(`Space report unavailable (${error.code || 'measurement'}).`); }
    }
  };
}

module.exports = { measureTree, snapshot, startSpaceRun };
