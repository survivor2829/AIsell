const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const edition = process.argv[2] === "development" ? "development" : "customer";
const viteCli = path.join(path.dirname(require.resolve("vite")), "bin", "vite.js");
const result = spawnSync(process.execPath, [viteCli, "build"], {
  stdio: "inherit",
  env: { ...process.env, VITE_XIAOXI_EDITION: edition, XIAOXI_EDITION: edition }
});

if (result.status) process.exit(result.status);

const outputDir = path.join(__dirname, "..", edition === "development" ? "dist-development" : "dist");
fs.writeFileSync(path.join(outputDir, "build-edition.json"), `${JSON.stringify({ edition }, null, 2)}\n`);
console.log(`${edition} renderer build completed`);
