const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { DEEPSEEK_MODEL } = require('./deepseek-api.cjs');
const { createBusinessAi } = require('./business-ai.cjs');
const { createPreciseAcquisitionController, safeUrl } = require('./precise-acquisition.cjs');
const { createPublicSources } = require('./precise-public-sources.cjs');
const { createAcquisitionSync } = require('./acquisition-sync.cjs');

function registerPreciseAcquisitionIpc({ ipcMain, dataDir, getMainWindow, gatewayClient, deepSeekClient, mapController, dialog, shell, clipboard, publicSources = createPublicSources(), account }) {
  const domain = 'precise-acquisition';
  const billingDir = path.join(dataDir, domain, 'billing');
  const ai = createBusinessAi({ dataDir: billingDir, client: deepSeekClient });
  const originalPolicy = ai.policy;
  const reservationFile = path.join(billingDir, 'cost-reservations.json');
  const readBudget = () => JSON.parse(fs.readFileSync(path.join(billingDir, 'budget-approval.json'), 'utf8'));
  ai.policy = () => {
    const base = originalPolicy();
    if (!base.approved) return base;
    try {
      const budget = readBudget();
      const ceiling = Number(budget.costPerCallCeilingMicros), total = Number(budget.totalBudgetMicros);
      const pricing = budget.pricing;
      const approved = ceiling > 0 && Number.isSafeInteger(ceiling) && Number.isSafeInteger(total) && total > 0
        && pricing?.model === DEEPSEEK_MODEL && pricing?.currency === 'CNY' && Number.isFinite(Date.parse(pricing.verifiedAt))
        && Number.isSafeInteger(pricing.inputMicrosPerMillion) && pricing.inputMicrosPerMillion > 0
        && Number.isSafeInteger(pricing.outputMicrosPerMillion) && pricing.outputMicrosPerMillion > 0;
      return { ...base, approved, reason: approved ? '' : '模型价格或金额上限尚未核实，未启用付费整理' };
    } catch { return { approved: false, maxCalls: 0 }; }
  };
  const originalRequest = ai.request;
  let modelBusy = false;
  ai.request = async input => {
    if (modelBusy) throw Error('已有模型整理正在执行');
    if (!ai.policy().approved) throw Error('模型单价或预算未批准，未发起请求');
    const budget = readBudget(), key = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const reservations = fs.existsSync(reservationFile) ? JSON.parse(fs.readFileSync(reservationFile, 'utf8')) : [];
    if (!Array.isArray(reservations) || reservations.some(r => !Number.isSafeInteger(r.reservedMicros) || r.reservedMicros <= 0)) throw Error('费用预留账本不可核对，未发起请求');
    const previous = reservations.find(r => r.key === key);
    const receipts = fs.existsSync(path.join(billingDir, 'ai-requests.json')) ? JSON.parse(fs.readFileSync(path.join(billingDir, 'ai-requests.json'), 'utf8')) : [];
    const cached = receipts.find(r => r.hash === key && r.status === 'completed');
    if (cached) { if (previous) { previous.state = 'completed'; writeJsonAtomic(reservationFile, reservations); } return cached.result; }
    if (previous?.state === 'unknown') throw Error('原请求费用及结果待核对，未重复调用');
    if (previous?.state === 'completed') throw Error('历史费用记录存在但结果不可读取，未重复调用');
    if (receipts.length >= budget.maxCalls) throw Error('已达到模型调用次数上限');
    // UTF-8 bytes plus message overhead form a conservative token upper bound.
    const inputBound = Buffer.byteLength(input.prompt, 'utf8') + 1024, outputBound = 3000;
    const reservedMicros = Math.ceil((inputBound * budget.pricing.inputMicrosPerMillion + outputBound * budget.pricing.outputMicrosPerMillion) / 1000000);
    if (!Number.isSafeInteger(reservedMicros) || reservedMicros <= 0 || reservedMicros > budget.costPerCallCeilingMicros || reservations.reduce((sum, r) => sum + r.reservedMicros, 0) + reservedMicros > budget.totalBudgetMicros) throw Error('预计调用超出已批准金额上限，未发起请求');
    const entry = { key, state: 'unknown', reservedMicros, inputBound, outputBound, createdAt: new Date().toISOString() };
    reservations.push(entry); writeJsonAtomic(reservationFile, reservations);
    modelBusy = true;
    try { const result = await originalRequest(input); entry.state = 'completed'; entry.usage = result.usage; writeJsonAtomic(reservationFile, reservations); return result; }
    finally { modelBusy = false; } // Preserve unknown reservation on provider or persistence failure.
  };
  const gateway = async (action, body) => {
    // Public catalogs never fall back to a paid search when a page is blocked.
    if (publicSources && action === 'status') return publicSources.status();
    if (publicSources && action === 'refresh') { publicSources.refresh(); return publicSources.status(); }
    if (publicSources && action === 'search') return publicSources.search(body);
    if (publicSources && action === 'read') return publicSources.read(body.url, { maxAttachments: body.maxAttachments });
    if (!gatewayClient?.isEnabled()) {
      if (action === 'status') return { search: false, read: false, pdf: false, reason: '搜索网关尚未连接；可以先导入原文资料' };
      throw Error('搜索网关尚未连接');
    }
    const response = await gatewayClient.fetch(gatewayClient.url(`/local-acquisition/${action}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 30000
    });
    if (!response.ok) throw Error('来源服务未完成，请保留当前进度');
    return response.json();
  };
  let controller, sync;
  const snapshot = () => ({ ...controller.snapshot(), account: account?.() || null, sync: sync?.status() || { enabled: false, conflicts: [], pending: 0 } });
  const emit = () => { const w = getMainWindow(); if (controller && w && !w.isDestroyed()) w.webContents.send(`${domain}:update`, snapshot()); };
  controller = createPreciseAcquisitionController({ dataDir, mapController, gateway, ai,
    copyText: async value => { if (!clipboard) throw Error('剪贴板不可用'); clipboard.writeText(value); if (clipboard.readText() !== value) throw Error('复制未完成，请重试'); },
    onChange: () => { sync?.schedule(); emit(); } });
  if (account?.()?.namespace) {
    sync = createAcquisitionSync({ dataDir, namespace: account().namespace, getState: controller.exportState, applyRecords: controller.applyRecords,
      onChange: emit, request: async (action, body) => {
        if (!gatewayClient?.isEnabled()) throw Error('同步服务未接通');
        const response = await gatewayClient.fetch(gatewayClient.url(`/local-acquisition/sync/${action}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), maxBytes: 3 * 1024 * 1024 });
        if (!response.ok) throw Error('同步服务不可用'); return response.json();
      } });
    sync.schedule();
  }
  ipcMain.handle(`${domain}:invoke`, async (event, action, payload = {}) => {
    const wc = getMainWindow()?.webContents;
    if (!wc || event.sender !== wc || event.senderFrame !== wc.mainFrame) return { ok: false, code: 'BUSINESS_IPC_FORBIDDEN', error: '当前页面无权操作精准获客' };
    try {
      if (typeof action !== 'string' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('操作参数无效');
      if (action === 'refresh-sources' && publicSources.updateCatalog && gatewayClient?.isEnabled()) {
        try {
          const response = await gatewayClient.fetch(gatewayClient.url('/local-acquisition/catalog'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (response.ok) publicSources.updateCatalog((await response.json()).sources);
        } catch { /* Keep the last locally reviewed catalog while the backend is unavailable. */ }
      }
      if (action === 'sync-now') { await sync?.sync(); return { ok: true, state: snapshot() }; }
      if (action === 'resolve-sync-conflict') { if (!sync) throw Error('同步未启用'); sync.resolve(payload.id, payload.choice); return { ok: true, state: snapshot() }; }
      if (action === 'read-public-source') {
        if (controller.snapshot().busy) throw Error('请先等待当前任务完成');
        if (!publicSources) throw Error('本次运行未启用公开原文读取');
        const result = await publicSources.read(payload.url);
        if (result.status !== 'completed') throw Error(`公开原文未读取：${result.reason}；可以导入已获准的文字版，不自动重试`);
        await controller.dispatch('import-source', { ...result, url: result.resolvedUrl, title: result.title }); return { ok: true, state: snapshot() };
      }
      if (action === 'import-file') {
        const chosen = await dialog.showOpenDialog(getMainWindow(), { title: '导入原文资料', properties: ['openFile'], filters: [{ name: '原文资料', extensions: ['txt', 'md', 'html', 'htm', 'json', 'pdf'] }] });
        if (chosen.canceled) return { ok: true, state: snapshot() };
        const filename = chosen.filePaths[0], size = fs.statSync(filename).size;
        if (size > 20 * 1024 * 1024) throw Error('单个附件最多 20 MB');
        const raw = fs.readFileSync(filename);
        if (raw.length > 20 * 1024 * 1024) throw Error('附件过大');
        const ext = path.extname(filename).toLowerCase();
        let input;
        if (ext === '.json') input = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
        else if (ext === '.pdf') {
          const parsed = await gateway('parse', { kind: 'pdf', content: raw.toString('base64') });
          input = { ...parsed, text: parsed.text || '此 PDF 未提取到可核对文字，请提供文字版', title: path.basename(filename), url: payload.url, parseIncomplete: parsed.parseIncomplete || !parsed.text };
        } else {
          let content = raw.toString('utf8').replace(/^\uFEFF/, '');
          if (['.html', '.htm'].includes(ext)) content = content.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
          input = { text: content, title: path.basename(filename), url: payload.url, parseIncomplete: content.length > 120000 };
        }
        await controller.dispatch('import-source', input); return { ok: true, state: snapshot() };
      }
      if (action === 'open-source') {
        const state = controller.snapshot();
        const value = payload.contactId ? state.enterprises.find(e => e.id === payload.enterpriseId)?.contacts.find(c => c.id === payload.contactId)?.sourceUrl
          : payload.sourceId ? state.sources.find(s => s.id === payload.sourceId)?.url
          : payload.enterpriseId ? state.enterprises.find(e => e.id === payload.enterpriseId)?.sourceUrl : state.cards.find(c => c.id === payload.cardId)?.sourceUrl;
        const url = safeUrl(value); if (!url) throw Error('来源链接缺失或无效');
        await shell.openExternal(url); return { ok: true, state: snapshot() };
      }
      await controller.dispatch(action, payload); return { ok: true, state: snapshot() };
    } catch (error) {
      return { ok: false, error: /^(EACCES|EPERM|EIO|ENOSPC|ENOENT)$/.test(error.code || '') ? '本地资料读写失败，已有文件未覆盖' : String(error.message || '操作未完成'), state: snapshot() };
    }
  });
  return { controller, snapshot, async dispose() { sync?.dispose(); ipcMain.removeHandler(`${domain}:invoke`); await controller.dispose(); } };
}
module.exports = { registerPreciseAcquisitionIpc };
