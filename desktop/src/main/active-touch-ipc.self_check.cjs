const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");

const spawnCalls = [];
const operationEnds = [];
let hangNext = false;
let exitWithoutCloseNext = false;
let killedChildren = 0;
let nextStdout = "";

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return { app: { getAppPath: () => "C:\\packaged-app" } };
  if (request === "./diagnostics.cjs") {
    return {
      diagnostics: () => ({
        begin: () => ({
          end: (details, outcome) => operationEnds.push({ details, outcome })
        })
      })
    };
  }
  if (request === "node:child_process") {
    return {
      spawn: (executable, args, options) => {
        spawnCalls.push({ executable, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {
          killedChildren += 1;
          return true;
        };
        if (hangNext) {
          hangNext = false;
        } else if (exitWithoutCloseNext) {
          exitWithoutCloseNext = false;
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from('{"ok":true,"action":"moments-dry-run"}'));
            child.emit("exit", 0);
          });
        } else {
          queueMicrotask(() => {
            child.stdout.emit(
              "data",
              Buffer.from(nextStdout || '{"ok":true,"action":"moments-dry-run"}')
            );
            nextStdout = "";
            child.emit("close", 0);
          });
        }
        return child;
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const modulePath = path.join(__dirname, "active-touch-ipc.cjs");
delete require.cache[require.resolve(modulePath)];
const { configureActiveTouchRuntime, parseExecutorOutput, runActiveTouchDev } = require(modulePath);
Module._load = originalLoad;

assert.equal(typeof parseExecutorOutput, "function", "executor output parser must be testable");

assert.deepEqual(
  parseExecutorOutput({ action: "input-message-dry-run", status: 1, stdout: "", stderr: "worker missing" }),
  {
    ok: false,
    action: "input-message-dry-run",
    blocked_reason: "executor_no_result",
    error: "worker missing",
    logs: []
  }
);

assert.equal(
  parseExecutorOutput({ action: "input-message-dry-run", status: 0, stdout: "{}", stderr: "" }).blocked_reason,
  "executor_result_invalid"
);
assert.equal(
  parseExecutorOutput({ action: "input-message-dry-run", status: 0, stdout: '{"ok":', stderr: "" }).blocked_reason,
  "executor_result_invalid"
);
assert.equal(
  parseExecutorOutput({ action: "status", status: 1, stdout: '{"ok":true}', stderr: "" }).blocked_reason,
  "executor_exit_failed"
);
assert.equal(
  parseExecutorOutput({ action: "status", error: new Error("spawn failed") }).blocked_reason,
  "executor_spawn_failed"
);
assert.equal(
  parseExecutorOutput({ action: "send", status: 1, stdout: '{"ok":false,"blocked_reason":"message_input_failed"}', stderr: "" }).blocked_reason,
  "message_input_failed"
);
assert.deepEqual(
  parseExecutorOutput({ action: "status", status: 0, stdout: '{"ok":true,"action":"status"}', stderr: "" }),
  { ok: true, action: "status" }
);

(async () => {
  const releasedOwners = [];
  let ownerSequence = 0;
  configureActiveTouchRuntime({
    dataDir: "runtime-data",
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: `owner-${++ownerSequence}` } }),
      release: (owner) => releasedOwners.push(owner)
    }
  });

  const routed = await runActiveTouchDev(["moments-dry-run", "--mode", "targeted", "--like"], { cliName: "moments_dry_run_cli.dev.cjs", timeoutMs: 100 });
  assert.equal(routed.ok, true);
  assert.equal(path.basename(spawnCalls[0].args[0]), "moments_dry_run_cli.dev.cjs");
  assert.deepEqual(spawnCalls[0].args.slice(-2), ["--data-dir", "runtime-data"]);
  assert.deepEqual(releasedOwners, ["owner-1"]);

  const isolated = await runActiveTouchDev(["moments-dry-run", "--mode", "targeted", "--like"], {
    cliName: "moments_dry_run_cli.dev.cjs",
    dataDir: "moments-data",
    timeoutMs: 100
  });
  assert.equal(isolated.ok, true);
  assert.deepEqual(spawnCalls[1].args.slice(-2), ["--data-dir", "moments-data"]);
  assert.deepEqual(releasedOwners, ["owner-1", "owner-2"]);

  nextStdout = JSON.stringify({
    ok: false,
    action: "moments-comment",
    status: "blocked",
    blocked_reason: "moments_comment_send_button_ambiguous",
    stage: "draft_written",
    primary_reason: "moments_comment_send_button_ambiguous",
    cleanup_reason: "moments_comment_draft_close_unverified",
    verification_mode: "unique_green_component_geometry_v1",
    real_action_attempted: false,
    diagnostics: {
      composer_completed: true,
      send_button_count: 2
    }
  });
  const metadataFailure = await runActiveTouchDev(
    ["moments-comment", "--observation-id", "a".repeat(64)],
    { cliName: "moments_action_cli.dev.cjs", timeoutMs: 100 }
  );
  assert.equal(metadataFailure.stage, "draft_written");
  assert.equal(metadataFailure.primary_reason, "moments_comment_send_button_ambiguous");
  assert.equal(metadataFailure.cleanup_reason, "moments_comment_draft_close_unverified");
  const metadataOperation = operationEnds.at(-1);
  assert.equal(metadataOperation.details.stage, "draft_written");
  assert.equal(metadataOperation.details.primary_reason, "moments_comment_send_button_ambiguous");
  assert.equal(metadataOperation.details.cleanup_reason, "moments_comment_draft_close_unverified");
  assert.equal(metadataOperation.details.verification_mode, "unique_green_component_geometry_v1");
  assert.equal(metadataOperation.details.real_action_attempted, false);
  assert.deepEqual(metadataOperation.details.diagnostics, {
    composer_completed: true,
    send_button_count: 2
  });
  assert.equal(metadataOperation.outcome.code, "moments_comment_send_button_ambiguous");
  assert.equal(
    JSON.stringify(metadataOperation).includes("moments_comment_draft_close_unverified"),
    true,
    "cleanup failure should remain diagnostic context without replacing the primary outcome code"
  );

  const sendClickedAt = "2026-07-28T12:00:00.000Z";
  nextStdout = JSON.stringify({
    ok: false,
    action: "moments-comment",
    status: "outcome_unknown",
    blocked_reason: "moments-comment_outcome_unknown",
    stage: "send_clicked",
    send_clicked_at: sendClickedAt,
    primary_reason: "moments_comment_post_send_unverified",
    cleanup_reason: "moments_comment_draft_close_unverified",
    verification_mode: "post_send_state_transition",
    real_action_attempted: true,
    diagnostics: {
      send_button_clicked: true,
      composer_completed: false
    }
  });
  await runActiveTouchDev(
    ["moments-comment", "--observation-id", "b".repeat(64)],
    { cliName: "moments_action_cli.dev.cjs", timeoutMs: 100 }
  );
  const clickedOperation = operationEnds.at(-1);
  assert.equal(clickedOperation.details.stage, "send_clicked");
  assert.equal(clickedOperation.details.send_clicked_at, sendClickedAt);
  assert.equal(clickedOperation.details.primary_reason, "moments_comment_post_send_unverified");
  assert.equal(clickedOperation.details.real_action_attempted, true);
  assert.equal(clickedOperation.outcome.code, "moments_comment_post_send_unverified");

  nextStdout = JSON.stringify({
    ok: false,
    action: "moments-comment",
    status: "outcome_unknown",
    blocked_reason: "moments-comment_outcome_unknown",
    primary_reason: "moments_comment_driver_failed",
    real_action_attempted: null,
    state: {
      real_action_attempted: true
    }
  });
  await runActiveTouchDev(
    ["moments-comment", "--observation-id", "c".repeat(64)],
    { cliName: "moments_action_cli.dev.cjs", timeoutMs: 100 }
  );
  assert.equal(
    operationEnds.at(-1).details.real_action_attempted,
    null,
    "an explicit top-level unknown outcome must not inherit a stale nested attempted value"
  );

  exitWithoutCloseNext = true;
  const exited = await runActiveTouchDev(["moments-dry-run", "--mode", "targeted", "--like"], { cliName: "moments_dry_run_cli.dev.cjs", timeoutMs: 500 });
  assert.equal(exited.ok, true, "a complete result must not wait forever when exit is observed without close");
  assert.deepEqual(releasedOwners, ["owner-1", "owner-2", "owner-3", "owner-4", "owner-5", "owner-6"]);

  hangNext = true;
  const timedOut = await runActiveTouchDev(["moments-dry-run", "--mode", "targeted", "--like"], { cliName: "moments_dry_run_cli.dev.cjs", timeoutMs: 5 });
  assert.equal(timedOut.blocked_reason, "executor_timeout");
  assert.equal(killedChildren, 1);
  assert.deepEqual(releasedOwners, ["owner-1", "owner-2", "owner-3", "owner-4", "owner-5", "owner-6", "owner-7"]);

  console.log("active-touch IPC self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
