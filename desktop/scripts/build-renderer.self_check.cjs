const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const filename = path.join(__dirname, "build-renderer.cjs");
const source = fs.readFileSync(filename, "utf8");

function runBuild(result) {
  const writes = [];
  const exit = new Error("process exited");
  let exitCode = null;
  const mockedRequire = (id) => {
    if (id === "node:child_process") return { spawnSync: () => result };
    if (id === "node:fs") return { writeFileSync: (...args) => writes.push(args) };
    return require(id);
  };
  mockedRequire.resolve = require.resolve;
  try {
    vm.runInNewContext(source, {
      require: mockedRequire,
      __dirname,
      console: { log() {}, error() {} },
      process: {
        argv: [process.execPath, filename, "test"],
        execPath: process.execPath,
        env: { XIAOXI_BUILD_ID: "regression-build" },
        exit(code) { exitCode = code; throw exit; }
      }
    }, { filename });
  } catch (error) {
    if (error !== exit) throw error;
  }
  return { writes, exitCode };
}

for (const result of [
  { status: 2 },
  { status: null, signal: "SIGTERM" },
  { status: null, error: new Error("spawn failed") }
]) {
  const failed = runBuild(result);
  assert.equal(failed.writes.length, 0, "failed builds must not replace the edition marker of an older output");
  assert.equal(failed.exitCode, result.status || 1, "failed builds must return a nonzero exit code");
}

const succeeded = runBuild({ status: 0 });
assert.equal(succeeded.exitCode, null);
assert.equal(succeeded.writes.length, 1);
assert.deepEqual(JSON.parse(succeeded.writes[0][1]), {
  edition: "development",
  buildId: "regression-build"
});
console.log("renderer build result self-check passed");
