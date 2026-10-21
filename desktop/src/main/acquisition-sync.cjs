const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const equal = isDeepStrictEqual;
const key = r => `${r.collection}:${r.id}`;
function recordsFor(state) {
  return [
    { collection: 'profile', id: 'main', data: { profile: state.profile, profiles: state.profiles || [] } },
    ...state.enterprises.flatMap(({ followUps, ...company }) => [
      { collection: 'enterprise', id: company.id, data: company },
      ...followUps.map(f => ({ collection: 'followup', id: f.id, data: { ...f, enterpriseId: company.id } }))]),
    ...state.cards.map(data => ({ collection: 'card', id: data.id, data })),
    ...state.sources.map(data => ({ collection: 'source', id: data.id, data })),
    ...state.copyEvents.map(data => ({ collection: 'copyEvent', id: data.id, data }))
  ];
}
function createAcquisitionSync({ dataDir, namespace, request, getState, applyRecords, onChange = () => {} }) {
  const file = path.join(dataDir, 'precise-acquisition', 'sync.json');
  let ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { cursor: 0, known: {}, pending: [], conflicts: [], lastSyncedAt: '' };
  if (!Array.isArray(ledger.pending) || !Array.isArray(ledger.conflicts) || !ledger.known) throw Error('同步记录不可读取，原文件保留');
  let busy = false, disposed = false, applying = false, timer, error = '';
  const save = () => { writeJsonAtomic(file, ledger); onChange(); };
  function capture() {
    if (disposed || applying || !namespace) return;
    for (const r of recordsFor(getState())) {
      if (r.collection === 'profile' && !r.data.profile.city && !ledger.known[key(r)]) continue;
      const k = key(r), pending = ledger.pending.find(p => key(p) === k), conflict = ledger.conflicts.find(c => key(c.local) === k);
      if (conflict) conflict.local.data = clone(r.data);
      if (pending || conflict || equal(ledger.known[k]?.data, r.data)) continue;
      ledger.pending.push({ ...clone(r), opId: randomUUID(), baseVersion: ledger.known[k]?.version || 0 });
    }
    save();
  }
  async function remote(action, body) {
    if (disposed) throw Error('账号已切换');
    const result = await request(action, { ...body, expectedNamespace: namespace });
    if (disposed) throw Error('账号已切换');
    return result;
  }
  function apply(rows) { applying = true; try { applyRecords(rows); } finally { applying = false; } }
  async function sync() {
    if (busy || disposed || !namespace) return;
    busy = true; error = '';
    try {
      capture(); onChange();
      // Retry immutable operations before pull: a lost receipt is never a second write.
      for (let page = 0; ledger.pending.length && page < 100 && !disposed; page++) {
        const ops = []; let bytes = 0;
        for (const op of ledger.pending) { const n = Buffer.byteLength(JSON.stringify(op)); if (ops.length && (bytes + n > 1024 * 1024 || ops.length >= 50)) break; ops.push(op); bytes += n; }
        const result = await remote('push', { operations: ops });
        if (!Array.isArray(result.results) || result.results.length !== ops.length) throw Error('同步回执不完整');
        for (const receipt of result.results) {
          const op = ops.find(o => o.opId === receipt.opId);
          if (!op || !['applied', 'conflict'].includes(receipt.status)) throw Error('同步回执无效');
          if (receipt.status === 'conflict') {
            const current = recordsFor(getState()).find(r => key(r) === key(op)) || op;
            ledger.conflicts.push({ id: op.opId, local: { ...op, data: clone(current.data) }, remote: receipt.record });
          } else ledger.known[key(op)] = receipt.record;
          ledger.pending = ledger.pending.filter(p => p.opId !== op.opId);
        }
        save(); capture();
      }
      for (let page = 0; page < 100; page++) {
        const result = await remote('pull', { cursor: ledger.cursor, limit: 100 });
        if (!Array.isArray(result.records) || !Number.isSafeInteger(result.cursor) || result.cursor < ledger.cursor) throw Error('同步游标无效');
        for (const r of result.records) {
          const k = key(r);
          if ((ledger.known[k]?.version || 0) >= r.version) continue;
          const existingConflict = ledger.conflicts.find(c => key(c.local) === k);
          if (existingConflict) existingConflict.remote = r;
          const local = recordsFor(getState()).find(v => key(v) === k);
          const meaningful = local && (local.collection !== 'profile' || local.data.profile?.city || ledger.known[k]);
          const dirty = ledger.pending.some(p => key(p) === k) || ledger.conflicts.some(c => key(c.local) === k) || meaningful && !equal(local.data, ledger.known[k]?.data);
          if (dirty && local && !equal(local.data, r.data)) {
            const conflict = ledger.conflicts.find(c => key(c.local) === k);
            if (!conflict) ledger.conflicts.push({ id: randomUUID(), local: { ...local, baseVersion: ledger.known[k]?.version || 0 }, remote: r });
          } else apply([r]);
          ledger.known[k] = r;
        }
        ledger.cursor = result.cursor; save();
        if (!result.hasMore) break;
        if (!result.records.length) throw Error('同步分页未推进');
      }
      ledger.lastSyncedAt = new Date().toISOString(); save();
    } catch { if (!disposed) error = '同步暂未完成，资料已保存在本机。检查网络和服务后重试。'; }
    finally { busy = false; onChange(); }
  }
  function schedule() {
    if (applying || disposed) return;
    try { capture(); } catch { error = '本地同步记录写入失败，请检查权限和可用空间后重试。'; onChange(); return; }
    clearTimeout(timer); timer = setTimeout(() => { void sync().catch(() => { error = '同步暂未完成，请检查本地记录后重试。'; }); }, 1500); timer.unref?.();
  }
  function resolve(id, choice) {
    if (busy) throw Error('请等待本轮同步结束');
    const conflict = ledger.conflicts.find(c => c.id === id); if (!conflict || !['local', 'remote'].includes(choice)) throw Error('同步冲突不存在');
    const k = key(conflict.local);
    if (choice === 'remote') { if (!conflict.remote) throw Error('云端版本不存在'); apply([conflict.remote]); }
    else {
      if (['followup', 'copyEvent'].includes(conflict.local.collection)) throw Error('历史事件不能覆盖，请保留云端记录后另增跟进');
      ledger.pending.push({ ...conflict.local, opId: randomUUID(), baseVersion: conflict.remote?.version || 0 });
    }
    if (conflict.remote) ledger.known[k] = conflict.remote;
    ledger.conflicts = ledger.conflicts.filter(c => c.id !== id); save(); schedule();
  }
  return { schedule, sync, resolve, status: () => ({ enabled: !!namespace, busy, pending: ledger.pending.length, conflicts: clone(ledger.conflicts), lastSyncedAt: ledger.lastSyncedAt, error }), dispose() { disposed = true; clearTimeout(timer); } };
}
module.exports = { createAcquisitionSync, recordsFor };
