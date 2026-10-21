const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createServer } = require("node:net");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Kernel ownership survives neither a crash nor PID reuse. No stale pathname
// needs deletion, so competing recovery attempts cannot steal a new lease.
async function acquireProcessLock(scope, { timeoutMs = 15000, namespace = "update" } = {}) {
  if (!/^[a-z-]+$/.test(namespace)) throw Error("update_lock_namespace_invalid");
  await fs.promises.mkdir(path.dirname(scope), { recursive: true });
  let canonical;
  try { canonical = await fs.promises.realpath(scope); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonical = path.join(await fs.promises.realpath(path.dirname(scope)), path.basename(scope));
  }
  const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  const endpoint = process.platform === "win32"
    ? { path: `\\\\.\\pipe\\xiaoxi-${namespace}-${key}`, exclusive: true }
    : { host: "127.0.0.1", port: 49152 + parseInt(key.slice(0, 4), 16) % 16384, exclusive: true };
  const deadline = performance.now() + timeoutMs;
  let delay = 100;
  while (true) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
      return () => new Promise(resolve => server.close(resolve));
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      if (performance.now() >= deadline) throw Error(namespace === "backup" ? "update_backup_registry_busy" : "update_maintenance_busy");
      await sleep(Math.min(delay, Math.max(1, deadline - performance.now())));
      delay = Math.min(2000, delay * 2);
    }
  }
}
module.exports = { acquireProcessLock };
