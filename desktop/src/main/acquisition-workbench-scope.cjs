const { createAcquisitionAccount } = require('./acquisition-account.cjs');
const { createMapAcquisitionBrowser } = require('./map-acquisition-browser.cjs');

function registerScopedWorkbench(options, register) {
  const { ipcMain, getMainWindow, dataDir, getLicenseStatus, BrowserWindow, session } = options;
  const accounts = createAcquisitionAccount({ dataDir, getLicenseStatus });
  const handlers = new Map();
  let current, child, switching, disposed = false, generation = 0;
  const currentMap = () => child?.controllers.get('map-acquisition');
  const ownsWindow = () => !disposed && !switching && accounts.identity()?.namespace === current?.namespace;
  const handleMapMenu = async action => {
    if (!ownsWindow()) return;
    const controller = currentMap(), tasks = controller?.snapshot().tasks || [];
    const task = tasks.find(item => item.status === 'running') || tasks.at(-1);
    if (task) await controller.dispatch(action, { taskId: task.id });
    else {
      adapter.hide?.();
      const target = getMainWindow();
      if (target && !target.isDestroyed()) { if (target.isMinimized()) target.restore(); target.show(); target.focus(); }
    }
  };
  const notifyMap = () => { if (!ownsWindow()) return; const c = currentMap(), w = getMainWindow(); if (c && w && !w.isDestroyed()) w.webContents.send('map-acquisition:update', c.snapshot()); };
  const adapter = options.mapAdapter || createMapAcquisitionBrowser({ BrowserWindow, session, partitionId: 'main', Menu: options.Menu || require('electron').Menu,
    onReturn: () => handleMapMenu('return-results').catch(() => {}), onFinish: () => handleMapMenu('finish-task').catch(() => {}), onStatus: notifyMap,
    onClose: () => { const c = currentMap(), task = c?.snapshot().tasks.find(t => t.status === 'running'); if (task) void c.dispatch('pause-task', { taskId: task.id }).catch(() => {}); } });
  const facade = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const common = { ...options, getLicenseStatus: undefined };
  async function refreshAccount(force = false) {
    if (switching) { await switching; return refreshAccount(force); }
    const next = accounts.identity();
    if (!force && current?.namespace === next?.namespace && (!!child === !!next)) return;
    switching = (async () => {
      generation++;
      const previousWindow = getMainWindow();
      if (previousWindow && !previousWindow.isDestroyed()) previousWindow.webContents.send('map-acquisition:update', null);
      adapter.cancel?.();
      const map = currentMap(), running = map?.snapshot().tasks.find(t => t.status === 'running');
      if (running) await map.dispatch('pause-task', { taskId: running.id });
      await child?.dispose(); child = null; current = next;
      if (disposed) return;
      if (current) {
        accounts.resume(current);
        const bound = current.namespace, boundGeneration = generation;
        const guardedWindow = () => accounts.identity()?.namespace === bound && generation === boundGeneration ? getMainWindow() : null;
        child = register({ ...common, ipcMain: facade, dataDir: current.directory, getMainWindow: guardedWindow, mapAdapter: { ...adapter, dispose() { adapter.cancel?.(); } } });
      }
      const w = getMainWindow();
      if (w && !w.isDestroyed()) w.webContents.send('map-acquisition:update', currentMap()?.snapshot() || null);
    })();
    try { await switching; } finally { switching = null; }
  }
  ipcMain.handle('map-acquisition:invoke', async (event, action, payload = {}) => {
    const wc = getMainWindow()?.webContents;
    if (!wc || event.sender !== wc || event.senderFrame !== wc.mainFrame) return { ok: false, code: 'BUSINESS_IPC_FORBIDDEN', error: '当前页面无权操作获客资料' };
    try {
      await refreshAccount();
      if (!current) return { ok: false, state: null, error: '请先登录渠道商账号' };
      const bound = current.namespace, requestGeneration = generation;
      const handler = handlers.get('map-acquisition:invoke');
      const result = handler ? await handler(event, action, payload) : { ok: false, error: '本地资料不可读取' };
      if (accounts.identity()?.namespace !== bound || requestGeneration !== generation) { await refreshAccount(); return { ok: false, state: null, error: '账号已切换，请重新打开获客页面' }; }
      return result;
    } catch { return { ok: false, state: null, error: '账号资料暂不可读取，原资料保留；请核对账号后重试' }; }
  });
  return { refreshAccount, async dispose() { disposed = true; await switching; await child?.dispose(); adapter.dispose?.(); ipcMain.removeHandler('map-acquisition:invoke'); } };
}
module.exports = { registerScopedWorkbench };
