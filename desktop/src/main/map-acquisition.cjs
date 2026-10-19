const fs = require('node:fs');
const path = require('node:path');
const { validateMapRegion } = require('./map-regions.cjs');
const { randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const text = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const bounded = (v, fallback, max) => Math.max(1, Math.min(max, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback));
const clone = (v) => JSON.parse(JSON.stringify(v));
const url = (v) => { try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const fail = (message) => { throw new Error(message); };

function createMapAcquisitionController({ dataDir, adapter, clipboard, onChange = () => {}, onCompleted = () => {}, clock = Date.now, organize }) {
  const file = path.join(dataDir, 'map-acquisition', 'state.json');
  let state = { tasks: [], leads: [], settings: { limit: 10, maxMinutes: 30 } };
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(saved.tasks) || !Array.isArray(saved.leads)) fail('地图数据格式错误'); state = { ...state, ...saved }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let active = null, disposed = false, lastError = '', inFlight = Promise.resolve();
  const now = () => new Date(clock()).toISOString();
  for (const task of state.tasks) if (task.status === 'running') { task.status = 'paused'; task.message = '应用已重启，可从上次位置继续'; }
  const browserStatus = () => adapter?.status?.() || { state: 'unavailable', capabilities: {} };
  const snapshot = () => clone({ ...state, browser: browserStatus(), busy: !!active,
    capabilities: { collect: !!adapter?.collect, validated: false, organize: !!organize, paidBudget: 'unapproved' }, error: lastError });
  function emit() { if (!disposed) onChange(snapshot()); }
  function persist() { if (disposed) return; writeJsonAtomic(file, state); emit(); }
  const taskFor = (id) => state.tasks.find((v) => v.id === id) || fail('任务不存在');
  const leadFor = (id) => state.leads.find((v) => v.id === id) || fail('企业不存在');
  function ingest(task, input) {
    if (!text(input.name, 200)) return;
    const source = 'amap', poiId = text(input.poiId, 200);
    let lead = poiId && state.leads.find((v) => v.source === source && v.poiId === poiId);
    const isNew = !lead;
    const fields = { name: text(input.name, 200), address: text(input.address, 500), industry: text(input.industry, 200),
      phone: text(input.phone, 200), phoneType: !text(input.phone) ? 'missing' : /1[3-9]\d{9}/.test(input.phone) ? 'mobile' : 'landline',
      city: task.city, district: task.district || '', sourceUrl: url(input.sourceUrl), collectedAt: now(), matchReason: text(input.matchReason || `${task.city} · ${task.device} · ${task.keywords.join('、')}`, 500) };
    if (!lead) {
      lead = { id: randomUUID(), source, poiId, ...fields, favorite: false, taskIds: [], evidence: [], followUps: [], demandLevel: 'none',
        suspectedDuplicate: !poiId && state.leads.some((v) => v.name === fields.name && v.address === fields.address) };
      state.leads.push(lead);
    } else {
      // Source refreshes must not erase a usable phone or the user's annotations.
      for (const key of ['phone', 'address', 'industry', 'matchReason']) {
        if (!fields[key] || (['industry', 'matchReason'].includes(key) && lead[key])) fields[key] = lead[key];
      }
      fields.phoneType = !fields.phone ? 'missing' : /1[3-9]\d{9}/.test(fields.phone) ? 'mobile' : 'landline';
      Object.assign(lead, fields);
    }
    if (!lead.taskIds.includes(task.id)) { lead.taskIds.push(task.id); task.count = (task.count || 0) + 1; if (isNew) task.newCount = (task.newCount || 0) + 1; }
    task.phoneCount = state.leads.filter(value => value.taskIds?.includes(task.id) && value.phone).length;
    persist();
  }
  async function run(task) {
    if (active) fail('已有地图采集任务正在运行');
    validateMapRegion(task.city, task.district, task.province);
    if (!adapter?.collect) fail('地图浏览器尚未连接');
    if (!['connected'].includes(browserStatus().state)) fail('请先连接高德，并刷新确认登录状态');
    const token = { taskId: task.id, stopped: false };
    active = token; task.status = 'running'; task.message = '正在读取地图'; task.startedAt = now(); lastError = '';
    delete task.failureCode; delete task.diagnosticsSaved; delete task.stopReason; persist();
    const deadline = clock() + task.maxMinutes * 60_000;
    const shouldContinue = () => !disposed && !token.stopped && clock() < deadline && (task.count || 0) < task.limit;
    const timer = setTimeout(() => { token.stopped = true; task.message = '已达到运行时间上限'; adapter?.cancel?.(); }, task.maxMinutes * 60_000);
    timer.unref?.();
    // Dispatch returns immediately; every intermediate result and cursor is atomic.
    inFlight = (async () => {
      try {
        await adapter.collect({ task: clone(task), shouldContinue, onLead: (lead) => { if (shouldContinue()) ingest(task, lead); },
          onOutcome: ({ key, outcome, code }) => {
            task.outcomes ||= {};
            const previous = task.outcomes[key];
            if (!previous || previous.outcome !== outcome) {
              task.outcomes[key] = { outcome, code };
              task.processedCount = (task.processedCount || 0) + (previous ? 0 : 1);
              if (previous?.outcome === 'failed') task.failedCount = Math.max(0, (task.failedCount || 0) - 1);
              if (previous?.outcome === 'skipped') task.skippedCount = Math.max(0, (task.skippedCount || 0) - 1);
              if (outcome === 'skipped') task.skippedCount = (task.skippedCount || 0) + 1;
              if (outcome === 'failed') task.failedCount = (task.failedCount || 0) + 1;
              persist();
            }
          },
          onCheckpoint: (checkpoint) => { if (!disposed) { task.checkpoint = clone(checkpoint); persist(); } },
          onProgress: (message) => { task.message = text(message, 500); persist(); } });
        task.status = token.stopped || clock() >= deadline ? 'paused' : 'completed';
        task.stopReason = clock() >= deadline ? 'time_limit' : token.stopped ? 'user_paused' : (task.count || 0) >= task.limit ? 'limit_reached' : 'results_exhausted';
        if (task.status === 'completed') task.message = (task.count || 0) >= task.limit ? '已达到本次企业上限'
          : !task.count && task.checkpoint?.empty ? `本次搜索返回 0 个匹配地点；高德提示：${text(task.checkpoint.sourceMessage || '无匹配结果', 200)}。不代表所选城市没有此类企业。`
          : '本次页面采集结束，未保证覆盖整个城市';
      } catch (error) {
        task.status = 'paused'; task.message = text(error.message, 500); lastError = task.message;
        task.stopReason = browserStatus().state === 'verification_required' ? 'verification_required' : browserStatus().state === 'login_required' ? 'login_required' : 'page_error';
        task.failureCode = /^MAP_DETAIL_[A-Z_]+$/.test(error.code || '') ? error.code : 'MAP_TASK_FAILED';
        if (adapter?.diagnostics) {
          try {
            writeJsonAtomic(path.join(dataDir, 'map-acquisition', 'diagnostics', 'latest-failure.json'), {
              ...adapter.diagnostics(), at: now(), taskId: task.id, code: task.failureCode,
              checkpoint: { keywordIndex: task.checkpoint?.keywordIndex ?? 0, page: task.checkpoint?.page ?? 0, item: task.checkpoint?.item ?? 0 }
            });
            task.diagnosticsSaved = true;
          } catch { task.diagnosticsSaved = false; } // A log write failure must not hide the acquisition error.
        }
      }
      finally { if (token.finish) { task.status = 'completed'; task.stopReason = 'user_finished'; task.message = '已结束本次，已保存结果保留'; } clearTimeout(timer); if (active === token) active = null; task.updatedAt = now(); persist(); if (!disposed && task.status === 'completed') { try { onCompleted(task.id); } catch { /* Window feedback must not change saved results. */ } } }
    })();
  }
  async function dispatch(action, payload = {}) {
    if (disposed) fail('地图模块已关闭');
    switch (action) {
      case 'status': return snapshot();
      case 'save-task': {
        let task = payload.id ? taskFor(payload.id) : null;
        if (task && (task.status !== 'draft' || task.count || task.processedCount)) fail('已开始的任务请通过新建任务修改搜索范围');
        const keywords = (Array.isArray(payload.keywords) ? payload.keywords : String(payload.keywords || payload.device || '').split(/[,，\n]/)).map((v) => text(v, 100)).filter(Boolean).slice(0, 20);
        if (!text(payload.city, 100) || !text(payload.device, 100) || !keywords.length) fail('请填写城市、设备服务方向和关键词');
        validateMapRegion(text(payload.city, 100), text(payload.district, 100), text(payload.province, 100));
        const value = { province: text(payload.province, 100), city: text(payload.city, 100), device: text(payload.device, 100), keywords, district: text(payload.district, 100), address: text(payload.address, 300),
          rangeMeters: payload.rangeMeters ? bounded(payload.rangeMeters, 1000, 50000) : null, limit: bounded(payload.limit, state.settings.limit, 10000), maxMinutes: bounded(payload.maxMinutes, state.settings.maxMinutes, 180), updatedAt: now() };
        const previous = payload.continueTaskId ? taskFor(payload.continueTaskId) : null;
        if (previous && (previous.status === 'running' || ['city', 'district', 'device', 'address', 'rangeMeters', 'keywords'].some(key => JSON.stringify(previous[key]) !== JSON.stringify(value[key])))) fail('续批范围必须与原地图任务一致，且原任务已停止');
        if (task && previous) fail('续批只能新建任务');
        if (task) Object.assign(task, value); else { task = { id: randomUUID(), ...value, status: 'draft', count: 0, newCount: 0, checkpoint: previous ? clone(previous.checkpoint) : {}, previousBatchId: previous?.id || null, createdAt: now() }; state.tasks.push(task); }
        persist(); return snapshot();
      }
      case 'start-task': {
        const task = taskFor(payload.taskId || payload.id);
        if (task.status === 'completed') fail('本批已结束，请新建搜索或继续找下一批');
        await run(task); return snapshot();
      }
      case 'return-results':
      case 'finish-task': {
        const task = taskFor(payload.taskId || payload.id);
        if (active?.taskId === task.id) {
          active.stopped = true; active.finish = action === 'finish-task'; adapter?.cancel?.();
          await inFlight;
        } else if (action === 'finish-task' && task.status !== 'completed') {
          task.status = 'completed'; task.stopReason = 'user_finished'; task.message = '已结束本次，已保存结果保留'; task.updatedAt = now(); persist();
        }
        onCompleted(task.id); return snapshot();
      }
      case 'pause-task': { const task = taskFor(payload.taskId || payload.id); if (active?.taskId === task.id) { active.stopped = true; adapter?.cancel?.(); } task.status = 'paused'; task.message = '已请求暂停'; persist(); return snapshot(); }
      case 'open-account': await adapter?.open?.(); emit(); return snapshot();
      case 'refresh-account': await adapter?.refreshAccount?.(); emit(); return snapshot();
      case 'revoke-account': if (active) fail('请先暂停任务并等待采集结束'); await adapter?.revoke?.(); emit(); return snapshot();
      case 'save-lead': { const lead = leadFor(payload.leadId || payload.id); if (typeof payload.favorite === 'boolean') lead.favorite = payload.favorite; for (const key of ['industry', 'matchReason']) if (payload[key] !== undefined) lead[key] = text(payload[key], 500); persist(); return snapshot(); }
      case 'save-evidence': {
        const lead = leadFor(payload.leadId); if (!['signal', 'confirmed'].includes(payload.level) || !text(payload.description)) fail('请填写需求等级及依据');
        if (payload.level === 'signal' && (!url(payload.url) || !text(payload.date))) fail('需求信号需填写来源链接和日期');
        if (payload.level === 'confirmed' && (!text(payload.contactIdentity) || !text(payload.confirmedAt) || !text(payload.nextStep))) fail('人工确认需记录联系人身份、确认时间及下一步');
        const evidence = { id: payload.id || randomUUID(), level: payload.level, description: text(payload.description), url: url(payload.url), date: text(payload.date, 50), contactIdentity: text(payload.contactIdentity, 200), confirmedAt: text(payload.confirmedAt, 50), nextStep: text(payload.nextStep, 500), updatedAt: now() };
        const index = lead.evidence.findIndex((v) => v.id === evidence.id); if (index < 0) lead.evidence.push(evidence); else lead.evidence[index] = evidence;
        lead.demandLevel = lead.evidence.some((v) => v.level === 'confirmed') ? 'confirmed' : 'signal'; persist(); return snapshot();
      }
      case 'save-follow-up': { const lead = leadFor(payload.leadId); if (!text(payload.content)) fail('请填写跟进内容'); lead.followUps.push({ id: randomUUID(), content: text(payload.content), nextStep: text(payload.nextStep, 500), contactIdentity: text(payload.contactIdentity, 200), createdAt: now() }); persist(); return snapshot(); }
      case 'copy-phone': {
        const lead = leadFor(payload.leadId);
        if (!lead.phone) fail('这家企业暂无公开电话');
        if (!clipboard?.writeText || !clipboard?.readText) fail('系统剪贴板不可用，请稍后重试');
        await clipboard.writeText(lead.phone);
        if (await clipboard.readText() !== lead.phone) fail('电话未成功复制，请重试');
        (lead.copyEvents ||= []).push({ id: randomUUID(), createdAt: now() });
        persist(); return snapshot();
      }
      case 'save-settings': state.settings = { limit: bounded(payload.limit, state.settings.limit, 10000), maxMinutes: bounded(payload.maxMinutes, state.settings.maxMinutes, 180) }; persist(); return snapshot();
      case 'organize-leads': {
        if (!organize) fail('AI 整理尚未启用，需先确认预算并连接模型');
        if (!Array.isArray(payload.leadIds) || !payload.leadIds.length || payload.leadIds.length > 20) fail('每批请选择 1 至 20 家企业');
        const chosen = [...new Set(payload.leadIds)].map(leadFor);
        const result = await organize(chosen.map(clone));
        if (!Array.isArray(result?.leads)) fail('整理结果格式不完整，未改变原资料');
        for (const item of result.leads) {
          const lead = chosen.find(value => value.id === item.id);
          if (lead && typeof item.summary === 'string') lead.aiSummary = { summary: text(item.summary, 3000), questions: Array.isArray(item.questions) ? item.questions.map(value => text(value, 500)).slice(0, 10) : [], generatedAt: now(), usage: result.usage || null };
        }
        persist(); return snapshot();
      }
      case 'export': {
        const rows = state.leads.filter((v) => (!Array.isArray(payload.leadIds) || payload.leadIds.includes(v.id)) && (!payload.favoriteOnly || v.favorite) && (!payload.query || `${v.name} ${v.address} ${v.industry}`.includes(text(payload.query))));
        const cell = (value) => { let v = String(value ?? ''); if (/^[\s]*[=+@-]/.test(v)) v = `'${v}`; return `"${v.replace(/"/g, '""')}"`; };
        return { csv: '\uFEFF' + [['企业名称', '城市', '地址', '行业', '联系电话', '电话类型', '需求等级', '匹配原因', '来源', '采集时间'], ...rows.map((v) => [v.name, v.city, v.address, v.industry, v.phone, v.phoneType, v.demandLevel, v.matchReason, v.sourceUrl, v.collectedAt])].map((row) => row.map(cell).join(',')).join('\r\n') };
      }
      default: fail('未知地图操作');
    }
  }
  writeJsonAtomic(file, state);
  return { dispatch, snapshot, attachAdapter(value) { if (active) fail('采集运行中'); adapter = value; emit(); }, async dispose() { if (active) { active.stopped = true; adapter?.cancel?.(); taskFor(active.taskId).status = 'paused'; persist(); } disposed = true; await inFlight; adapter?.dispose?.(); } };
}
module.exports = { createMapAcquisitionController };
