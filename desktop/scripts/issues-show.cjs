// Prints one pulled failure capsule for diagnosis: what the customer saw, the
// measurements, the stack mapped onto today's local source, the steps before
// it, and, for known checks, the same decision replayed with current rules.
// Usage: npm.cmd run issues:show -- <capsule id or prefix> [--out <dir>]
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_OUT } = require("./issues-pull.cjs");

const repo = path.resolve(__dirname, "..");
const SOURCE_ROOTS = [path.join(repo, "sidecars", "content-engine"), repo];

// Each replay re-judges the capsule's own measurements with the rule the
// current code applies. When it says "would pass", the fix covers this case.
const REPLAYS = {
  auto_mix_music_not_audible(details) {
    const quiet = details.quiet || [], audible = details.audible || [];
    if (!quiet.length && !audible.length) return null;
    const quietSpan = quiet.reduce((sum, item) => sum + Math.max(0, item.endMs - item.startMs), 0);
    const onSpan = Number(details.musicOnSpanMs) || quietSpan + audible.reduce((sum, item) => sum + Math.max(0, item.endMs - item.startMs), 0);
    // creative_render._measure_auto_mix_window_margins: fail only with no
    // audible phrase or music missing from more than half the speech.
    const fails = !audible.length || quietSpan * 2 > onSpan;
    return { rule: "无可听句，或听不到音乐的口播超过一半", quietPhrases: quiet.length, audiblePhrases: audible.length,
      quietShare: onSpan ? `${Math.round(quietSpan / onSpan * 100)}%` : "—", verdict: fails ? "当前规则下仍会失败" : "当前规则下会通过" };
  }
};

function find(out, query) {
  const folder = path.join(out, "capsules");
  const matches = fs.existsSync(folder) ? fs.readdirSync(folder).filter(name => name.startsWith(query)) : [];
  if (matches.length !== 1) throw new Error(matches.length ? `“${query}” 匹配到多个现场包，请写长一些` : `本机没有 ${query}，先运行 npm.cmd run issues:pull`);
  return path.join(folder, matches[0]);
}

function localSource(file, line) {
  const relative = String(file).replace(/\\/g, "/").replace(/^.*?((?:content_engine|src\/main|src\/shared|rpa)\/.*)$/, "$1");
  for (const root of SOURCE_ROOTS) {
    const candidate = path.join(root, relative);
    if (!fs.existsSync(candidate)) continue;
    const lines = fs.readFileSync(candidate, "utf8").split(/\r?\n/);
    return { path: path.relative(path.resolve(repo, ".."), candidate).replace(/\\/g, "/"),
      snippet: lines.slice(Math.max(0, line - 3), line + 2).map((text, index) => `${String(Math.max(1, line - 2) + index).padStart(5)}${Math.max(1, line - 2) + index === line ? ">" : " "} ${text}`).join("\n") };
  }
  return null;
}

function show(directory) {
  const { capsule, client, evidence = [] } = JSON.parse(fs.readFileSync(path.join(directory, "capsule.json"), "utf8"));
  const out = [];
  out.push(`${capsule.module} · ${capsule.code}  （${capsule.source}，发生 ${capsule.occurrences} 次）`,
    `版本 ${client.version}  电脑 ${client.installId}  首次 ${capsule.createdAt}  最近 ${capsule.lastSeenAt}`);
  if (capsule.taskId || Object.keys(capsule.context || {}).length) out.push(`任务 ${capsule.taskId || "—"} ${JSON.stringify(capsule.context || {})}`);
  if (capsule.where) out.push(`位置 ${capsule.where}`);
  if (capsule.message) out.push("", "客户看到：", capsule.message);
  if (Object.keys(capsule.details || {}).length) out.push("", "测量与细节：", JSON.stringify(capsule.details, null, 2));
  const replay = REPLAYS[capsule.code]?.(capsule.details || {});
  if (replay) out.push("", "用当前代码的规则重判：", JSON.stringify(replay, null, 2));
  if (capsule.traceback) {
    out.push("", "堆栈：", capsule.traceback.trim());
    const frames = [...capsule.traceback.matchAll(/File "([^"]+)", line (\d+)/g), ...capsule.traceback.matchAll(/\(?([^()\s]+\.c?js):(\d+):\d+\)?/g)];
    for (const [, file, line] of frames.slice(-3)) {
      const source = localSource(file, Number(line));
      if (source) out.push("", `本地源码 ${source.path}（今天的代码，行号可能已移动）：`, source.snippet);
    }
  }
  if (capsule.engineStderr) out.push("", "视频引擎输出尾部：", capsule.engineStderr.trim().slice(-1500));
  const steps = capsule.breadcrumbs || [];
  if (steps.length) {
    out.push("", `出错前的步骤（${steps.length}）：`);
    for (const row of steps.slice(-25)) out.push(`  ${String(row.ts).slice(11, 23)} ${row.level.padEnd(5)} ${row.module}.${row.event}${row.code ? ` [${row.code}]` : ""}${row.phase ? ` (${row.phase})` : ""}`);
  }
  if (capsule.environment && Object.keys(capsule.environment).length) out.push("", "环境：", JSON.stringify(capsule.environment));
  if (evidence.length) out.push("", "截图：", ...evidence.map(id => `  ${path.join(directory, `${id}.png`)}`));
  return out.join("\n");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--out");
  const out = index >= 0 ? args[index + 1] : DEFAULT_OUT;
  const query = args.find((value, position) => !value.startsWith("--") && position !== index + 1);
  try { console.log(show(find(out, query || ""))); }
  catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { show, find, REPLAYS };
