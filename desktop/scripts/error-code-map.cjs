// Error-code map for whoever diagnoses a capsule (a developer or an AI), not
// for customers: for every code, where the source raises it, which kind of
// cause it is, what evidence settles it, and whether it can be replayed here.
// Built from today's source on demand, so it cannot drift from the code.
// Usage: npm.cmd run issues:code -- <code>
const fs = require("node:fs");
const path = require("node:path");

const desktop = path.resolve(__dirname, "..");
const ENGINE_ROOTS = [path.join(desktop, "sidecars", "content-engine", "content_engine"), path.join(desktop, "sidecars", "content-engine", "worker.py")];
const CODE = "([a-z][a-z0-9_]{2,79})";
// The literal code of a raise, including a raise split over several lines.
const ENGINE_PATTERNS = [
  new RegExp(`ContentEngineError\\(\\s*['"]${CODE}['"]`, "g"),
  new RegExp(`\\brequire\\([^'"\\n]*(?:\\n[^'"\\n]*)?,\\s*['"]${CODE}['"]`, "g")
];

// Kinds a diagnosis starts from, with the evidence that decides each.
const KINDS = {
  network: { label: "网络/云服务", evidence: "出错前步骤里的云端请求与重试、网关状态；同时段其他电脑是否同样失败" },
  environment: { label: "客户电脑环境", evidence: "环境信息（磁盘、内存、运行组件）、引擎 stderr；一般由软件自己处理或提示，反复出现才按 bug 查" },
  material: { label: "素材/文案输入", evidence: "details 里的素材与时长测量、任务 context；看输入是否本就不合格，还是判断过严" },
  audio: { label: "配音/配乐/混音", evidence: "details 里每句的时间与响度、配乐编号；issues:show 会用当前规则重判测量值" },
  local_service: { label: "本地服务启动/运行", evidence: "服务输出原文（现场包 engineStderr）、启动阶段与耗时、退出码、电脑环境；没有输出原文就先补取证" },
  wechat_window: { label: "微信窗口/界面识别", evidence: "逐步画面、识别结果、失败时整屏与窗口列表；issues:replay 在本机重跑识别" },
  silent: { label: "暗中出错（任务显示成功但结果不对）", evidence: "现场包里的截图与出错前步骤：看软件为什么以为成功了（例如滚动没滚够、AI 称呼没拿到、视频没刷动），修判断，不只修这一次" },
  checkup: { label: "一键体检发现的电脑问题", evidence: "details.items 里每一项的结果；同一项在多台电脑出现时，先看是不是体检规则太严" },
  internal: { label: "程序内部", evidence: "堆栈（Python traceback 或 JS stack）与出错前步骤；通常能直接定位到代码行" },
  unclassified: { label: "未归类", evidence: "先读抛出位置的代码，判断属于哪一类，再补进 error-code-map.cjs 的分类规则" }
};
// Main-process codes: errors with a code, start failures, terminal states.
const MAIN_ROOT = path.join(desktop, "src", "main");
const MAIN_PATTERNS = [
  /\b(?:code|failureCode)\s*[:=]\s*["']([A-Za-z][A-Za-z0-9_]{2,79})["']/g,
  /\b(?:fail|failStart|failure|setTerminalState\(\s*["']failed["']\s*,)\s*\(?\s*["']([A-Za-z][A-Za-z0-9_]{2,79})["']/g
];
const SERVICE_CODE = /(?:start_timeout|spawn_failed|_exited|ready_invalid|runtime_unavailable|runtime_link_failed|pipe_failed)$/;

// WeChat reasons written in JS and PowerShell outside the rule catalog.
const WECHAT_ROOTS = [path.join(desktop, "rpa", "active_touch"), path.join(desktop, "src", "main")];
const WECHAT_FILE = /^(?:moments|wechat|touch|auto[-_]reply|active[-_]touch|state_machine|contact)[\w.-]*\.cjs$/;
const WECHAT_PATTERNS = [
  new RegExp(`\\b(?:blocked_reason|reasonCode|reason)\\s*[:=]\\s*["']${CODE}["']`, "g"),
  new RegExp(`\\b(?:failure|blocked)\\s*\\(\\s*["']${CODE}["']`, "g"),
  new RegExp(`Write-XiaoxiFailure\\s+["'][a-z0-9.-]+["']\\s+["']${CODE}["']`, "g")
];
const ENGINE_KIND_RULES = [
  // 1.2.36: silent failures and 一键体检 results.
  ["silent", /^(?:moments_duplicate_prevented|touch_salutation_unavailable|nurture_few_videos)$/],
  ["checkup", /^checkup_/],
  ["network", /^(?:cloud_|provider_|deepseek_|volcengine_|apimart_|bailian_)|gateway|_(?:poll|submit|download|upload)_|_outcome_unknown$|_timeout$/],
  ["environment", /disk|_write_failed|permission|runtime_unavailable|encoder_unavailable|not_configured|_unavailable$|lock/],
  ["audio", /audio|music|voice|loudness|tts|_mix_|narration_alignment/],
  ["material", /asset|source|footage|material|media_|probe|copy|narrat|script|caption|duration|candidate|brief|collection|cover/],
  ["internal", /^internal_error$|^invalid_|_invalid$|not_found$|retired|^analysis_|^render_|^task_|_task_|already_running|hash_mismatch|request_too_large|unsafe_path|file_changed|slot|preset|not_ready|paid_calls/],
  ["material", /unsupported_media/],
  // Codes of the desktop's own modules (WeChat workflow, browser publishing, video tools).
  ["wechat_window", /^(?:workflow_|test_contact|reply_|conversation_|send_|unknown_send|unknown_scan|auto_reply_|wechat_|manual_resolution|retry_|classification_|context_ready|sent_verified)/],
  ["network", /_submission_unknown$|_request_rejected$|_unconfirmed$|_send_unknown$|unverified$|_stream_|refresh_failed$|budget|douyin_|social_browser|social_navigation|social_page/],
  ["environment", /busy$|_running$|in_progress$|forbidden$|untrusted|guard|license_|login_required$|secure_storage|data_dir|symlink|eexist|cancelled$|_limit$|_stopped$/],
  ["material", /image_|video_|_missing$|_required$|_too_long$|_short$|_size$|_type$|title|keywords|invalid_input|invalid_option|_spec$|decode|_empty$|crowded|truncated/],
  ["internal", /^component_|^update_|_failed$|unresponsive|corrupt|duplicate|_changed$|mismatch|^no_|_unknown$|upgrade|_settled$|_outcome$|_status$|_mode$|_activated$|_recorded$|_requeued$|_requested$|_reconciled$|previous_build/]
];

function lineOf(text, index) { return text.slice(0, index).split("\n").length; }

function walk(target, files = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) { if (target.endsWith(".py")) files.push(target); return files; }
  for (const name of fs.readdirSync(target)) if (name !== "__pycache__" && !name.startsWith("tmp")) walk(path.join(target, name), files);
  return files;
}

function engineSites() {
  const sites = new Map();
  for (const file of ENGINE_ROOTS.flatMap(root => fs.existsSync(root) ? walk(root) : [])) {
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const pattern of ENGINE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const code = match[1];
        const list = sites.get(code) || [];
        list.push({ file: path.relative(path.resolve(desktop, ".."), file).replace(/\\/g, "/"), line: lineOf(text, match.index + match[0].lastIndexOf(code)) });
        sites.set(code, list);
      }
    }
  }
  return sites;
}

function wechatSites() {
  const sites = new Map();
  for (const root of WECHAT_ROOTS) {
    for (const name of fs.readdirSync(root).filter(file => WECHAT_FILE.test(file) && !file.includes("self_check"))) {
      const file = path.join(root, name);
      const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      for (const pattern of WECHAT_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const list = sites.get(match[1]) || [];
          list.push({ file: path.relative(path.resolve(desktop, ".."), file).replace(/\\/g, "/"), line: lineOf(text, match.index + match[0].lastIndexOf(match[1])) });
          sites.set(match[1], list);
        }
      }
    }
  }
  return sites;
}

