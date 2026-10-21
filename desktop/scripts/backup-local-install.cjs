// Local acceptance backup: one complete running application plus business data.
// Never copy every downloaded generation/helper runtime as part of user data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { backupFilter, metadataInventory, copySnapshot, checkCopySpace, createOwnedDirectory, removeOwnedDirectory } = require("../src/main/update-storage.cjs");
const { registerSet, readRegistry, verifySet } = require("../src/main/update-backups.cjs");
const { programIdentity } = require("../src/main/update-program-backup.cjs");
const { HEX, digest } = require("../src/shared/component-contract.cjs");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function backupLocalInstall({ program, profile, outputRoot, purpose = "manual", updateKind = "full" }) {
  if (!["manual", "acceptance"].includes(purpose) || !["full", "components"].includes(updateKind)) throw Error("backup_purpose_invalid");
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
  if (purpose === "acceptance" && updateKind === "components") {
    // Same dataSchema is enforced by the component updater. Its active/previous
    // pointers are the rollback, not another full copy of customer media.
    return { kind: "component-selection", version, installedRoot, program, selection,
      copiedBytes: 0, reused: true, note: "Component updater retains the prior program; no data migration." };
  }
  const filter = backupFilter(profile);
  const programMetadata = await metadataInventory(program), dataMetadata = await metadataInventory(profile, filter);
  if (programMetadata.some(file => file.link)) throw Error("update_program_link_unsupported");
  const identity = await programIdentity(program, selection);
  const sourceUnchanged = async () => {
    if (!same(programMetadata, await metadataInventory(program))
        || !same(dataMetadata, await metadataInventory(profile, filter))) throw Error("update_backup_source_changed");
  };
  const candidates = [...readRegistry(profile).sets].reverse().filter(previous => previous.state !== "retiring"
    && previous.kind === purpose && same(previous.programBackup.selection, selection));
  const reused = previous => ({ directory: path.dirname(previous.programBackup.program), version, reused: true, id: previous.id });
  for (const previous of candidates) {
    if (!same(previous.programBackup.sourceMetadata, programMetadata)
        || previous.programBackup.programIdentity !== identity
        || !same(previous.data.sourceMetadata, dataMetadata)) continue;
    try {
      await verifySet(previous);
      await sourceUnchanged();
      return reused(previous);
    } catch (error) { if (error.message === "update_backup_source_changed") throw error; }
  }
  await checkCopySpace([{ path: outputRoot, bytes: [...programMetadata, ...dataMetadata].reduce((sum, file) => sum + (file.size || 0), 0) }]);
  const owned = await createOwnedDirectory(outputRoot, crypto.randomUUID());
  try {
    if ([program, profile].some(root => owned.parent === root || owned.parent.startsWith(root + path.sep))) throw Error("backup_destination_invalid");
    if (process.platform === "win32") {
      const account = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
      execFileSync("icacls.exe", [owned.directory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { stdio: "ignore", windowsHide: true });
    }
    const programCopy = await copySnapshot(program, path.join(owned.directory, "program"), programMetadata, undefined, { allowLinks: false });
    const dataCopy = await copySnapshot(profile, path.join(owned.directory, "userData"), dataMetadata, filter);
    await sourceUnchanged();
    // Historical receipts may lack source metadata. Compare the one copied
    // inventory, then verify the retained backup before discarding only our copy.
    for (const previous of candidates) {
      if (!same(previous.programBackup.files, programCopy.files) || !same(previous.data.files, dataCopy.files)) continue;
      try { await verifySet(previous); }
      catch { continue; }
      await sourceUnchanged();
      await removeOwnedDirectory(owned);
      return reused(previous);
    }
    fs.writeFileSync(path.join(owned.directory, "backup.json"), JSON.stringify({ version, createdAt: new Date().toISOString(), programSource: program, profileSource: profile, updateCachesExcluded: true, selection }, null, 2));
    const id = path.basename(owned.directory);
    await registerSet(profile, { id, version, kind: purpose, owners: [owned],
      programBackup: { installedRoot, program: path.join(owned.directory, "program"), selection,
        ...programCopy, programIdentity: identity },
      data: { directory: path.join(owned.directory, "userData"), ...dataCopy } });
    return { directory: owned.directory, version, id };
  } catch (error) {
    await removeOwnedDirectory(owned).catch(cleanup => { error.cleanupCode = cleanup.code || cleanup.message; });
    throw error;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { "--program": "program", "--profile": "profile", "--output-root": "outputRoot", "--purpose": "purpose", "--update-kind": "updateKind" }[args[index]];
    if (!key || !args[index + 1]) throw Error("Usage: backup-local-install --program <installed-directory> --profile <user-data> --output-root <backup-directory>");
    options[key] = args[index + 1];
  }
  if (!options.program || !options.profile || !options.outputRoot) throw Error("program, profile and output-root are required");
  backupLocalInstall(options).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { backupLocalInstall };
