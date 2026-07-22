const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");

const spawnCalls = [];
let hangNext = false;
let exitWithoutCloseNext = false;
let killedChildren = 0;

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return { app: { getAppPath: () => "C:\\packaged-app" } };
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
            child.stdout.emit("data", Buffer.from('{"ok":true,"action":"moments-dry-run"}'));
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

  exitWithoutCloseNext = true;
  const exited = await runActiveTouchDev(["moments-dry-run", "--mode", "targeted", "--like"], { cliName: "moments_dry_run_cli.dev.cjs", timeoutMs: 500 });
  assert.equal(exited.ok, true, "a complete result must not wait forever when exit is observed without close");
  assert.deepEqual(releasedOwners, ["owner-1", "owner-2", "owner-3"]);

  hangNext = true;
  const timedOut = await runActiveTouchDev(["moments-dry-run", "--mode", "targeted", "--like"], { cliName: "moments_dry_run_cli.dev.cjs", timeoutMs: 5 });
  assert.equal(timedOut.blocked_reason, "executor_timeout");
  assert.equal(killedChildren, 1);
  assert.deepEqual(releasedOwners, ["owner-1", "owner-2", "owner-3", "owner-4"]);

  console.log("active-touch IPC self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
