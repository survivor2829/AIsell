const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

// The window-in-use switch (power-saving.ts) is replaced by a stub the test controls.
let windowActive = true;
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === "./power-saving" ? "power-saving-stub" : resolveFilename.call(this, request, ...rest); };
require.cache["power-saving-stub"] = { id: "power-saving-stub", filename: "power-saving-stub", loaded: true, exports: { isWindowActive: () => windowActive } };
const filename = path.join(__dirname, "status-subscription.ts");
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: filename
}).outputText, filename);
const { subscribeToStatus } = compiled.exports;

async function main() {
  const requests = [];
  const received = [];
  const timers = new Map();
  let push;
  let errors = 0;
  let unsubscribed = false;
  global.window = {
    setInterval(callback) { timers.set(1, callback); return 1; },
    clearInterval(id) { timers.delete(id); }
  };
  const source = {
    status: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    onUpdate(callback) { push = callback; return () => { unsubscribed = true; }; }
  };
  const stop = subscribeToStatus(source, (result) => received.push(result), () => { errors += 1; }, 15000);

  push("running");
  requests[0].resolve("idle");
  await Promise.resolve();
  assert.deepEqual(received, ["running"], "an older status response must not overwrite a pushed state");

  timers.get(1)();
  timers.get(1)();
  assert.equal(requests.length, 2, "slow status requests must not accumulate on each polling tick");
  push("paused");
  requests[1].reject(new Error("old request failed"));
  await Promise.resolve();
  assert.equal(errors, 0, "an obsolete request failure must not hide a newer healthy update");

  timers.get(1)();
  requests[2].reject(new Error("current request failed"));
  await Promise.resolve();
  assert.equal(errors, 1, "a current request failure must remain visible");

  timers.get(1)();
  requests[3].resolve("resumed");
  await Promise.resolve();
  assert.deepEqual(received, ["running", "paused", "resumed"], "polling must recover after a failed request");

  timers.get(1)();
  stop();
  requests[4].resolve("late result");
  push("late event");
  await Promise.resolve();
  assert.deepEqual(received, ["running", "paused", "resumed"], "disposed pages must ignore pending responses and queued events");
  assert.equal(unsubscribed, true);
  assert.equal(timers.size, 0);
  // 省电: while the window is not in use, only every fourth tick asks for the status.
  {
    const asked = [];
    const stopIdle = subscribeToStatus({ status: async () => { asked.push(1); return "ok"; } }, () => {}, () => {}, 1000);
    await Promise.resolve();
    windowActive = false;
    for (let i = 0; i < 8; i += 1) { timers.get(1)(); await new Promise((resolve) => setImmediate(resolve)); }
    await Promise.resolve();
    assert.equal(asked.length, 1 + 2, "a quarter as often while the window is not in use");
    windowActive = true; timers.get(1)(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked.length, 4, "every tick again once the window is in use");
    stopIdle();
  }
  delete global.window;
  console.log("Status subscription self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
