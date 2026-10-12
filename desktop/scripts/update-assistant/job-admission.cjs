'use strict';
// Recover only terminal installation authority; retain every original receipt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PRE_INSTALL = new Set(['prepare', 'helper', 'launch', 'ready', 'waiting', 'verifying', 'backup']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function terminal(job, status, ack) {
  if (status?.phase === 'complete' && ack?.ok === true && ack.version === job.targetVersion) return 'complete';
  if (status?.phase !== 'error' || !status.failure) throw Error('prior_update_unresolved');
  if (status.failure.code === 'update_start_rolled_back') return 'rolled_back';
  if (PRE_INSTALL.has(status.failure.phase) && !/^update_(restore_failed|start_)/.test(status.failure.code || '')) return 'not_installed';
  throw Error('prior_recovery_required');
}
function assertNoLiveAuthority(job, active, ready, rows) {
  const pids = new Set([active?.pid, ready?.pid, job.parentPid].filter(Number.isInteger));
  // A PID can now belong to another executable. Known different paths prove
  // reuse; unreadable identity remains a blocker, rather than guessing safe.
  if (rows.some(row => (pids.has(row.pid) && !row.executable) || same(row.executable, job.executable) || same(row.executable, job.helperExecutable) ||
      (job.prepared?.file && same(row.executable, job.prepared.file)))) throw Error('existing_update');
}
async function reconcile({ paths, installed, executable, selected, rows, child, plain, verifyJob, verifyVersion, saveSelection }) {
  const activeFile = child(paths.directory, 'active-job.json');
  const snapshots = new Map();
  function read(file, required = false) {
    plain(file);
    if (!fs.existsSync(file)) { if (required) throw Error('prior_update_unresolved'); return null; }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 ** 2) throw Error('prior_update_unresolved');
    const bytes = fs.readFileSync(file); snapshots.set(file, bytes);
    try { return JSON.parse(bytes); } catch { throw Error('prior_update_unresolved'); }
  }
  const active = read(activeFile);
  const ids = [...new Set([active?.id, selected.pending?.jobId].filter(Boolean))];
  if ((active && !UUID.test(active.id)) || (selected.pending && !UUID.test(selected.pending.jobId))) throw Error('prior_update_unresolved');
  if (!ids.length) return selected;
  let next = selected;
  for (const id of ids) {
    const file = child(paths.jobs, id + '.json'), job = read(file, true);
    const status = read(child(paths.jobs, id + '.status.json'), true), ready = read(child(paths.jobs, id + '.ready.json'));
    const ack = read(child(paths.jobs, id + '.ack.json'));
    read(child(paths.jobs, id + '.commit.json')); read(child(paths.jobs, id + '.cancel.json'));
    if (job.id !== id || !same(job.installedRoot, installed) || !same(job.executable, executable)) throw Error('prior_update_unresolved');
    await verifyJob(job);
    assertNoLiveAuthority(job, active?.id === id ? active : null, ready, rows);
    const outcome = terminal(job, status, ack);
    if (selected.pending?.jobId !== id) continue;
    if (outcome === 'complete') {
      if (await verifyVersion(selected.active) !== job.targetVersion) throw Error('prior_update_unresolved');
      next = { ...selected, pending: null };
    } else if (job.prepared.kind === 'components' && outcome === 'rolled_back') {
      // Use the same pointer-only recovery as bootstrap; never touch user data.
      // A complete, signed previous generation must still be available.
      await verifyVersion(selected.previous);
      next = { active: selected.previous || null, previous: null, pending: null, failure: '更新未完成，已恢复上一版本。', lastUpdate: null };
    } else throw Error('prior_recovery_required');
  }
  const selectionFile = plain(paths.selection);
  if (fs.existsSync(selectionFile)) {
    const actual = read(selectionFile, true);
    if (JSON.stringify(actual) !== JSON.stringify(selected)) throw Error('installation_changed');
  }
  // Preserve the exact authority/pointer bytes before any mutation. All job,
  // backup, download and acknowledgement files remain where they were.
  const archive = child(paths.directory, 'retired-authority/' + crypto.randomUUID());
  fs.mkdirSync(archive, { recursive: true }); plain(archive);
  for (const [file, bytes] of snapshots) {
    if (!fs.readFileSync(file).equals(bytes)) throw Error('installation_changed');
    fs.writeFileSync(child(archive, path.basename(file)), bytes, { flag: 'wx' });
  }
  fs.writeFileSync(child(archive, 'retirement.json'), JSON.stringify({ schema: 1, ids, retiredAt: new Date().toISOString(), selected, next }), { flag: 'wx' });
  // Caller owns the coordinator lease and has waited for every old business or
  // helper process to exit. Compare immediately before retiring the stale lock.
  if (active) {
    if (!fs.readFileSync(activeFile).equals(snapshots.get(activeFile))) throw Error('installation_changed');
    fs.unlinkSync(activeFile);
  }
  if (next !== selected) saveSelection(paths, next);
  return next;
}
module.exports = { reconcile, terminal, assertNoLiveAuthority };
