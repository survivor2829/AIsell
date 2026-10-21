const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Fail closed: an old, skipped, PR-head or incomplete workflow cannot replace
// checks for the exact release revision. Artifact checks always run separately.
function verifiedCiRun({ forceChecks = false, execute = spawnSync } = {}) {
  if (forceChecks) return null;
  const options = { cwd: path.resolve(__dirname, "../.."), encoding: "utf8", windowsHide: true, timeout: 30000 };
  try {
    const state = execute("git", ["status", "--porcelain", "--untracked-files=all"], options);
    const head = execute("git", ["rev-parse", "HEAD"], options);
    const sha = head.stdout?.trim();
    if (state.status !== 0 || state.stdout.trim() || head.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) return null;
    const list = execute("gh", ["run", "list", "--commit", sha, "--workflow", "Windows CI", "--limit", "20",
      "--json", "databaseId,headSha,conclusion,event"], options);
    if (list.status !== 0) return null;
    for (const candidate of JSON.parse(list.stdout)) {
      if (candidate.headSha !== sha || candidate.conclusion !== "success" || candidate.event !== "push"
          || !Number.isSafeInteger(candidate.databaseId)) continue;
      const detail = execute("gh", ["run", "view", String(candidate.databaseId), "--json", "headSha,conclusion,jobs"], options);
      if (detail.status !== 0) continue;
      const run = JSON.parse(detail.stdout);
      if (run.headSha !== sha || run.conclusion !== "success") continue;
      if (!["source-and-renderer", "service-and-content"].every(name => run.jobs?.some(job =>
        job.name === name && job.conclusion === "success"))) continue;
      if (!run.jobs.some(job => job.conclusion === "success" && job.steps?.some(step =>
        step.name === "Product detail local E2E" && step.conclusion === "success"))) continue;
      return { commit: sha, runId: candidate.databaseId };
    }
  } catch { /* Missing CLI, network failure or malformed response: run locally. */ }
  return null;
}
module.exports = { verifiedCiRun };
