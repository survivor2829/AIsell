const { spawnSync } = require("node:child_process");
const catalog = require("../src/shared/wechat-rule-catalog.json");
const { workflowPolicies } = require("../src/shared/wechat-failure-policy.cjs");

const knownReasons = new Set([...catalog.map((row) => row.reason), ...Object.keys(workflowPolicies)]);
const patterns = [
  /(?:blocked_reason|reasonCode)\s*[:=]\s*["']([a-z][a-z0-9_]{1,79})["']/g,
  /Write-XiaoxiFailure\s+["'][a-z0-9.-]+["']\s+["']([a-z][a-z0-9_]{1,79})["']/g
];

function unclassifiedAddedReasons(diff) {
  const found = new Set();
  for (const line of String(diff).split(/\r?\n/u)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) if (!knownReasons.has(match[1])) found.add(match[1]);
    }
  }
  return [...found].sort();
}

function gitDiff(base) {
  const paths = ["desktop/rpa/active_touch", "desktop/src/main", "desktop/src/shared", ":(exclude)**/*.self_check.cjs"];
  const cwd = require("node:path").resolve(__dirname, "../..");
  const run = (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || "git diff failed");
    return result.stdout;
  };
  if (base) return run(["diff", base, "--", ...paths]);
  const staged = run(["diff", "--cached", "--", ...paths]);
  if (staged.trim()) return staged;
  const working = run(["diff", "HEAD", "--", ...paths]);
  return working.trim() ? working : run(["diff", "HEAD^", "HEAD", "--", ...paths]);
}

if (require.main === module) {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : "";
  const missing = unclassifiedAddedReasons(gitDiff(base));
  if (missing.length) {
    console.error(`Unclassified added WeChat failure reasons:\n${missing.join("\n")}`);
    process.exitCode = 1;
  } else console.log("WeChat failure policy review passed: every added literal reason is classified");
}

module.exports = { unclassifiedAddedReasons };
