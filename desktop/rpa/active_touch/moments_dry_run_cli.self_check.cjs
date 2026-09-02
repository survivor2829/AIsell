const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const calls = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./moments_dry_run.dev.cjs") {
    return {
      prepareMomentsDryRun: (baseDir, payload) => {
        calls.push({ baseDir, payload });
        return { ok: true };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const modulePath = path.join(__dirname, "moments_dry_run_cli.dev.cjs");
delete require.cache[require.resolve(modulePath)];
let main;
try {
  ({ main } = require(modulePath));
} finally {
  Module._load = originalLoad;
}

const expectedWindow = {
  surfaceMode: "integrated",
  pid: 42,
  hWnd: "84",
  title: "微信",
  className: "mmui::MainWindow"
};
main([
  "node",
  modulePath,
  "--mode",
  "random",
  "--like",
  "--comment-enabled",
  "--comment-text-base64",
  Buffer.from("测试评论", "utf8").toString("base64"),
  "--expected-window-base64",
  Buffer.from(JSON.stringify(expectedWindow), "utf8").toString("base64"),
  "--data-dir",
  "runtime-data"
]);
assert.deepEqual(calls[0], {
  baseDir: "runtime-data",
  payload: {
    mode: "random",
    likeEnabled: true,
    commentEnabled: true,
    commentText: "测试评论",
    expectedWindowRequired: true,
    expectedWindow
  }
});

main(["node", modulePath, "--mode", "targeted", "--like", "--expected-window-base64", "not-base64"]);
assert.equal(calls[1].payload.expectedWindow, undefined);
assert.equal(calls[1].payload.expectedWindowRequired, true);

main(["node", modulePath, "--mode", "targeted", "--like"]);
assert.equal(Object.hasOwn(calls[2].payload, "expectedWindow"), false);
assert.equal(Object.hasOwn(calls[2].payload, "expectedWindowRequired"), false);

main(["node", modulePath, "--mode", "random", "--like", "--comment-enabled", "--comment-intent-only", "--allow-body-only"]);
assert.equal(calls[3].payload.allowBodyOnly, true);
assert.equal(calls[3].payload.commentIntentOnly, true);

const targetPost = {
  source: "visual:windows_media_ocr",
  structure_verified: true,
  identity_text: "locked post body",
  stable_anchor_text: "locked post body",
  avatar_hash: "a".repeat(64),
  bounds: { left: 10, top: 20, width: 300, height: 200 },
  expected_scroll_delta: -240
};
main([
  "node",
  modulePath,
  "--mode",
  "random",
  "--like",
  "--target-post-base64",
  Buffer.from(JSON.stringify(targetPost), "utf8").toString("base64")
]);
assert.equal(calls[4].payload.targetPostRequired, true);
assert.deepEqual(calls[4].payload.targetPost, targetPost);

main(["node", modulePath, "--mode", "random", "--like", "--target-post-base64", "not-json"]);
assert.equal(calls[5].payload.targetPostRequired, true);
assert.equal(calls[5].payload.targetPost, undefined);

console.log("moments dry-run CLI self-check passed");
