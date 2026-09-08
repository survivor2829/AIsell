const path = require("node:path");
const { loadBuildConfig, assertCleanSource } = require("./build-internal-release.cjs");
const { runRelease } = require("./run-release.cjs");
process.chdir(path.resolve(__dirname, ".."));
try {
  loadBuildConfig(process.argv[2] || ".build/internal-release-config.json");
  assertCleanSource();
  runRelease("test", process.env, { componentsOnly: true });
  console.log("Component release is ready for internal publication; the full installer and v1 channel remain unchanged.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
