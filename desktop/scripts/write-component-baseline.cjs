const fs = require("node:fs");
const path = require("node:path");
const { buildComponentRelease } = require("./build-component-release.cjs");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
async function main() {
  const [sourceRoot, outputDir] = process.argv.slice(2);
  const source = JSON.parse(fs.readFileSync(path.join(sourceRoot, "版本清单.json"), "utf8"));
  const config = cloudConfig({ developmentEdition: true });
  const built = await buildComponentRelease({ sourceRoot, outputDir, version: source.version, baseVersion: require("../package.json").componentBaseVersion,
    appId: config.appId, channel: config.channel, buildCommit: source.commit });
  fs.writeFileSync(path.join(sourceRoot, "component-base.json"), JSON.stringify(built.baseline));
  console.log(JSON.stringify({ metadata: built.metadataFile, componentBytes: built.artifacts.reduce((sum, artifact) => sum + artifact.size, 0) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
