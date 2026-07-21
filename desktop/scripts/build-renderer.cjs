const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const requested = process.argv[2] || "delivery";
if (!["test", "delivery"].includes(requested)) throw new Error(`Unsupported renderer edition: ${requested}`);
const edition = requested === "test" ? "development" : "pilot";
const buildId = process.env.XIAOXI_BUILD_ID || new Date().toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";
const viteCli = path.join(path.dirname(require.resolve("vite")), "bin", "vite.js");
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

if (result.status) process.exit(result.status);

const outputDir = path.join(__dirname, "..", edition === "development" ? "dist-development" : edition === "pilot" ? "dist-pilot" : "dist");
fs.writeFileSync(path.join(outputDir, "build-edition.json"), `${JSON.stringify({ edition, buildId }, null, 2)}\n`);
console.log(`${requested === "test" ? "test" : "delivery"} renderer build completed`);
