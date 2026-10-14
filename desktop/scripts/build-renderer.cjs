const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const requested = process.argv[2] || "delivery";
if (!["test", "delivery"].includes(requested)) throw new Error(`Unsupported renderer edition: ${requested}`);
const edition = requested === "test" ? "development" : "pilot";
const buildId = process.env.XIAOXI_BUILD_ID || new Date().toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";
const gitCommitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, "..", ".."), encoding: "utf8", windowsHide: true });
const gitStatusResult = spawnSync("git", ["status", "--porcelain"], { cwd: path.join(__dirname, "..", ".."), encoding: "utf8", windowsHide: true });
const buildCommit = String(process.env.XIAOXI_BUILD_COMMIT || gitCommitResult.stdout || "").trim();
const sourceDirty = gitStatusResult.status !== 0 || Boolean(String(gitStatusResult.stdout || "").trim());
const viteCli = path.join(path.dirname(require.resolve("vite")), "bin", "vite.js");
const outputDir = path.join(__dirname, "..", edition === "development" ? "dist-development" : "dist-pilot");
const space = require("./space-usage.cjs").startSpaceRun("renderer", [outputDir]);
const result = spawnSync(process.execPath, [viteCli, "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_XIAOXI_EDITION: edition,
    VITE_XIAOXI_BUILD_ID: buildId,
    XIAOXI_EDITION: edition,
    XIAOXI_BUILD_ID: buildId
  }
});

if (result.status !== 0) {
  console.error(result.error?.message || `Renderer build failed (${result.signal || result.status})`);
  space.finish("failed");
  process.exit(result.status || 1);
}

space.observe("build-complete");
fs.writeFileSync(path.join(outputDir, "build-edition.json"), `${JSON.stringify({ edition, buildId, buildCommit, sourceDirty }, null, 2)}\n`);
space.observe("cleanup-complete", { policy: "Vite replaces its own output; no separate staging copy." });
space.finish("completed");
console.log(`${requested === "test" ? "test" : "delivery"} renderer build completed`);
