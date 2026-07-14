const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRuntimeCoordinator } = require("./runtime-coordinator.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-runtime-coordinator-"));
try {
  const coordinator = createRuntimeCoordinator(dir);
  assert.equal(coordinator.initialize().recovered, false);
  const sync = coordinator.acquire({ state: "syncing_contacts", taskId: "", account: "wx-a", phase: "sync" });
  assert.equal(sync.ok, true);
  assert.deepEqual(Object.keys(sync.lock).sort(), ["account", "current_phase", "owner", "pid", "started_at", "state", "task_id", "version"]);
  assert.equal(coordinator.acquire({ state: "touching", taskId: "task-1", account: "wx-a", phase: "select" }).error, "wechat_operation_busy");
  assert.equal(coordinator.release(sync.lock.owner).ok, true);

  const touch = coordinator.acquire({ state: "touching", taskId: "task-1", account: "wx-a", phase: "select" });
  assert.equal(coordinator.update(touch.lock.owner, "input-message-dry-run").lock.current_phase, "input-message-dry-run");
  assert.equal(coordinator.transition(touch.lock.owner, "paused", "pause_requested").lock.state, "paused");
  assert.equal(coordinator.transition(touch.lock.owner, "stopping", "stop_requested").lock.state, "stopping");
  assert.equal(coordinator.release(touch.lock.owner).ok, true);

  const reply = coordinator.acquire({ state: "replying", taskId: "reply-1", account: "wx-a", phase: "scan-unread" });
  assert.equal(reply.ok, true);
  assert.equal(coordinator.release(reply.lock.owner).ok, true);

  fs.writeFileSync(coordinator.lockFile, JSON.stringify({ pid: 999999, owner: "crashed", state: "touching", task_id: "task-2", account: "wx-b", started_at: "2026-07-10T00:00:00.000Z", current_phase: "send" }));
  assert.equal(coordinator.initialize().recovered, true);
  assert.equal(fs.existsSync(coordinator.lockFile), false);
  console.log("runtime-coordinator self-check passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
