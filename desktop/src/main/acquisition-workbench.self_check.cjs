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
      return { controllers: new Map(true ? [['map-acquisition', {
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-accounts-'));
  let account = 'A', release, destroyed = 0;
  const handlers = new Map(), frame = {}, sender = { mainFrame: frame, send() {} }, event = { sender, senderFrame: frame };
  const adapter = { status: () => ({ state: 'connected' }), cancel() {}, dispose() { destroyed++; },
    collect: async ({ shouldContinue, onLead }) => { await new Promise(r => { release = r; }); if (shouldContinue()) onLead({ poiId: 'fixture', name: '隔离物业公司', address: '嘉兴市南湖区' }); } };
  const registration = registerBusinessWorkbenchIpc({ ipcMain: { handle: (k, v) => handlers.set(k, v), removeHandler: k => handlers.delete(k) }, dataDir: root,
    getLicenseStatus: () => ({ authorized: !!account, licenseId: account }), getMainWindow: () => ({ webContents: sender, isDestroyed: () => false }), mapAdapter: adapter });
  const invoke = (action, payload = {}) => handlers.get('map-acquisition:invoke')(event, action, payload);
  try {
    await checkScopedMenu(root);
    assert.deepEqual([...handlers.keys()], ['map-acquisition:invoke'], 'only map IPC is registered');
    assert.equal((await handlers.get('map-acquisition:invoke')({sender:{},senderFrame:frame},'status')).code, 'BUSINESS_IPC_FORBIDDEN');
    const saved = await invoke('save-task', { city:'嘉兴市', device:'清洁设备', keywords:['物业公司'] }); assert.equal(saved.ok, true);
    const id = saved.state.tasks[0].id;
    assert.equal((await invoke('start-task', {taskId:id})).ok, true);
    account = 'B'; let switched = false;
    const switching = registration.refreshAccount().then(() => { switched = true; });
    await new Promise(r => setTimeout(r, 30)); assert.equal(switched, false);
    release(); await switching;
    assert.equal((await invoke('status')).state.tasks.length, 0);
    assert.equal(destroyed, 0, 'account change preserves map window');
    account = 'A'; const returned = await invoke('status');
    assert.equal(returned.state.tasks[0].id, id); assert.equal(returned.state.tasks[0].status, 'paused');
    assert.equal(returned.state.leads.length, 0, 'late result must not cross accounts');
    account = ''; assert.equal((await invoke('status')).ok, false);
    console.log('map workbench passed: real IPC identity isolation, A/B/A, queue drain, preserved browser, menu return and logout');
  } finally { release?.(); await registration.dispose(); fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
