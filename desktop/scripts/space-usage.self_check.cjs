const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { measureTree, snapshot, startSpaceRun } = require('./space-usage.cjs');
const parent = path.resolve(__dirname, '../.build');
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'space-check-'));
try {
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'a'), Buffer.alloc(100));
  fs.linkSync(path.join(data, 'a'), path.join(data, 'same-file'));
  fs.symlinkSync(data, path.join(root, 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(measureTree(root), { bytes: 100, files: 1, linksSkipped: 1, errors: 0, exists: true });
  assert.equal(snapshot([root, data, root]).bytes, 100, 'nested roots must not double count');
  const before = snapshot([root]);
  fs.writeFileSync(path.join(data, 'new'), Buffer.alloc(25));
  assert.equal(snapshot([root]).bytes - before.bytes, 25);
  assert.equal(measureTree(path.join(root, 'missing')).bytes, 0);
  const roots = [data];
  const run = startSpaceRun('timing-check', roots);
  fs.writeFileSync(path.join(data, 'measured-growth'), Buffer.alloc(7));
  run.observe('verification-complete');
  roots.push(null); // A measurement failure must not stop work or claim complete evidence.
  run.observe('unavailable-observation');
  roots.pop();
  run.finish('completed');
  const report = JSON.parse(fs.readFileSync(run.reportFile, 'utf8'));
  assert.equal(report.netChangeBytes, 7);
  assert.equal(report.incomplete, true);
  assert.deepEqual(report.failedStages, ['unavailable-observation']);
  assert.ok(report.elapsedMs >= report.samples.at(-1).elapsedMs);
  let elapsed = 0;
  for (const sample of report.samples) {
    assert.ok(sample.elapsedMs >= elapsed);
    assert.ok(sample.measurementMs >= 0);
    assert.ok(Math.abs(sample.stageElapsedMs - (sample.elapsedMs - elapsed)) < 0.001);
    elapsed = sample.elapsedMs;
  }
  console.log('SPACE_USAGE_CHECK_OK: hard links, junctions, overlapping roots, actual growth');
} finally {
  // Only this invocation's fixture; unlink its junction before removing the tree.
  const link = path.join(root, 'linked-data');
  if (fs.existsSync(link)) fs.unlinkSync(link);
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent));
  fs.rmSync(root, { recursive: true, force: true });
}
