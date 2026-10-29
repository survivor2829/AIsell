// Pulls failure capsules, their screenshots, feedback and report issues from
// the maintenance server to this computer, clusters them by root cause and
// writes a report. Usage: npm.cmd run issues:pull [-- --out <dir>]
// The administrator API listens on the server's loopback only; one SSH session
// runs a small collector there, as feedback-admin.cjs does for single requests.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_OUT = process.env.XIAOXI_FIELD_REPORTS || "D:/OpenAI/field-reports";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const EVIDENCE = /^[a-f0-9]{32}$/;

// Runs on the server with python3. Reads {known: {capsuleId: updatedAt}} on stdin.
const COLLECTOR = String.raw`
import base64, json, sys, urllib.request
BASE = "http://127.0.0.1:8081"
def get(route, raw=False):
    request = urllib.request.Request(BASE + route, headers={"Host": "127.0.0.1:8081"})
    with urllib.request.urlopen(request, timeout=20) as response:
        data = response.read()
    return data if raw else json.loads(data)
known = json.loads(sys.stdin.read() or "{}").get("known", {})
result = {"capsules": [], "groups": [], "feedback": [], "issues": [], "versions": []}
offset = 0
while True:
    page = get(f"/api/capsules?offset={offset}")
    result["groups"] = page["groups"]
    for item in page["items"]:
        if known.get(item["id"]) == item["updatedAt"]:
            result["capsules"].append({"id": item["id"], "unchanged": True, "updatedAt": item["updatedAt"]})
            continue
        detail = get(f"/api/capsules/{item['id']}")
        detail["images"] = {}
        for evidence in detail["evidence"]:
            if known.get(item["id"]) is None or evidence not in known.get(item["id"] + ":evidence", []):
                detail["images"][evidence] = base64.b64encode(get(f"/api/capsules/{item['id']}/evidence/{evidence}.png", True)).decode()
        result["capsules"].append(detail)
    offset += len(page["items"])
    if not page["items"] or offset >= page["total"]:
        break
offset = 0
while True:
    page = get(f"/api/feedback?offset={offset}")
    result["feedback"].extend(page["items"])
    offset += len(page["items"])
    if not page["items"] or offset >= page["total"] or offset >= 500:
        break
overview = get("/api/overview")
result["issues"], result["versions"] = overview["issues"], overview["versions"]
sys.stdout.write(json.dumps(result, ensure_ascii=False))
`;

function remoteCollect({ host = "115.159.88.100", known = {}, spawnProcess = spawn } = {}) {
  const key = path.join(os.homedir(), ".ssh", "ai-release-server_ed25519");
  const ssh = path.join(process.env.WINDIR || "C:/Windows", "System32", "OpenSSH", "ssh.exe");
  const encoded = Buffer.from(COLLECTOR).toString("base64");
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(ssh, ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=15", `ubuntu@${host}`, command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const chunks = [], errors = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`collector exited ${code}: ${Buffer.concat(errors).toString("utf8").slice(-800)}`));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ known }));
  });
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function compareVersions(a, b) {
  const left = String(a).split(".").map(Number), right = String(b).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0);
  return 0;
}

// The innermost frame of our own code is where a fix usually starts.
function originFrame(traceback = "") {
  const frames = [...String(traceback).matchAll(/File "([^"]+)", line (\d+), in (\S+)/g)]
    .map(match => ({ file: match[1], line: Number(match[2]), function: match[3] }))
    .filter(frame => /content_engine|worker\.py/.test(frame.file));
  const js = [...String(traceback).matchAll(/at (?:(\S+) \()?([^()\s]+\.c?js):(\d+):\d+\)?/g)]
    .map(match => ({ file: match[2], line: Number(match[3]), function: match[1] || "" }))
    .filter(frame => !/node:|node_modules/.test(frame.file));
  const frame = frames.at(-1) || js[0];
  return frame ? { ...frame, file: frame.file.replace(/\\/g, "/").replace(/^.*?((?:content_engine|src\/main|src\/shared|rpa)\/)/, "$1") } : null;
}

function save(out, pulled) {
  const capsuleDir = path.join(out, "capsules");
  fs.mkdirSync(capsuleDir, { recursive: true });
  const state = readJson(path.join(out, "state.json"), { known: {} });
  const fresh = [];
  for (const item of pulled.capsules) {
    if (item.unchanged || !UUID.test(item.capsule?.id || "")) continue;
    const id = item.capsule.id;
    const folder = path.join(capsuleDir, id);
    fs.mkdirSync(folder, { recursive: true });
    for (const [evidence, data] of Object.entries(item.images || {})) {
      if (EVIDENCE.test(evidence)) fs.writeFileSync(path.join(folder, `${evidence}.png`), Buffer.from(data, "base64"));
    }
    const record = { ...item };
    delete record.images;
    if (!state.known[id]) fresh.push(id);
    fs.writeFileSync(path.join(folder, "capsule.json"), JSON.stringify(record, null, 2));
    state.known[id] = item.updatedAt;
    state.known[`${id}:evidence`] = item.evidence;
  }
  const present = new Set(pulled.capsules.map(item => item.id || item.capsule?.id));
  fs.writeFileSync(path.join(out, "feedback.json"), JSON.stringify(pulled.feedback, null, 2));
  fs.writeFileSync(path.join(out, "issues.json"), JSON.stringify({ issues: pulled.issues, versions: pulled.versions }, null, 2));
  fs.writeFileSync(path.join(out, "state.json"), JSON.stringify(state, null, 2));
  const capsules = fs.readdirSync(capsuleDir).filter(name => UUID.test(name) && present.has(name))
    .map(name => readJson(path.join(capsuleDir, name, "capsule.json"), null)).filter(Boolean);
  return { capsules, fresh: new Set(fresh) };
}

