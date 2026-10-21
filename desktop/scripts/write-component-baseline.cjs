const fs = require("node:fs");
const path = require("node:path");
const { buildComponentRelease, buildComponentBaseline } = require("./build-component-release.cjs");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
async function main() {
  const args = process.argv.slice(2), baselineOnly = args.at(-1) === "--baseline-only";
  if (baselineOnly) args.pop();
  const [sourceRoot, outputDir, inventoryFile, ...extra] = args;
  if (!sourceRoot || !outputDir || extra.length) throw Error("Use <source-root> <output-dir> [inventory-file] [--baseline-only]");
  return require("./release-tree-hash.cjs").immutableHashScope(sourceRoot, async () => {
  if (inventoryFile) require("./release-tree-hash.cjs").primeHashInventory(JSON.parse(fs.readFileSync(inventoryFile, "utf8")), sourceRoot);
  const source = JSON.parse(fs.readFileSync(path.join(sourceRoot, "版本清单.json"), "utf8"));
  const baseVersion = require("../package.json").componentBaseVersion;
  let baseline, built;
  if (baselineOnly) baseline = await buildComponentBaseline({ sourceRoot, baseVersion });
  else {
    const config = cloudConfig({ developmentEdition: true });
    built = await buildComponentRelease({ sourceRoot, outputDir, version: source.version, baseVersion,
      appId: config.appId, channel: config.channel, buildCommit: source.commit });
    baseline = built.baseline;
  }
  fs.writeFileSync(path.join(sourceRoot, "component-base.json"), JSON.stringify(baseline));
  console.log(JSON.stringify({ metadata: built?.metadataFile || null, componentBytes: built?.artifacts.reduce((sum, artifact) => sum + artifact.size, 0) || 0 }));
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
