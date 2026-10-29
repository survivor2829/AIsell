// Reruns every kept field replay against today's code. A fixture is a fixed
// capsule (issues:replay --keep) plus the result its fix produced; a change
// means a later edit altered a decision that once fixed a customer failure.
// It reports, it does not block a release (user decision 2026-10-29).
// Usage: npm.cmd run issues:verify [-- --out <dir>]
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_OUT } = require("./issues-pull.cjs");
const { replay } = require("./issues-replay.cjs");

function fixturesDir(out) { return path.join(out, "fixtures"); }

// Customer screenshots stay on this computer: fixtures live beside the pulled
// capsules, never in the repository.
function keep(directory, out, result) {
  const target = path.join(fixturesDir(out), path.basename(directory));
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(directory, target, { recursive: true });
  fs.writeFileSync(path.join(target, "expected.json"), JSON.stringify({ keptAt: new Date().toISOString(),
    steps: result.results.map(item => ({ step: item.step, now: item.now })) }, null, 2));
  return target;
}

function verify(out = DEFAULT_OUT, { run = replay } = {}) {
  const root = fixturesDir(out);
  const names = fs.existsSync(root) ? fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, "expected.json"))) : [];
  const rows = names.map(name => {
    const expected = JSON.parse(fs.readFileSync(path.join(root, name, "expected.json"), "utf8"));
    try {
      const result = run(path.join(root, name));
      const changed = result.results.filter((item, index) => item.error || JSON.stringify(item.now) !== JSON.stringify(expected.steps[index]?.now));
      return { name, ok: !changed.length && result.results.length === expected.steps.length, changed: changed.map(item => item.step) };
    } catch (error) { return { name, ok: false, changed: [], error: error.message }; }
  });
  return { total: rows.length, failed: rows.filter(row => !row.ok), rows };
}

if (require.main === module) {
  const index = process.argv.indexOf("--out");
  const result = verify(index > 0 ? process.argv[index + 1] : DEFAULT_OUT);
  for (const row of result.failed) console.log(`≠ ${row.name} ${row.error || row.changed.join("; ")}`);
  console.log(result.total ? `现场回放用例 ${result.total} 个，${result.failed.length} 个结果变了${result.failed.length ? "：先确认是否改坏了曾经修好的客户现场（不拦截发版）" : ""}` : "还没有现场回放用例");
}

module.exports = { verify, keep, fixturesDir };
