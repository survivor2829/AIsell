const fs = require('node:fs');
const path = require('node:path');
const { createBusinessAi } = require('./business-ai.cjs');
const { createMapAcquisitionController } = require('./map-acquisition.cjs');
const { createMapAcquisitionBrowser } = require('./map-acquisition-browser.cjs');

function registerBusinessWorkbenchIpc(options) {
  if (options.getLicenseStatus) return require('./acquisition-workbench-scope.cjs').registerScopedWorkbench(options, registerBusinessWorkbenchIpc);
  const { ipcMain, BrowserWindow, session, dialog, shell, clipboard, dataDir, getMainWindow, deepSeekClient, mapAdapter, account, domains = ['map-acquisition'] } = options;
  const controllers = new Map();
  const errors = new Map();
  const emit = domain => state => { const target = getMainWindow(); if (target && !target.isDestroyed()) target.webContents.send(`${domain}:update`, state); };
  for (const domain of domains) {
    try {
      let ai;
      try { ai = createBusinessAi({ dataDir: path.join(dataDir, domain, 'billing'), client: deepSeekClient }); }
      catch { ai = { policy: () => ({ approved: false, maxCalls: 0 }), snapshot: () => ({ budget: { approved: false, maxCalls: 0 }, ledger: [], error: 'AI 调用账本暂不可读取，付费请求保持关闭。' }), request: async () => { throw Error('AI 调用账本暂不可读取，未发起请求。'); } }; }
      if (domain === 'map-acquisition') {
        let controller;
        const returnToMain = () => {
          adapter.hide?.();
          const target = getMainWindow();
          if (target && !target.isDestroyed()) { if (target.isMinimized()) target.restore(); target.show(); target.focus(); }
        };
        const handleMapMenu = async action => {
          const tasks = controller?.snapshot().tasks || [];
          const task = tasks.find(item => item.status === 'running') || tasks.at(-1);
          if (task) await controller.dispatch(action, { taskId: task.id });
          else returnToMain();
        };
        const adapter = mapAdapter || createMapAcquisitionBrowser({ BrowserWindow, session, partitionId: 'main', Menu: options.Menu || require('electron').Menu,
          onReturn: () => handleMapMenu('return-results').catch(() => {}),
          onFinish: () => handleMapMenu('finish-task').catch(() => {}),
          onStatus: () => { if (controller) emit(domain)(controller.snapshot()); }, onClose: () => { const running = controller?.snapshot().tasks.find(task => task.status === 'running'); if (running) void controller.dispatch('pause-task', { taskId: running.id }).catch(() => {}); } });
        controller = createMapAcquisitionController({ dataDir, adapter, clipboard, onCompleted: returnToMain, onChange: state => emit(domain)({ ...state, account: account?.(), ai: ai.snapshot(), capabilities: { ...state.capabilities, organize: ai.policy().approved } }), organize: async leads => {
          const result = await ai.request({ kind: 'map-lead-summary', prompt: `整理以下企业资料为 JSON {"leads":[{"id":"原id","summary":"事实摘要","questions":["待核实问题"]}]}。不推断采购需求或身份，不改变需求等级：${JSON.stringify(leads.map(({ id, name, industry, address, evidence }) => ({ id, name, industry, address, evidence })))}` });
          try { return { ...JSON.parse(result.content), usage: result.usage }; } catch { throw Error('AI 返回格式不完整，已保留调用记录，未重复请求。'); }
        } });
        const originalSnapshot = controller.snapshot;
        controller.snapshot = () => ({ ...originalSnapshot(), account: account?.(), ai: ai.snapshot(), capabilities: { ...originalSnapshot().capabilities, organize: ai.policy().approved } });
        controllers.set(domain, controller);
      }
    } catch { errors.set(domain, '本地资料暂不可读取，请检查运行目录权限后重试；已有资料未覆盖。'); }
    ipcMain.handle(`${domain}:invoke`, async (event, action, payload = {}) => {
      const target = getMainWindow()?.webContents;
      if (!target || event.sender !== target || event.senderFrame !== target.mainFrame) return { ok: false, code: 'BUSINESS_IPC_FORBIDDEN', error: '当前页面无权操作本地工作台。' };
      if (errors.has(domain)) return { ok: false, error: errors.get(domain) };
      const controller = controllers.get(domain);
      try {
        if (typeof action !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('操作参数无效。');
        if (action === 'open-source' || action === 'open-related') {
          const state = controller.snapshot();
          let value;
          if (domain === 'map-acquisition') {
            const record = state.leads.find(lead => lead.id === payload.leadId);
            value = action === 'open-source' ? record?.sourceUrl : record?.evidence.find(item => item.id === payload.evidenceId)?.url;
          }
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
      } catch (error) { return { ok: false, error: error.code && /^(EACCES|EPERM|ENOENT|EIO|ENOSPC|EROFS|EBUSY)$/.test(error.code) ? '本地记录读写失败，请检查权限和可用空间；已有资料已保留。' : String(error.message || '操作未完成，已有资料已保留。'), state: controller?.snapshot() }; }
    });
  }
  return { controllers, async dispose() { for (const domain of domains) { ipcMain.removeHandler(`${domain}:invoke`); await controllers.get(domain)?.dispose(); } } };
}
module.exports = { registerBusinessWorkbenchIpc };
