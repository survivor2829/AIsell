// Explicit internal-test preparation entrypoint. Wait for the existing main
// CI rather than starting duplicate local checks while that CI is still running.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const root = path.resolve(__dirname, "../..");
const options = { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 };

async function waitForCi(commit, { execute = spawnSync, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, timeout = 15 * 60_000 } = {}) {
  const started = now();
  while (now() - started < timeout) {
    const result = execute("gh", ["run", "list", "--commit", commit, "--workflow", "Windows CI", "--limit", "10",
      "--json", "databaseId,headSha,event,status,conclusion"], options);
    if (result.status !== 0) throw Error("Cannot verify main CI; no build started");
    const run = JSON.parse(result.stdout).find(run => run.headSha === commit && ["push", "workflow_dispatch"].includes(run.event));
    if (run?.status === "completed") {
      if (run.conclusion !== "success") throw Error("Main CI did not succeed; no build started");
      return run.databaseId;
    }
    await sleep(10000);
  }
  throw Error("Timed out waiting for the existing main CI; no duplicate checks started");
}

async function main() {
  if (process.argv.length > 2) throw Error("This command prepares internal test only and accepts no arguments");
  const git = args => {
    const result = spawnSync("git", args, options);
    if (result.status !== 0) throw Error("Cannot verify release checkout");
    return result.stdout.trim();
  };
  const commit = git(["rev-parse", "HEAD"]);
  const assertSource = () => {
    if (git(["branch", "--show-current"]) !== "main" || git(["status", "--porcelain", "--untracked-files=all"])
        || git(["rev-parse", "HEAD"]) !== commit) throw Error("Release pipeline requires the same clean main throughout");
  };
  assertSource();
  const version = require("../package.json").version, started = performance.now();
  const record = { schema: 1, version, commit, startedAt: new Date().toISOString(), stages: [], state: "running" };
  const file = path.join(root, "desktop/.build", `internal-release-pipeline-${version}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const save = () => { record.elapsedMs = performance.now() - started; fs.writeFileSync(file, JSON.stringify(record, null, 2)); };
  async function stage(name, work) {
    const before = performance.now();
    const entry = { name, startedAt: new Date().toISOString(), state: "running" }; record.stages.push(entry); save();
    try { const result = await work(); entry.state = "complete"; return result; }
    catch (error) { entry.state = "failed"; throw error; }
    finally { entry.elapsedMs = performance.now() - before; save(); }
  }
  const run = (script, args = []) => {
    assertSource();
    const result = spawnSync(process.execPath, [path.join(__dirname, script), "--default-components", ...args],
      { cwd: path.join(root, "desktop"), windowsHide: true, stdio: "inherit" });
    if (result.status !== 0) throw Error(`${script} failed; preserve its evidence before retrying`);
  };
  try {
    record.mainRunId = await stage("wait-existing-ci", () => waitForCi(commit));
    assertSource();
    await stage("build-and-validate", () => run("build-internal-release.cjs", ["--require-ci"]));
    record.ciProof = JSON.parse(fs.readFileSync(path.join(root, "desktop/.build/internal-release-test-components.json"), "utf8")).ciProof;
    record.state = "candidate-ready";
    console.log(`Candidate ready for local acceptance. Publish the same artifact after acceptance with publish:internal. Timing: ${file}`);
  } catch (error) { record.state = "failed"; record.error = error.message; throw error; }
  finally { save(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { waitForCi };
