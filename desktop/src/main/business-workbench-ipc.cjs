const fs = require('node:fs');
const path = require('node:path');
const { createMapAcquisitionController } = require('./map-acquisition.cjs');
const { createMapAcquisitionBrowser } = require('./map-acquisition-browser.cjs');

function registerBusinessWorkbenchIpc(options) {
  if (options.getLicenseStatus) return require('./acquisition-workbench-scope.cjs').registerScopedWorkbench(options, registerBusinessWorkbenchIpc);
  const { ipcMain, BrowserWindow, session, dialog, shell, clipboard, dataDir, getMainWindow, mapAdapter } = options;
  const domain = 'map-acquisition';
  let controller, initializationError;
  const emit = state => { const target = getMainWindow(); if (target && !target.isDestroyed()) target.webContents.send(`${domain}:update`, state); };
  const returnToMain = () => {
    adapter.hide?.();
    const target = getMainWindow();
    if (target && !target.isDestroyed()) { if (target.isMinimized()) target.restore(); target.show(); target.focus(); }
  };
  const handleMenu = async action => {
    const tasks = controller?.snapshot().tasks || [];
    const task = tasks.find(item => item.status === 'running') || tasks.at(-1);
    if (task) await controller.dispatch(action, { taskId: task.id }); else returnToMain();
  };
  const adapter = mapAdapter || createMapAcquisitionBrowser({ BrowserWindow, session, partitionId: 'main', Menu: options.Menu || require('electron').Menu,
    onReturn: () => handleMenu('return-results').catch(() => {}), onFinish: () => handleMenu('finish-task').catch(() => {}),
    onStatus: () => { if (controller) emit(controller.snapshot()); }, onClose: () => {
      const task = controller?.snapshot().tasks.find(item => item.status === 'running');
      if (task) void controller.dispatch('pause-task', { taskId: task.id }).catch(() => {});
    } });
  try { controller = createMapAcquisitionController({ dataDir, adapter, clipboard, onCompleted: returnToMain, onChange: emit }); }
  catch { initializationError = '本地资料暂不可读取，请检查运行目录权限后重试；已有资料未覆盖。'; }
  ipcMain.handle(`${domain}:invoke`, async (event, action, payload = {}) => {
    const target = getMainWindow()?.webContents;
    if (!target || event.sender !== target || event.senderFrame !== target.mainFrame) return { ok: false, code: 'BUSINESS_IPC_FORBIDDEN', error: '当前页面无权操作本地工作台。' };
    if (initializationError) return { ok: false, error: initializationError };
    try {
      if (typeof action !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('操作参数无效。');
      if (action === 'open-source' || action === 'open-related') {
        const lead = controller.snapshot().leads.find(item => item.id === payload.leadId);
        const value = action === 'open-source' ? lead?.sourceUrl : lead?.evidence.find(item => item.id === payload.evidenceId)?.url;
        const url = new URL(value || '');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('来源链接无效。');
        await shell.openExternal(url.href);
        return { ok: true, state: controller.snapshot() };
      }
      const result = await controller.dispatch(action, payload);
      if (action === 'export' && typeof result?.csv === 'string') {
        const chosen = await dialog.showSaveDialog(getMainWindow(), { title: '导出企业名单', defaultPath: '地图获客企业名单.csv', filters: [{ name: 'CSV 表格', extensions: ['csv'] }] });
        if (!chosen.canceled && chosen.filePath) fs.writeFileSync(chosen.filePath, result.csv.startsWith('\uFEFF') ? result.csv : '\uFEFF' + result.csv, 'utf8');
        return { ok: true, state: controller.snapshot(), result: { exported: !chosen.canceled } };
      }
      return { ok: true, state: controller.snapshot(), result: action === 'status' ? undefined : result };
    } catch (error) { return { ok: false, error: error.code && /^(EACCES|EPERM|ENOENT|EIO|ENOSPC|EROFS|EBUSY)$/.test(error.code) ? '本地记录读写失败，请检查权限和可用空间；已有资料已保留。' : String(error.message || '操作未完成，已有资料已保留。'), state: controller.snapshot() }; }
  });
  return { controllers: new Map(controller ? [[domain, controller]] : []), async dispose() { ipcMain.removeHandler(`${domain}:invoke`); if (controller) await controller.dispose(); else adapter.dispose?.(); } };
}
module.exports = { registerBusinessWorkbenchIpc };
