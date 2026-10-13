const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { relocateBackup } = require('./relocate-update-backup.cjs');
const { captureData, registerSet, confirmSet, readRegistry, verifySet } = require('../src/main/update-backups.cjs');
const { backupProgram, restoreProgram } = require('../src/main/update-program-backup.cjs');

(async () => {
  const parent = path.resolve(__dirname, '../.build/relocate-backup-tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'run-'));
  try {
    const profile = path.join(root, 'profile'), program = path.join(root, 'installed'), outputRoot = path.join(root, 'destination');
    for (const dir of [profile, program]) await fs.mkdir(dir);
    await fs.writeFile(path.join(profile, 'license.enc'), 'isolated authorization');
    await fs.writeFile(path.join(program, 'app.asar'), 'isolated physical archive');
    const id = crypto.randomUUID(), selection = { active: null, previous: null, pending: null };
    const programBackup = await backupProgram(program, path.join(root, 'old-program'), id, selection);
    const data = await captureData(profile, id);
    const original = await registerSet(profile, { id, version: '1.0.0', programBackup, data });
    await confirmSet(profile, id, { targetVersion: '1.0.1', ack: { ok: true, version: '1.0.1' }, dataCheck: true });
    const options = { profile, id, outputRoot };
    await relocateBackup(options);
    assert.equal(readRegistry(profile).sets[0].data.directory, original.data.directory, 'dry run leaves references intact');
    const copy = fs.cp;
    fs.cp = async (source, target, options) => {
      await copy(source, target, options);
      if (source === data.directory) await fs.writeFile(path.join(target, 'license.enc'), 'corrupted copy');
    };
    try { await assert.rejects(relocateBackup({ ...options, apply: true }), /verification_failed/); }
    finally { fs.cp = copy; }
    await verifySet(readRegistry(profile).sets[0]);
    assert.equal(readRegistry(profile).sets[0].data.directory, original.data.directory, 'failed verification preserves C references');
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (source === original.owners[0].directory) throw Object.assign(Error('sharing violation'), { code: 'EBUSY' });
      return rename(source, target);
    };
    try { await assert.rejects(relocateBackup({ ...options, apply: true }), /sharing violation/); }
    finally { fs.rename = rename; }
    const committed = readRegistry(profile).sets[0];
    assert.ok(committed.data.directory.startsWith(outputRoot));
    await verifySet(committed);
    await fs.access(original.owners[0].directory);
    await relocateBackup({ ...options, apply: true });
    const migrated = readRegistry(profile).sets[0];
    await verifySet(migrated);
    assert.equal(migrated.id, id);
    assert.equal(migrated.state, 'confirmed');
    assert.deepEqual(migrated.programBackup.selection, selection);
    assert.equal(migrated.owners.length, 1);
    for (const owner of original.owners) await assert.rejects(fs.access(owner.directory), { code: 'ENOENT' });
    await restoreProgram({ ...migrated.programBackup, installedRoot: path.join(root, 'isolated-restore') });
    assert.equal(await fs.readFile(path.join(root, 'isolated-restore/app.asar'), 'utf8'), 'isolated physical archive');
    await relocateBackup({ ...options, apply: true });
    console.log('Backup relocation self-check passed: corrupt copy protected, interrupted cleanup resumed, program restored, selection and receipts retained.');
  } finally {
    if (path.dirname(root) !== parent) throw Error('fixture_boundary_invalid');
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
