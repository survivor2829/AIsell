const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { registerBusinessWorkbenchIpc } = require('./business-workbench-ipc.cjs');
async function checkScopedMenu(root) {
  // Exercise production callback wiring without opening a real map or collecting data.
  const vm = require('node:vm');
  const module = { exports: {} };
  let callbacks, account = 'menu-A', empty = true;
  const calls = [], menu = {};
  const windowEvents = [];
  const mainWindow = { isDestroyed: () => false, isMinimized: () => true, restore: () => windowEvents.push('restore'), show: () => windowEvents.push('show'), focus: () => windowEvents.push('focus'), webContents: { send() {} } };
  const scopedRequire = name => name === './map-acquisition-browser.cjs'
    ? { createMapAcquisitionBrowser: options => { callbacks = options; return { hide: () => windowEvents.push('hide'), cancel() {}, dispose() {} }; } }
    : require(name);
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(path.join(__dirname, 'acquisition-workbench-scope.cjs'), 'utf8')}\n})`)(scopedRequire, module, module.exports);
  const registration = module.exports.registerScopedWorkbench({ dataDir: path.join(root, 'menus'), Menu: menu,
    ipcMain: { handle() {}, removeHandler() {} }, getMainWindow: () => mainWindow,
    getLicenseStatus: () => ({ authorized: !!account, licenseId: account }) }, options => {
      const owner = account;
      return { controllers: new Map(options.domains.includes('map-acquisition') ? [['map-acquisition', {
        snapshot: () => ({ tasks: empty ? [] : [{ id: `${owner}-task`, status: 'paused' }] }),
        dispatch: async (action, payload) => calls.push({ owner, action, taskId: payload.taskId })
      }]] : []), async dispose() {} };
    });
  try {
    assert.equal(callbacks.Menu, menu);
    await registration.refreshAccount();
    await callbacks.onReturn(); await callbacks.onFinish();
    assert.deepEqual(windowEvents, ['hide', 'restore', 'show', 'focus', 'hide', 'restore', 'show', 'focus'], 'empty scoped map menus return to the main window');
    assert.equal(calls.length, 0);
    empty = false;
    await callbacks.onReturn();
    account = 'menu-B';
    await callbacks.onFinish();
    assert.equal(calls.length, 1, 'stale account window cannot operate the previous account');
    await registration.refreshAccount();
    await callbacks.onFinish();
    assert.deepEqual(calls, [
      { owner: 'menu-A', action: 'return-results', taskId: 'menu-A-task' },
      { owner: 'menu-B', action: 'finish-task', taskId: 'menu-B-task' }
    ]);
    await registration.dispose();
    await callbacks.onReturn();
    assert.equal(calls.length, 2, 'disposed workbench ignores window menu');
  } finally { await registration.dispose(); }
  const unscopedModule = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(path.join(__dirname, 'business-workbench-ipc.cjs'), 'utf8')}\n})`)(
    name => name === 'electron' ? { Menu: menu } : scopedRequire(name), unscopedModule, unscopedModule.exports);
  const unscoped = unscopedModule.exports.registerBusinessWorkbenchIpc({ dataDir: path.join(root, 'unscoped-menus'), domains: ['map-acquisition'],
    ipcMain: { handle() {}, removeHandler() {} }, getMainWindow: () => mainWindow });
  try {
    windowEvents.length = 0;
    await callbacks.onReturn(); await callbacks.onFinish();
    assert.deepEqual(windowEvents, ['hide', 'restore', 'show', 'focus', 'hide', 'restore', 'show', 'focus'], 'empty preview map menus return to the main window');
  } finally { await unscoped.dispose(); }
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acquisition-accounts-'));
  let account = 'A', starts = 0, destroyed = 0, release, refreshRelease;
  const handlers = new Map(), frame = {}, sender = { mainFrame: frame, send() {} }, event = { sender, senderFrame: frame };
  const adapter = { refreshAccount: () => new Promise(resolve => { refreshRelease = resolve; }), status: () => ({ state: 'connected' }), cancel() {}, dispose() { destroyed++; },
    collect: async ({ shouldContinue, onLead }) => { starts++; await new Promise(r => { release = r; }); if (shouldContinue()) onLead({ poiId: 'fixture', name: '隔离物业公司', address: '嘉兴市南湖区' }); } };
  const registration = registerBusinessWorkbenchIpc({ ipcMain: { handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k) }, dataDir: root,
    getLicenseStatus: () => ({ authorized: !!account, licenseId: account }), getMainWindow: () => ({ webContents: sender, isDestroyed: () => false }), mapAdapter: adapter,
    publicSources: { status: () => ({ search: false, reason: '隔离来源未连接' }) }, dialog: {}, shell: {} });
  const invoke = (action, payload = {}) => handlers.get('map-acquisition:invoke')(event, action, payload);
  try {
    await checkScopedMenu(root);
    assert.equal(handlers.has('precise-acquisition:invoke'), false);
    assert.equal(handlers.has('geo-workbench:invoke'), false);
    await invoke('save-task', { city: '嘉兴市', device: '洗地机', keywords: ['保洁公司'] });
    const aState = (await invoke('status')).state;
    const a = aState.account.namespace;
    await invoke('start-task', { taskId: aState.tasks[0].id }); assert.equal(starts, 1);
    account = 'B'; let switched = false;
    const switching = registration.refreshAccount().then(() => { switched = true; });
    await new Promise(r => setTimeout(r, 30)); assert.equal(switched, false, 'account change drains old map execution before reusing its window');
    release(); await switching;
    let state = (await invoke('status')).state;
    assert.equal(state.leads.length, 0); assert.equal(state.tasks.length, 0); assert.notEqual(state.account.namespace, a);
    assert.equal(destroyed, 0, 'switching accounts preserves the browser adapter/window');
    await invoke('save-task', { city: '杭州市', device: '洗地机', keywords: ['物业公司'] });
    account = 'A'; state = (await invoke('status')).state;
    assert.equal(state.tasks[0].city, '嘉兴市'); assert.equal(state.tasks[0].status, 'paused');
    assert.equal(state.leads.length, 0, 'cancelled previous account collect cannot ingest late results');
    account = ''; const signedOut = await invoke('status'); assert.equal(signedOut.ok, false); assert.equal(signedOut.state, null);
    account = 'A'; await invoke('status');
    const delayed = invoke('refresh-account');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof refreshRelease, 'function');
    account = 'B'; await invoke('status');
    account = 'A'; await invoke('status');
    refreshRelease();
    const stale = await delayed;
    assert.equal(stale.ok, false); assert.equal(stale.state, null, 'A/B/A still invalidates the earlier A response');
    const legacyRoot = path.join(root, 'legacy');
    fs.mkdirSync(path.join(legacyRoot, 'map-acquisition'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'map-acquisition/state.json'), JSON.stringify({ tasks: [], leads: [{ id: 'legacy-map' }] }));
    const legacyHandlers = new Map();
    const legacy = registerBusinessWorkbenchIpc({ ipcMain: { handle: (k, v) => legacyHandlers.set(k, v), removeHandler: k => legacyHandlers.delete(k) }, dataDir: legacyRoot,
      getLicenseStatus: () => ({ authorized: true, licenseId: 'legacy-A' }), getMainWindow: () => ({ webContents: sender, isDestroyed: () => false }), mapAdapter: adapter });
    try {
      const call = (action, payload = {}) => legacyHandlers.get('map-acquisition:invoke')(event, action, payload);
      let old = (await call('status')).state;
      assert.equal(old.account.migrationAvailable, true, 'map exposes legacy migration without retired IPC');
      assert.equal((await call('claim-legacy', { namespace: 'wrong' })).ok, false);
      old = (await call('claim-legacy', { namespace: old.account.namespace })).state;
      assert.equal(old.leads[0].id, 'legacy-map'); assert.equal(old.account.migrationAvailable, false);
      assert.equal(fs.existsSync(path.join(legacyRoot, 'map-acquisition/state.json')), true);
    } finally { await legacy.dispose(); }
    console.log('acquisition accounts passed: scoped map menus, real IPC account isolation, A/B/A, queue drain, preserved window, logout and confirmed legacy migration');
  } finally { release?.(); await registration.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
