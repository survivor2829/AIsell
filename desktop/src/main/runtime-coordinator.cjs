const fs = require("node:fs");
const path = require("node:path");

const STATES = new Set(["idle", "syncing_contacts", "preparing_campaign", "touching", "replying", "paused", "stopping"]);

function nowIso() {
  return new Date().toISOString();
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writeAtomic(file, value) {
  const temporary = `${file}.tmp`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(handle, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function createRuntimeCoordinator(dataDir) {
  const lockFile = path.join(dataDir, "wechat-operation.lock.json");
  let current = null;

  function releaseStaleLock() {
    const lock = readLock(lockFile);
    if (!lock || processIsAlive(Number(lock.pid))) return null;
    fs.rmSync(lockFile, { force: true });
    return lock;
  }

  function initialize() {
    fs.mkdirSync(dataDir, { recursive: true });
    const stale = releaseStaleLock();
    return stale ? { recovered: true, lock: stale } : { recovered: false };
  }

  function status() {
    const diskLock = current || readLock(lockFile);
    return {
      state: diskLock?.state || "idle",
      lock: diskLock || null
    };
  }

  function acquire({ state, taskId = "", account = "", phase = "" }) {
    if (!STATES.has(state) || state === "idle" || state === "paused" || state === "stopping") {
      return { ok: false, error: "invalid_runtime_state" };
    }

    const stale = releaseStaleLock();
    const existing = current || readLock(lockFile);
    if (existing) {
      return { ok: false, error: "wechat_operation_busy", state: existing.state, lock: existing, stale_recovered: Boolean(stale) };
    }

    const lock = {
      version: 1,
      owner: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      pid: process.pid,
      state,
      task_id: String(taskId),
      account: String(account || "unknown"),
      started_at: nowIso(),
      current_phase: String(phase || state)
    };
    writeAtomic(lockFile, lock);
    current = lock;
    return { ok: true, lock, stale_recovered: Boolean(stale) };
  }

  function update(owner, phase) {
    if (!current || current.owner !== owner) return { ok: false, error: "runtime_lock_lost" };
    current.current_phase = String(phase || current.current_phase);
    writeAtomic(lockFile, current);
    return { ok: true, lock: current };
  }

  function transition(owner, state, phase = "") {
    if (!current || current.owner !== owner) return { ok: false, error: "runtime_lock_lost" };
    if (!STATES.has(state)) return { ok: false, error: "invalid_runtime_state" };
    current.state = state;
    current.current_phase = String(phase || current.current_phase);
    writeAtomic(lockFile, current);
    return { ok: true, lock: current };
  }

  function release(owner, state = "idle") {
    if (!current || current.owner !== owner) return { ok: false, error: "runtime_lock_lost" };
    fs.rmSync(lockFile, { force: true });
    current = null;
    return { ok: true, state };
  }

  return { acquire, initialize, release, status, transition, update, lockFile };
}

module.exports = { createRuntimeCoordinator };
