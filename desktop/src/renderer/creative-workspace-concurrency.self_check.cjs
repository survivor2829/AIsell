const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const filename = path.join(__dirname, "creative-workspace-concurrency.ts");
const source = fs.readFileSync(filename, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    strict: true
  },
  fileName: filename
}).outputText;
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(output, filename);
const { LatestRequestGate, SerializedMutationGate } = compiled.exports;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main() {
  const videos = [];
  const videoGate = new LatestRequestGate();
  const older = deferred();
  const newer = deferred();
  const olderToken = videoGate.begin("project-old|task-1");
  const olderLoad = older.promise.then((items) => {
    if (videoGate.accepts(olderToken, "project-old|task-1")) videos.push(...items);
  });
  const newerToken = videoGate.begin("project-new|task-2");
  const newerLoad = newer.promise.then((items) => {
    if (videoGate.accepts(newerToken, "project-new|task-2")) videos.push(...items);
  });
  newer.resolve(["new"]);
  older.resolve(["old"]);
  await Promise.all([olderLoad, newerLoad]);
  assert.deepEqual(videos, ["new"], "a stale project response must not replace newer videos");

  const actionGate = new SerializedMutationGate();
  const pause = actionGate.begin("task-one|7");
  assert.ok(pause);
  assert.equal(actionGate.begin("task-one|7"), null, "task actions must serialize");
  actionGate.invalidate();
  assert.equal(
    actionGate.accepts(pause, "task-one|7"),
    false,
    "a late task action response must be ignored after task invalidation"
  );
  const resume = actionGate.begin("task-two|8");
  assert.ok(resume);
  assert.equal(actionGate.finish(resume), true);
  assert.equal(actionGate.finish(resume), false);

  console.log("Creative workspace concurrency self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
