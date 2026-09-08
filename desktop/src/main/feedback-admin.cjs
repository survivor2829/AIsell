const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { UUID, token } = require("../shared/cloud-contract.cjs");

function createFeedbackAdmin({ config, spawnProcess = spawn }) {
  const key = path.join(os.homedir(), ".ssh", "ai-release-server_ed25519");
  const ssh = path.join(process.env.WINDIR || "C:/Windows", "System32", "OpenSSH", "ssh.exe");
  const children = new Set();
  let authorized = false, checking;
  function request(route, body) {
    if (!config?.origin || !fs.existsSync(key)) return Promise.reject(new Error("feedback_admin_unavailable"));
    const host = new URL(config.origin).hostname;
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) return Promise.reject(new Error("feedback_admin_unavailable"));
    // Only fixed routes and validated integer/status query strings reach the remote shell.
    const command = "curl --silent --show-error --fail --max-time 20 -H 'Host: 127.0.0.1:8081' -H 'Origin: http://127.0.0.1:8081' "
      + (body ? "-H 'Content-Type: application/json' --data-binary @- " : "")
      + "'http://127.0.0.1:8081" + route + "'";
    return new Promise((resolve, reject) => {
      const child = spawnProcess(ssh, ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "ubuntu@" + host, command],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      children.add(child);
      let output = "", size = 0, finished = false;
      const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); children.delete(child); error ? reject(error) : resolve(value); };
      const failure = () => { authorized = false; finish(new Error("feedback_admin_unavailable")); child.kill(); };
      const timer = setTimeout(failure, 30_000);
      child.on("error", failure);
      child.stdin.on("error", () => {});
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { size += Buffer.byteLength(chunk, "utf8"); if (size > 2 * 1024 * 1024) return failure(); output += chunk.toString("utf8"); });
      child.on("close", (code) => { if (code !== 0) return failure(); try { finish(null, JSON.parse(output)); } catch { failure(); } });
      child.stdin.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function available() {
    if (authorized) return { available: true };
    if (checking) return checking;
    checking = (async () => { try { const result = await request("/api/feedback?offset=0"); authorized = Array.isArray(result?.items) && Number.isSafeInteger(result.total); } catch { authorized = false; } return { available: authorized }; })().finally(() => { checking = undefined; });
    return checking;
  }
  async function list(value = {}) {
    if (!(await available()).available) throw new Error("feedback_admin_unavailable");
    const offset = Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
    const status = ["pending", "in_progress", "resolved"].includes(value.status) ? value.status : "";
    const result = await request("/api/feedback?offset=" + offset + (status ? "&status=" + status : ""));
    if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total)) throw new Error("feedback_admin_invalid");
    return { offset, total: result.total, items: result.items.map((item) => ({
      id: item.id, text: item.text, category: item.category, createdAt: item.createdAt, receivedAt: item.receivedAt,
      updatedAt: item.updatedAt, status: item.status, visibility: item.visibility, hidden: item.hidden === true,
      officialReply: item.officialReply || "", diagnosticsExpired: item.diagnosticsExpired === true,
      diagnostics: (Array.isArray(item.diagnostics) ? item.diagnostics : []).slice(0, 20)
        .filter((entry) => entry && ["info", "warn", "error", "fatal"].includes(entry.level)).map((entry) => ({
          ts: typeof entry.ts === "string" && Number.isFinite(Date.parse(entry.ts)) ? entry.ts : "",
          level: entry.level, module: token(entry.module), event: token(entry.event), code: token(entry.code), phase: token(entry.phase),
          durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : 0
        }))
    })) };
  }
  async function update(value) {
    if (!UUID.test(value?.id || "") || !["pending", "in_progress", "resolved"].includes(value.status)
      || typeof value.officialReply !== "string" || Array.from(value.officialReply).length > 2000 || typeof value.hidden !== "boolean") throw new Error("feedback_admin_invalid");
    if (!(await available()).available) throw new Error("feedback_admin_unavailable");
    const result = await request("/api/feedback/status", { id: value.id, status: value.status, officialReply: value.officialReply, hidden: value.hidden });
    if (result?.updated !== true) throw new Error("feedback_admin_invalid");
    return { updated: true };
  }
  return { available, list, update, stop() { authorized = false; for (const child of children) child.kill(); children.clear(); } };
}
module.exports = { createFeedbackAdmin };
