// Local acceptance backup: one complete running application plus business data.
// Never copy every downloaded generation/helper runtime as part of user data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { backupFilter, copyProfile, copyBytes, checkCopySpace, createOwnedDirectory, removeOwnedDirectory } = require("../src/main/update-storage.cjs");
const { dataInventory, registerSet, readRegistry, verifySet } = require("../src/main/update-backups.cjs");
const { inventory } = require("../src/main/update-program-backup.cjs");
const { HEX, digest } = require("../src/shared/component-contract.cjs");

async function backupLocalInstall({ program, profile, outputRoot }) {
  program = fs.realpathSync(program); profile = fs.realpathSync(profile);
  const installedRoot = program;
  outputRoot = path.resolve(outputRoot);
  if (outputRoot === path.parse(outputRoot).root || [program, profile].some(root => outputRoot === root || outputRoot.startsWith(root + path.sep))) throw Error("backup_destination_invalid");
  const components = path.join(profile, "data/cloud-maintenance/components");
  const selectionFile = path.join(components, "selection.json");
  const selection = fs.existsSync(selectionFile) ? JSON.parse(fs.readFileSync(selectionFile, "utf8")) : {};
  if (fs.existsSync(selectionFile)) {
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
  const programFiles = await inventory(program), dataFiles = await dataInventory(profile, filter);
  for (const previous of [...readRegistry(profile).sets].reverse()) {
    if (previous.state === "retiring" || previous.kind !== "manual"
        || JSON.stringify(previous.programBackup.files) !== JSON.stringify(programFiles)
        || JSON.stringify(previous.programBackup.selection) !== JSON.stringify(selection)
        || JSON.stringify(previous.data.files) !== JSON.stringify(dataFiles)) continue;
    try {
      await verifySet(previous);
      if (JSON.stringify(dataFiles) !== JSON.stringify(await dataInventory(profile, filter))) throw Error("update_backup_source_changed");
      return { directory: path.dirname(previous.programBackup.program), version, reused: true, id: previous.id };
    } catch (error) { if (error.message === "update_backup_source_changed") throw error; }
  }
  await checkCopySpace([{ path: outputRoot, bytes: await copyBytes(program) + await copyBytes(profile, filter) }]);
  const owned = await createOwnedDirectory(outputRoot, crypto.randomUUID());
  try {
    if ([program, profile].some(root => owned.parent === root || owned.parent.startsWith(root + path.sep))) throw Error("backup_destination_invalid");
    if (process.platform === "win32") {
      const account = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
      execFileSync("icacls.exe", [owned.directory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { stdio: "ignore", windowsHide: true });
    }
    await fs.promises.cp(program, path.join(owned.directory, "program"), { recursive: true, errorOnExist: true, force: false });
    await copyProfile(profile, path.join(owned.directory, "userData"), filter);
    if (JSON.stringify(dataFiles) !== JSON.stringify(await dataInventory(profile, filter))) throw Error("update_backup_source_changed");
    fs.writeFileSync(path.join(owned.directory, "backup.json"), JSON.stringify({ version, createdAt: new Date().toISOString(), programSource: program, profileSource: profile, updateCachesExcluded: true, selection }, null, 2));
    const id = path.basename(owned.directory);
    await registerSet(profile, { id, version, kind: "manual", owners: [owned],
      programBackup: { installedRoot, program: path.join(owned.directory, "program"), selection, files: programFiles },
      data: { directory: path.join(owned.directory, "userData"), files: dataFiles } });
    return { directory: owned.directory, version, id };
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
