// Reuse only a successful PR's actual synthetic merge checkout, never its head
// label alone. GitHub commit trees bind every tracked file, including CI/tests.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { requiredCiJobs } = require("./self-check-groups.cjs");
const root = path.resolve(__dirname, "../..");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const workflow = ".github/workflows/ci.yml";

function completeSourceJobs(jobs) {
  return requiredCiJobs.every(name => {
    const matches = jobs?.filter(job => job.name === name);
    return matches?.length === 1 && matches[0].conclusion === "success";
  }) && jobs.some(job => job.name === "service-and-content" && job.steps?.some(step =>
    step.name === "Product detail local E2E" && step.conclusion === "success"));
}

function command(execute, tool, args) {
  const result = execute(tool, args, { cwd: root, encoding: "utf8", windowsHide: true,
    timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw Error("CI proof query failed");
  return result.stdout.trim();
}

function mergedSourceProof({ commit, repository, execute = spawnSync }) {
  let temporary;
  try {
    if (!sha(commit) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return null;
    const api = suffix => JSON.parse(command(execute, "gh", ["api", `repos/${repository}/${suffix}`]));
    const target = api(`git/commits/${commit}`);
    if (target.sha !== commit || !sha(target.tree?.sha) || !sha(target.parents?.[0]?.sha)) return null;
    const pulls = api(`commits/${commit}/pulls?per_page=100`);
    const pr = pulls.find(pr => pr.merged_at && pr.merge_commit_sha === commit && pr.base?.ref === "main"
      && pr.base.repo?.full_name === repository && pr.head?.repo?.full_name === repository && sha(pr.head.sha));
    if (!pr || !Number.isSafeInteger(pr.number)) return null;
    const runs = JSON.parse(command(execute, "gh", ["run", "list", "--repo", repository, "--commit", pr.head.sha,
      "--workflow", "Windows CI", "--event", "pull_request", "--limit", "10", "--json", "databaseId,headSha,conclusion,event"]));
    for (const candidate of runs) {
      if (candidate.headSha !== pr.head.sha || candidate.event !== "pull_request" || candidate.conclusion !== "success"
          || !Number.isSafeInteger(candidate.databaseId)) continue;
      const run = api(`actions/runs/${candidate.databaseId}`);
      if (run.id !== candidate.databaseId || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
          || run.head_sha !== pr.head.sha || run.event !== "pull_request" || run.path !== workflow
          || run.status !== "completed" || run.conclusion !== "success" || !Number.isSafeInteger(run.run_attempt)) continue;
      const jobs = api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      if (jobs.total_count !== jobs.jobs?.length || !completeSourceJobs(jobs.jobs)) continue;
      const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`);
      const name = `source-ci-proof-${run.run_attempt}`;
      const matching = artifacts.artifacts?.filter(artifact => artifact.name === name && !artifact.expired);
      if (artifacts.total_count !== artifacts.artifacts?.length || matching?.length !== 1) continue;
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), "source-ci-proof-"));
      command(execute, "gh", ["run", "download", String(run.id), "--repo", repository, "--name", name, "--dir", temporary]);
      const file = path.join(temporary, "ci-source-proof.json");
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 4096) return null;
      const proof = JSON.parse(fs.readFileSync(file, "utf8"));
      if (proof.schema !== 1 || proof.repository !== repository || proof.runId !== run.id || proof.attempt !== run.run_attempt
          || proof.pullRequest !== pr.number || proof.head !== pr.head.sha || proof.base !== target.parents[0].sha
          || proof.tree !== target.tree.sha || !sha(proof.commit)) return null;
      // Independently verify GitHub's immutable commit object, not just JSON
      // reported by a run. It must be precisely the tested base+head merge.
      const tested = api(`git/commits/${proof.commit}`);
      if (tested.sha !== proof.commit || tested.tree?.sha !== proof.tree || tested.parents?.length !== 2
          || tested.parents[0].sha !== proof.base || tested.parents[1].sha !== proof.head) return null;
      return { sourceRunId: run.id, sourceCommit: proof.commit, tree: proof.tree, pullRequest: pr.number };
    }
  } catch { /* Missing, expired, ambiguous, unavailable: run the complete CI. */ }
  finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  return null;
}

function writeSourceProof(environment = process.env) {
  const event = JSON.parse(fs.readFileSync(environment.GITHUB_EVENT_PATH, "utf8"));
  if (environment.GITHUB_EVENT_NAME !== "pull_request") throw Error("Only PR source checks can produce reusable evidence");
  const proof = { schema: 1, repository: environment.GITHUB_REPOSITORY, runId: Number(environment.GITHUB_RUN_ID),
    attempt: Number(environment.GITHUB_RUN_ATTEMPT), pullRequest: event.number,
    head: event.pull_request.head.sha, base: event.pull_request.base.sha,
    commit: command(spawnSync, "git", ["rev-parse", "HEAD"]),
    tree: command(spawnSync, "git", ["rev-parse", "HEAD^{tree}"]) };
  if (proof.commit !== environment.GITHUB_SHA || ![proof.head, proof.base, proof.commit, proof.tree].every(sha)) {
    throw Error("Source checkout is not the expected PR merge");
  }
  fs.mkdirSync(path.join(root, "desktop/.build"), { recursive: true });
  fs.writeFileSync(path.join(root, "desktop/.build/ci-source-proof.json"), JSON.stringify(proof));
}

if (require.main === module) {
  if (process.argv[2] === "--write") writeSourceProof();
  else if (process.argv[2] === "--reuse") {
    const proof = mergedSourceProof({ commit: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${Boolean(proof)}\n`);
    console.log(proof ? JSON.stringify(proof) : "No complete identical-tree PR evidence; running all required checks.");
  } else throw Error("Expected --write or --reuse");
}
module.exports = { completeSourceJobs, mergedSourceProof };
