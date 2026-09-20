const { spawnSync } = require("node:child_process");
const catalog = require("../src/shared/wechat-rule-catalog.json");
const { workflowPolicies } = require("../src/shared/wechat-failure-policy.cjs");

const knownReasons = new Set([...catalog.map((row) => row.reason), ...Object.keys(workflowPolicies)]);
const patterns = [
  /(?:blocked_reason|reasonCode|reason)\s*[:=]\s*["']([a-z][a-z0-9_]{1,79})["']/g,
  /\b(?:failure|blocked)\s*\(\s*["']([a-z][a-z0-9_]{1,79})["']/g,
  /\b(?:response|result)\s*\(\s*["'][^"']*["']\s*,\s*["']([a-z][a-z0-9_]{1,79})["']/g,
  /\bsafeReason\s*\(\s*[^,\n]+,\s*["']([a-z][a-z0-9_]{1,79})["']/g,
  /\battention\s*\([^;\n]*,\s*["']([a-z][a-z0-9_]{1,79})["']\s*\)/g,
  /Write-XiaoxiFailure\s+["'][a-z0-9.-]+["']\s+["']([a-z][a-z0-9_]{1,79})["']/g
];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// These literals are intentionally not failure policies: one is a successful
// scheduler event and the other is the reserved fail-closed unknown sentinel.
const nonFailureReasonLiterals = new Set(["failed", "finite_tasks_drained", "idle", "invalid_unclassified_reason"]);

function unclassifiedAddedReasons(diff) {
  const found = new Set();
  for (const line of String(diff).split(/\r?\n/u)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        if (!knownReasons.has(match[1]) && !nonFailureReasonLiterals.has(match[1])) found.add(match[1]);
      }
    }
  }
  return [...found].sort();
}

function gitDiff(base, options = {}) {
  const paths = ["desktop/rpa/active_touch", "desktop/src/main", "desktop/src/shared", ":(exclude)**/*.self_check.cjs"];
  const cwd = options.cwd || require("node:path").resolve(__dirname, "../..");
  const run = (args) => {
    // A pull request against an older base can legitimately produce more than
    // Node's 1 MiB spawnSync default. Keep the policy gate intact for that full
    // diff instead of failing before the added reason codes can be inspected.
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} exited with status ${result.status}`);
    }
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
  const eventBase = String(process.env.XIAOXI_FAILURE_POLICY_BASE || "");
  const base = baseIndex >= 0
    ? process.argv[baseIndex + 1]
    : (/^0{40}$/u.test(eventBase) ? EMPTY_TREE : (/^[a-f0-9]{40}$/iu.test(eventBase) ? eventBase : ""));
  const missing = unclassifiedAddedReasons(gitDiff(base));
  if (missing.length) {
    console.error(`Unclassified added WeChat failure reasons:\n${missing.join("\n")}`);
    process.exitCode = 1;
  } else console.log("WeChat failure policy review passed: every added literal reason is classified");
}

module.exports = { gitDiff, unclassifiedAddedReasons };
