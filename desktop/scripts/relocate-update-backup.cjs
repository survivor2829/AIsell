// Maintenance only: copy and verify a confirmed recovery set before switching
// its registry references. Never move the live profile or installed program.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withRegistry, verifySet } = require('../src/main/update-backups.cjs');
const { copyProfile, checkCopySpace, createOwnedDirectory, removeOwnedDirectory } = require('../src/main/update-storage.cjs');
const { writeJsonAtomic } = require('../src/main/atomic-file.cjs');

const contains = (root, file) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

async function relocateBackup({ profile, id, outputRoot, apply = false }) {
  profile = await fs.realpath(profile);
  outputRoot = path.resolve(outputRoot);
  if (outputRoot === path.parse(outputRoot).root || contains(profile, outputRoot)) throw Error('backup_destination_invalid');
  return withRegistry(profile, async (registry, save) => {
    const set = registry.sets.find(item => item.id === id);
    if (!set || set.state !== 'confirmed') throw Error('confirmed_backup_required');
    if (set.relocation && path.resolve(set.relocation.outputRoot) !== outputRoot) throw Error('backup_relocation_destination_changed');
    const sourceOwners = set.relocation?.sourceOwners || structuredClone(set.owners);
    for (const owner of sourceOwners) {
      if (contains(owner.directory, profile) || contains(owner.directory, set.programBackup.installedRoot)
          || contains(set.programBackup.installedRoot, outputRoot) || contains(owner.directory, outputRoot) || registry.sets.some(other => other.id !== id
          && [other.data.directory, other.programBackup.program].some(file => contains(owner.directory, file)))) {
        throw Error('backup_destination_or_source_shared');
      }
    }
    await verifySet(set);
    const bytes = [...set.data.files, ...set.programBackup.files].reduce((n, file) => n + (file.size || 0), 0);
    const plan = { id, bytes, sources: sourceOwners.map(owner => owner.directory), destination: path.join(outputRoot, id), apply };
    if (!apply) return plan;
    if (!set.relocation) {
      await checkCopySpace([{ path: outputRoot, bytes }]);
      const owned = await createOwnedDirectory(outputRoot, id);
      let committed = false;
      try {
        if (process.platform === 'win32') {
          const account = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
          execFileSync('icacls.exe', [owned.directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
        }
        const original = structuredClone(set);
        const next = structuredClone(set);
        next.data.directory = path.join(owned.directory, 'userData');
        next.programBackup.program = path.join(owned.directory, 'program');
        next.programBackup.owned = owned;
        if (next.programBackup.owners) next.programBackup.owners = [owned];
        next.owners = [owned, ...sourceOwners];
        next.relocation = { outputRoot, sourceOwners, startedAt: new Date().toISOString() };
        await copyProfile(original.data.directory, next.data.directory, () => true);
        await copyProfile(original.programBackup.program, next.programBackup.program, () => true);
        await verifySet(next);
        // Old snapshots are immutable, but verify again before retiring them.
        await verifySet(original);
        writeJsonAtomic(path.join(owned.directory, 'relocation-original.json'), original);
        registry.sets[registry.sets.indexOf(set)] = next;
        save(registry);
        committed = true;
      } finally {
        if (!committed) await removeOwnedDirectory(owned);
      }
    }
    const current = registry.sets.find(item => item.id === id);
    await verifySet(current);
    // References are durably on D before any original directory is removed.
    // Remaining source owners stay in the registry if cleanup is interrupted.
    for (const owner of sourceOwners) {
      try { await removeOwnedDirectory(owner); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      current.owners = current.owners.filter(item => item.directory !== owner.directory);
      save(registry);
    }
    current.relocation.completedAt = new Date().toISOString();
    save(registry);
    return { ...plan, verified: true, dataDirectory: current.data.directory, programDirectory: current.programBackup.program, state: current.state };
  });
}

if (require.main === module) {
  const options = {}, args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else {
      const key = { '--profile': 'profile', '--id': 'id', '--output-root': 'outputRoot' }[args[i]];
      if (!key || !args[i + 1]) throw Error('Use --profile <profile> --id <confirmed-set> --output-root <directory> [--apply]');
      options[key] = args[++i];
    }
  }
  if (!options.profile || !options.id || !options.outputRoot) throw Error('profile, id and output-root are required');
  relocateBackup(options).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { relocateBackup };
