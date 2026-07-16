const assert = require("node:assert/strict");

const { parseExecutorOutput } = require("./active-touch-ipc.cjs");

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

console.log("active-touch IPC self-check passed");
