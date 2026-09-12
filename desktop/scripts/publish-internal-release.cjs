const path = require("node:path");

function publication(args) {
  if (args[0] === "--full") {
    const [installer, manifestFile, notesFile, ...extra] = args.slice(1);
    if (!installer || !manifestFile || extra.length) throw new Error("Use --full <installer.exe> <version-manifest.json> [notes.txt]");
    return { kind: "full", options: { installer, manifestFile, notesFile } };
  }
  const [metadataFile = path.resolve(__dirname, "../../release/components/test/unsigned-component-release.json"), notesFile, ...extra] = args;
  if (extra.length || metadataFile.startsWith("--") || !metadataFile.endsWith(".json")) {
    throw new Error("Internal publication defaults to components: [unsigned-component-release.json] [notes.txt]. A full installer requires --full.");
  }
  return { kind: "components", options: { metadataFile, notesFile } };
}

async function main(args = process.argv.slice(2)) {
  const request = publication(args);
  if (request.kind === "full") await require("./publish-cloud-release.cjs").publish(request.options);
  else console.log(await require("./publish-component-release.cjs").publishComponentRelease(request.options));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { publication };