function mainSites() {
  const sites = new Map();
  for (const name of fs.readdirSync(MAIN_ROOT).filter(file => file.endsWith(".cjs") && !file.includes("self_check"))) {
    const file = path.join(MAIN_ROOT, name);
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const pattern of MAIN_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const code = match[1].toLowerCase();
        if (!code.includes("_")) continue;
        const list = sites.get(code) || [];
        list.push({ file: path.relative(path.resolve(desktop, ".."), file).replace(/\\/g, "/"), line: lineOf(text, match.index + match[0].lastIndexOf(match[1])),
          module: name.replace(/(?:-ipc|-sidecar|-controller)?\.cjs$/, "").replace(/-/g, "_") });
        sites.set(code, list);
      }
    }
  }
  return sites;
}

function engineKind(code) { return (ENGINE_KIND_RULES.find(([, rule]) => rule.test(code)) || ["unclassified"])[0]; }

function buildMap() {
  const map = new Map();
  const add = (code, entry) => {
    const prior = map.get(code);
    map.set(code, prior ? { ...prior, sites: [...prior.sites, ...entry.sites], modules: [...new Set([...prior.modules, ...entry.modules])] } : entry);
  };
  for (const [code, sites] of engineSites()) {
    // require(condition, "code") also matches keyword arguments like "auto"; real codes have an underscore.
    if (code.includes("_")) add(code, { code, modules: ["content_engine"], kind: engineKind(code), sites, replay: [] });
  }
  const catalog = require("../src/shared/wechat-rule-catalog.json");
  const { classifyWechatFailureReason } = require("../src/shared/wechat-failure-policy.cjs");
  const texts = new Map();
  for (const row of catalog) {
    const policy = classifyWechatFailureReason(row.reason).classification;
    const file = `desktop/rpa/active_touch/${row.file}`.replace(/^desktop\/rpa\/active_touch\/desktop\//, "desktop/");
    // The catalog's line numbers go stale as code moves: find the rule today.
    const absolute = path.resolve(desktop, "..", file);
    if (!texts.has(absolute)) texts.set(absolute, fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8").replace(/\r\n/g, "\n") : "");
    const text = texts.get(absolute);
    let index = text.indexOf(`"${row.id}"`);
    if (index < 0) index = text.indexOf(`"${row.reason}"`);
    if (index < 0) continue;
    add(row.reason, { code: row.reason, modules: ["wechat"], kind: policy === "environment" ? "environment" : "wechat_window", policy,
      rules: [row.id], sites: [{ file, line: lineOf(text, index) }], replay: [] });
  }
  for (const [code, sites] of wechatSites()) {
    // Unregistered reasons count as blockers in the workflow policy as well.
    const policy = classifyWechatFailureReason(code);
    add(code, { code, modules: ["wechat"], kind: policy.classification === "environment" ? "environment" : "wechat_window", policy: policy.classification, sites, replay: [] });
  }
  for (const [code, sites] of mainSites()) {
    if (map.has(code)) { map.get(code).sites.push(...sites.map(({ module, ...site }) => site)); continue; }
    add(code, { code, modules: [...new Set(sites.map(site => site.module))], kind: SERVICE_CODE.test(code) ? "local_service" : engineKind(code),
      sites: sites.map(({ module, ...site }) => site), replay: [] });
  }
  const { REPLAYS } = require("./issues-show.cjs");
  for (const code of Object.keys(REPLAYS)) if (map.has(code)) map.get(code).replay.push("issues:show 用当前规则重判测量值");
  for (const entry of map.values()) {
    entry.sites = [...new Map(entry.sites.map(site => [`${site.file}:${site.line}`, site])).values()];
    if (entry.modules.includes("wechat")) entry.replay.push("issues:replay 重跑记录下来的识别（有无损帧时）");
    entry.evidence = KINDS[entry.kind].evidence;
    entry.kindLabel = KINDS[entry.kind].label;
  }
  return map;
}

let cached;
function lookup(code) {
  cached ||= buildMap();
  // Logged codes are lower case; the source may write them in capitals.
  return cached.get(String(code || "").toLowerCase()) || cached.get(String(code || "")) || reportedCode(String(code || "").toLowerCase());
}

// Silent failures and 一键体检 codes are passed as arguments or built from the item name, so no
// pattern above finds them; the place that reports them is found by its literal text instead.
function reportedCode(code) {
  const rule = ENGINE_KIND_RULES.slice(0, 2).find(([, pattern]) => pattern.test(code));
  if (!rule) return null;
  const needle = rule[0] === "checkup" ? "checkup_problems" : code;
  const sites = [];
  for (const name of fs.readdirSync(MAIN_ROOT).filter(file => file.endsWith(".cjs") && !file.includes("self_check"))) {
    const text = fs.readFileSync(path.join(MAIN_ROOT, name), "utf8").replace(/\r\n/g, "\n");
    const index = text.toLowerCase().indexOf(needle);
    if (index >= 0) sites.push({ file: `desktop/src/main/${name}`, line: lineOf(text, index) });
  }
  return { code, modules: [rule[0]], kind: rule[0], sites, replay: [], evidence: KINDS[rule[0]].evidence, kindLabel: KINDS[rule[0]].label };
}

function describe(entry, { sites = 5 } = {}) {
  if (!entry) return "错误码地图：源码里找不到这个错误码的固定抛出位置（可能是动态拼出的码或已删除的旧码），按堆栈定位。";
  const lines = [`错误码地图：${entry.kindLabel}（${entry.modules.join("、")}${entry.policy ? `，策略 ${entry.policy}` : ""}）`,
    `  定位要看：${entry.evidence}`,
    `  抛出位置（${entry.sites.length} 处）：${entry.sites.slice(0, sites).map(site => `${site.file}:${site.line}`).join("、")}${entry.sites.length > sites ? " …" : ""}`];
  if (entry.replay.length) lines.push(`  本机复现：${entry.replay.join("；")}`);
  return lines.join("\n");
}

module.exports = { buildMap, lookup, describe, engineKind, KINDS };

if (require.main === module) {
  const code = process.argv[2];
  if (!code) {
    const map = buildMap();
    const counts = {};
    for (const entry of map.values()) counts[entry.kindLabel] = (counts[entry.kindLabel] || 0) + 1;
    console.log(`错误码 ${map.size} 个：${Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join("，")}`);
  } else console.log(describe(lookup(code), { sites: 20 }));
}