function cluster(capsules, feedback, fresh = new Set()) {
  const latest = capsules.map(item => item.client?.version).filter(Boolean).sort(compareVersions).at(-1) || "";
  const groups = new Map();
  for (const item of capsules) {
    const capsule = item.capsule;
    const key = `${capsule.module}:${capsule.code}`;
    const group = groups.get(key) || { key, module: capsule.module, code: capsule.code, capsules: [], occurrences: 0,
      installs: new Set(), versions: new Set(), firstSeen: capsule.createdAt, lastSeen: capsule.lastSeenAt, origins: new Map(), messages: new Set(), feedback: [], fresh: 0 };
    group.capsules.push(capsule.id);
    group.occurrences += capsule.occurrences || 1;
    group.installs.add(item.client?.installId);
    group.versions.add(item.client?.version);
    if (capsule.createdAt < group.firstSeen) group.firstSeen = capsule.createdAt;
    if (capsule.lastSeenAt > group.lastSeen) group.lastSeen = capsule.lastSeenAt;
    const origin = originFrame(capsule.traceback) || (capsule.where ? { file: capsule.where, line: 0, function: "" } : null);
    if (origin) { const label = `${origin.file}${origin.line ? `:${origin.line}` : ""}${origin.function ? ` ${origin.function}` : ""}`; group.origins.set(label, (group.origins.get(label) || 0) + 1); }
    if (capsule.message) group.messages.add(capsule.message.slice(0, 160));
    if (fresh.has(capsule.id)) group.fresh += 1;
    groups.set(key, group);
  }
  for (const entry of feedback) {
    for (const capsuleId of entry.context?.capsules || []) {
      for (const group of groups.values()) if (group.capsules.includes(capsuleId) && !group.feedback.some(item => item.id === entry.id)) {
        group.feedback.push({ id: entry.id, text: entry.text, status: entry.status });
      }
    }
  }
  return [...groups.values()].map(group => ({ ...group, installs: group.installs.size, versions: [...group.versions].sort(compareVersions),
    inLatest: group.versions.has(latest), origins: [...group.origins].sort((a, b) => b[1] - a[1]), messages: [...group.messages] }))
    .sort((a, b) => b.fresh - a.fresh || b.installs - a.installs || b.occurrences - a.occurrences || (b.lastSeen > a.lastSeen ? 1 : -1));
}

// One line per item: customer text often spans several lines.
function line(value, limit) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit); }
function report(groups, feedback, { now = new Date(), latest = "" } = {}) {
  const pending = feedback.filter(item => item.status !== "resolved");
  const lines = [`# 现场问题日报 ${now.toISOString().slice(0, 10)}`, "",
    `问题类别 ${groups.length} 个，本次新增现场包的类别 ${groups.filter(group => group.fresh).length} 个；未解决反馈 ${pending.length} 条。最新版本 ${latest || "—"}。`, ""];
  for (const group of groups) {
    lines.push(`## ${group.fresh ? "🆕 " : ""}${group.module} · ${group.code}`, "",
      `- 现场包 ${group.capsules.length} 个，共发生 ${group.occurrences} 次，影响 ${group.installs} 台电脑；版本 ${group.versions.join("、")}${group.inLatest ? "（最新版本仍出现）" : ""}`,
      `- 首次 ${group.firstSeen}，最近 ${group.lastSeen}`);
    for (const [origin, count] of group.origins.slice(0, 3)) lines.push(`- 出错位置 \`${origin}\`（${count} 个）`);
    for (const message of group.messages.slice(0, 2)) lines.push(`- 客户看到：${line(message, 160)}`);
    for (const item of group.feedback.slice(0, 3)) lines.push(`- 关联反馈（${item.status}）：${line(item.text, 120)}`);
    lines.push(`- 查看：\`npm.cmd run issues:show -- ${group.capsules.at(-1)}\``, "");
  }
  const unlinked = pending.filter(item => !(item.context?.capsules || []).length);
  if (unlinked.length) {
    lines.push("## 未关联现场包的反馈", "");
    for (const item of unlinked.slice(0, 30)) lines.push(`- ${new Date(item.receivedAt * 1000).toISOString().slice(0, 16)} ${item.client?.version || ""} ${item.context?.module || ""}：${line(item.text, 120)}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function pull({ out = DEFAULT_OUT, collect = remoteCollect, now = new Date() } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const state = readJson(path.join(out, "state.json"), { known: {} });
  const pulled = await collect({ known: state.known });
  const { capsules, fresh } = save(out, pulled);
  const groups = cluster(capsules, pulled.feedback, fresh);
  const latest = capsules.map(item => item.client?.version).filter(Boolean).sort(compareVersions).at(-1) || "";
  const text = report(groups, pulled.feedback, { now, latest });
  fs.mkdirSync(path.join(out, "reports"), { recursive: true });
  fs.writeFileSync(path.join(out, "reports", `${now.toISOString().slice(0, 10)}.md`), text);
  fs.writeFileSync(path.join(out, "report.md"), text);
  fs.writeFileSync(path.join(out, "clusters.json"), JSON.stringify(groups, null, 2));
  return { out, capsules: capsules.length, fresh: fresh.size, groups: groups.length };
}

if (require.main === module) {
  const index = process.argv.indexOf("--out");
  pull({ out: index > 0 ? process.argv[index + 1] : DEFAULT_OUT })
    .then(result => console.log(`现场包 ${result.capsules} 个（新 ${result.fresh}），问题类别 ${result.groups} 个 → ${path.join(result.out, "report.md")}`))
    .catch(error => { console.error(`issues:pull failed: ${error.message}`); process.exit(1); });
}

module.exports = { pull, cluster, report, originFrame, compareVersions, DEFAULT_OUT, COLLECTOR };
