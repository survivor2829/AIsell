// Local acceptance backup: one complete running application plus business data.
// Never copy every downloaded generation/helper runtime as part of user data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { backupFilter, copyBytes, checkCopySpace, createOwnedDirectory, removeOwnedDirectory } = require("../src/main/update-storage.cjs");
const { retainArtifacts } = require("./artifact-retention.cjs");
const { HEX, digest } = require("../src/shared/component-contract.cjs");

async function backupLocalInstall({ program, profile, outputRoot }) {
  program = fs.realpathSync(program); profile = fs.realpathSync(profile);
  outputRoot = path.resolve(outputRoot);
  if (outputRoot === path.parse(outputRoot).root || [program, profile].some(root => outputRoot === root || outputRoot.startsWith(root + path.sep))) throw Error("backup_destination_invalid");
  const components = path.join(profile, "data/cloud-maintenance/components");
  const selectionFile = path.join(components, "selection.json");
  if (fs.existsSync(selectionFile)) {
    const selection = JSON.parse(fs.readFileSync(selectionFile, "utf8"));
    if (selection.pending) throw Error("backup_update_in_progress");
    if (selection.active) {
      if (!HEX.test(selection.active)) throw Error("backup_selection_invalid");
      program = fs.realpathSync(path.join(components, "generations", selection.active));
      const envelope = JSON.parse(fs.readFileSync(path.join(program, "component-complete.json"), "utf8"));
      if (digest(envelope.payload) !== selection.active) throw Error("backup_selection_invalid");
    }
  }
  const version = JSON.parse(fs.readFileSync(path.join(program, "版本清单.json"), "utf8")).version;
  if (!fs.existsSync(path.join(program, "resources/app/src/main/main.cjs"))) throw Error("backup_program_incomplete");
  const filter = backupFilter(profile);
  await checkCopySpace([{ path: outputRoot, bytes: await copyBytes(program) + await copyBytes(profile, filter) }]);
  const owned = await createOwnedDirectory(outputRoot, crypto.randomUUID());
  try {
    if ([program, profile].some(root => owned.parent === root || owned.parent.startsWith(root + path.sep))) throw Error("backup_destination_invalid");
    if (process.platform === "win32") {
      const account = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
      execFileSync("icacls.exe", [owned.directory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { stdio: "ignore", windowsHide: true });
    }
    await fs.promises.cp(program, path.join(owned.directory, "program"), { recursive: true, errorOnExist: true, force: false });
    await fs.promises.cp(profile, path.join(owned.directory, "userData"), { recursive: true, errorOnExist: true, force: false, filter });
    fs.writeFileSync(path.join(owned.directory, "backup.json"), JSON.stringify({ version, createdAt: new Date().toISOString(), programSource: program, profileSource: profile, updateCachesExcluded: true }, null, 2));
    retainArtifacts(owned.parent, "local-install-backups", [owned.directory], 2);
    return { directory: owned.directory, version };
  } catch (error) {
    await removeOwnedDirectory(owned).catch(cleanup => { error.cleanupCode = cleanup.code || cleanup.message; });
    throw error;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { "--program": "program", "--profile": "profile", "--output-root": "outputRoot" }[args[index]];
    if (!key || !args[index + 1]) throw Error("Usage: backup-local-install --program <installed-directory> --profile <user-data> --output-root <backup-directory>");
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== 3) throw Error("program, profile and output-root are required");
  backupLocalInstall(options).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { backupLocalInstall };
