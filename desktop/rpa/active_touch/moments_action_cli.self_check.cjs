const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const calls = [];
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "./moments_action.dev.cjs") {
    return {
      inspectMomentsMenu: async (options) => {
        calls.push(["inspect", options]);
        return { ok: true, action: "moments-menu-inspect" };
      },
      executeMomentsLike: async (options) => {
        calls.push(["like", options]);
        return { ok: true, action: "moments-like" };
      },
      executeMomentsComment: async (options) => {
        calls.push(["comment", options]);
        return { ok: true, action: "moments-comment" };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const modulePath = path.join(__dirname, "moments_action_cli.dev.cjs");
delete require.cache[require.resolve(modulePath)];
const { main } = require(modulePath);
Module._load = originalLoad;

(async () => {
  const observationId = "b".repeat(64);
  assert.equal((await main([
    "node",
    modulePath,
    "moments-inspect-menu",
    "--observation-id",
    observationId,
    "--data-dir",
    "runtime-data"
  ])).ok, true);
  assert.deepEqual(calls[0], ["inspect", { baseDir: "runtime-data", observationId }]);

  assert.equal((await main([
    "node",
    modulePath,
    "moments-like",
    "--observation-id",
    observationId
  ])).ok, true);
  assert.deepEqual(calls[1], ["like", { baseDir: undefined, observationId }]);

  assert.equal((await main([
    "node",
    modulePath,
    "moments-comment",
    "--observation-id",
    observationId,
    "--comment-text-base64",
    Buffer.from("只读检查，不发送", "utf8").toString("base64"),
    "--data-dir",
    "runtime-data"
  ])).ok, true);
  assert.deepEqual(calls[2], ["comment", {
    baseDir: "runtime-data",
    observationId,
    commentText: "只读检查，不发送"
  }]);

  assert.equal((await main([
    "node",
    modulePath,
    "moments-comment",
    "--observation-id",
    observationId,
    "--comment-text-base64",
    Buffer.from("增强验收", "utf8").toString("base64"),
    "--enhanced-readback"
  ])).ok, true);
  assert.deepEqual(calls[3], ["comment", {
    baseDir: undefined,
    observationId,
    commentText: "增强验收",
    enhancedReadback: true
  }]);

  const invalid = await main(["node", modulePath, "invalid"]);
  assert.equal(invalid.blocked_reason, "moments_action_invalid");
  assert.equal(invalid.real_action_attempted, false);

  console.log("moments action CLI self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
