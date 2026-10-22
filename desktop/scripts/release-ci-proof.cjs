const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { requiredCiJobs } = require("./self-check-groups.cjs");
const { completeSourceJobs, mergedSourceProof } = require("./ci-source-proof.cjs");

// A main run may reuse the actual identical merge tree tested by a PR. Verify
// that chain independently; a successful summary or skipped jobs alone is not proof.
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
      if (candidate.headSha !== sha || candidate.conclusion !== "success" || !["push", "workflow_dispatch"].includes(candidate.event)
          || !Number.isSafeInteger(candidate.databaseId)) continue;
      const detail = execute("gh", ["run", "view", String(candidate.databaseId), "--json", "headSha,conclusion,jobs"], options);
      if (detail.status !== 0) continue;
      const run = JSON.parse(detail.stdout);
      if (run.headSha !== sha || run.conclusion !== "success") continue;
      if (completeSourceJobs(run.jobs)) return { commit: sha, runId: candidate.databaseId };
      const single = name => { const jobs = run.jobs?.filter(job => job.name === name); return jobs?.length === 1 ? jobs[0] : null; };
      const groups = requiredCiJobs.filter(name => name.startsWith("source-") && name !== "source-and-renderer");
      // Actions evaluates a job-level if before expanding its matrix. A wholly
      // skipped matrix is one literal-name job rather than five skipped jobs.
      const skippedGroups = groups.every(name => single(name)?.conclusion === "skipped")
        || single("source-${{ matrix.group }}")?.conclusion === "skipped" && groups.every(name => !run.jobs.some(job => job.name === name));
      if (candidate.event !== "push" || single("ci-source-proof")?.conclusion !== "success"
          || single("source-and-renderer")?.conclusion !== "success"
          || !single("ci-source-proof").steps?.some(step => step.name === "Verify unchanged merge tree and required CI" && step.conclusion === "success")
          || !skippedGroups || single("service-and-content")?.conclusion !== "skipped") continue;
      const repositoryResult = execute("gh", ["repo", "view", "--json", "nameWithOwner"], options);
      if (repositoryResult.status !== 0) continue;
      const repository = JSON.parse(repositoryResult.stdout).nameWithOwner;
      const proof = mergedSourceProof({ commit: sha, repository, execute });
      if (proof) return { commit: sha, runId: candidate.databaseId, ...proof };
    }
  } catch { /* Missing CLI, network failure or malformed response: run locally. */ }
  return null;
}
module.exports = { verifiedCiRun };
