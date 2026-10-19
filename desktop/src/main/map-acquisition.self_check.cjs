const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMapAcquisitionController } = require('./map-acquisition.cjs');
const { createMapAcquisitionBrowser, parseDetail, allowedUrl, inspectPage } = require('./map-acquisition-browser.cjs');
const { EventEmitter } = require('node:events');
async function check() {
  // CDP cannot be awaited before the initial page exists: that left login blank.
  class LoginWindow extends EventEmitter {
    constructor() {
      super(); this.loaded = false; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.debugger = Object.assign(new EventEmitter(), {
        attach() {}, sendCommand: async () => assert.equal(this.loaded, true, 'load the login page before enabling CDP')
      });
    }
    async loadURL() { this.loaded = true; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const browser = createMapAcquisitionBrowser({ BrowserWindow: LoginWindow, session: {
    fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} })
  } });
  assert.equal((await browser.open()).state, 'login_required');
  browser.dispose();
  let observedWindow;
  class ResponseWindow extends LoginWindow {
    constructor() {
      super(); observedWindow = this;
      this.webContents.getURL = () => 'https://www.amap.com/';
      this.webContents.executeJavaScript = async script => script.includes('scrollIntoView') ? { x: 10, y: 10 }
        : { accountName: '隔离账号', challenge: false, items: [{ id: 'current', name: '隔离物业' }], query: '嘉兴市 物业', pageIndex: 0, city: '嘉兴', next: null };
    }
  }
  const responseBrowser = createMapAcquisitionBrowser({ BrowserWindow: ResponseWindow, session: {
    fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} })
  } });
  await responseBrowser.open(); await responseBrowser.refreshAccount();
  const originalEvaluate = observedWindow.webContents.executeJavaScript;
  observedWindow.webContents.executeJavaScript = async () => ({ accountName: '', challenge: true });
  assert.equal((await responseBrowser.refreshAccount()).state, 'verification_required');
  assert.ok(responseBrowser.status().account, 'verification retains known account identity');
  observedWindow.webContents.executeJavaScript = async () => ({ accountName: '', challenge: false });
  assert.equal((await responseBrowser.refreshAccount()).state, 'connected', 'collapsed profile does not force login');
  observedWindow.webContents.executeJavaScript = originalEvaluate;
  const network = (method, params) => observedWindow.webContents.debugger.listeners('message')[0](null, method, params);
  await network('Network.requestWillBeSent', { requestId: 'old', request: { url: 'https://www.amap.com/detail/get/detail?id=old' } });
  await responseBrowser.collect({ task: { keywords: [] }, shouldContinue: () => false });
  await network('Network.responseReceived', { requestId: 'old', response: { url: 'https://www.amap.com/detail/get/detail?id=old', status: 403 } });
  assert.equal(responseBrowser.status().message, '', 'a request started before this run must not poison it when its response arrives late');
  for (const code of ['MAP_DETAIL_NETWORK_FAILED', 'MAP_DETAIL_BODY_READ_FAILED', 'MAP_DETAIL_POI_MISMATCH', 'MAP_DETAIL_REDIRECTED']) {
    const detailUrl = 'https://www.amap.com/detail/get/detail?id=current&token=must-not-log';
    observedWindow.webContents.debugger.sendCommand = async method => {
      if (method === 'Network.getResponseBody') {
        if (code === 'MAP_DETAIL_BODY_READ_FAILED') throw Error('private-body-error-must-not-log');
        return { body: JSON.stringify({ data: { base: { poiid: 'wrong-poi', name: '错误地点' } } }) };
      }
    };
    observedWindow.webContents.sendInputEvent = event => {
      if (event.type !== 'mouseUp') return;
      void (async () => {
        await network('Network.requestWillBeSent', { requestId: code, request: { url: detailUrl } });
        if (code === 'MAP_DETAIL_NETWORK_FAILED') await network('Network.loadingFailed', { requestId: code, errorText: 'net::ERR_ABORTED', canceled: true });
        else {
          await network('Network.responseReceived', { requestId: code, response: { url: code === 'MAP_DETAIL_REDIRECTED' ? 'https://www.amap.com/verification?token=must-not-log' : detailUrl, status: 200 } });
          await network('Network.loadingFinished', { requestId: code, encodedDataLength: 100 });
        }
      })();
    };
    let saves = 0;
    const outcomes = [], checkpoints = [];
    const work = responseBrowser.collect({ task: { city: '嘉兴市', keywords: ['物业'] }, shouldContinue: () => true,
      onLead: () => saves++, onOutcome: value => outcomes.push(value), onCheckpoint: value => checkpoints.push(value) });
    if (code === 'MAP_DETAIL_REDIRECTED') { await assert.rejects(work, { code }); assert.equal(checkpoints.length, 0); }
    else { await work; assert.equal(outcomes[0].outcome, 'failed'); assert.equal(outcomes[0].code, code); assert.ok(checkpoints.some(c => c.item === 1)); }

    assert.equal(saves, 0);
    const diagnostic = JSON.stringify(responseBrowser.diagnostics());
    assert.match(diagnostic, new RegExp(code));
    assert.doesNotMatch(diagnostic, /must-not-log|private-body-error/);
  }
  responseBrowser.dispose();
  const inspectAccount = (logout) => {
    const profile = { innerText: logout ? '验收昵称\n退出登录' : '登录', querySelector: () => ({ innerText: '验收昵称', getClientRects: () => [] }) };
    return require('node:vm').runInNewContext(`(${inspectPage.toString()})()`, { document: {
      body: { innerText: '' }, querySelector: () => null,
      querySelectorAll: (selector) => selector.startsWith('#loginbox') ? [profile] : []
    } });
  };
  assert.equal(inspectAccount(true).accountName, '验收昵称', 'collapsed own-account menu remains identifiable');
  assert.equal(inspectAccount(false).accountName, '', 'a menu without logout must not establish identity');
  const emptyPage = require('node:vm').runInNewContext(`(${inspectPage.toString()})()`, { document: {
    body: { innerText: '抱歉，在北京市没有找到相关的地点' }, querySelector: () => null, querySelectorAll: () => []
  } });
  assert.equal(emptyPage.empty, true, 'recognize Amap city-specific empty-result text');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-acquisition-check-'));
  let controller, finish, captured;
  const adapter = { status: () => ({ state: 'connected' }), collect: async (options) => { captured = options; await new Promise((resolve) => { finish = resolve; }); } };
  try {
    let copied = '', copyFails = true;
    controller = createMapAcquisitionController({ dataDir, adapter, clipboard: { writeText: value => { copied = value; }, readText: () => copyFails ? '' : copied } });
    await assert.rejects(controller.dispatch('save-task', { city: '湖北省', district: '孝南区', device: '清洁设备', keywords: ['物业'] }), /具体城市/);
    await assert.rejects(controller.dispatch('save-task', { city: '武汉市', district: '孝南区', device: '清洁设备', keywords: ['物业'] }), /区县与城市/);
    await controller.dispatch('save-task', { city: '上海', device: '清洁设备', keywords: ['物业'] });
    const taskId = controller.snapshot().tasks[0].id;
    await controller.dispatch('start-task', { taskId });
    await assert.rejects(controller.dispatch('start-task', { taskId }), /已有/);
    captured.onLead({ poiId: 'A', name: '=示例', phone: '13800000000', address: '上海市路一号' });
    const leadId = controller.snapshot().leads[0].id;
    await controller.dispatch('save-lead', { id: leadId, favorite: true });
    await controller.dispatch('save-follow-up', { leadId, content: '已核对企业信息', nextStep: '预约' });
    await controller.dispatch('save-lead', { id: leadId, industry: '人工行业', matchReason: '人工备注' });
    captured.onLead({ poiId: 'A', name: '=示例', phone: '', industry: '来源行业', matchReason: '来源备注' });
    assert.equal(controller.snapshot().leads[0].phone, '13800000000');
    assert.equal(controller.snapshot().leads[0].industry, '人工行业');
    assert.equal(controller.snapshot().leads[0].matchReason, '人工备注');
    await assert.rejects(controller.dispatch('copy-phone', { leadId }), /未成功复制/);
    assert.equal(controller.snapshot().leads[0].copyEvents, undefined);
    copyFails = false;
    await controller.dispatch('copy-phone', { leadId });
    assert.equal(controller.snapshot().leads[0].copyEvents.length, 1);
    assert.equal(controller.snapshot().leads[0].demandLevel, 'none');
    captured.onLead({ poiId: 'B', name: '另一公司', phone: '13800000000' });
    assert.equal(controller.snapshot().leads.length, 2, 'same phone must not merge businesses');
    assert.equal(controller.snapshot().leads[0].favorite, true);
    assert.equal(controller.snapshot().leads[0].followUps.length, 1);
    assert.equal(controller.snapshot().leads[0].demandLevel, 'none');
    await assert.rejects(controller.dispatch('save-evidence', { leadId, level: 'confirmed', description: '采购' }), /人工确认/);
    await controller.dispatch('save-evidence', { leadId, level: 'signal', description: '招标', url: 'https://example.com/tender', date: '2026-10-15' });
    assert.equal(controller.snapshot().leads[0].demandLevel, 'signal');
    assert.match((await controller.dispatch('export')).csv, /'=示例/);
    captured.onCheckpoint({ keywordIndex: 0, page: 1, item: 2 });
    // A separate reader simulates restart after abrupt process exit.
    const restarted = createMapAcquisitionController({ dataDir, adapter });
    assert.equal(restarted.snapshot().tasks[0].status, 'paused');
    assert.equal(restarted.snapshot().tasks[0].checkpoint.item, 2);
    restarted.dispose();
    await controller.dispatch('pause-task', { taskId }); finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.snapshot().tasks[0].status, 'paused');
    adapter.diagnostics = () => responseBrowser.diagnostics();
    adapter.collect = async () => { throw Object.assign(Error('详情读取失败'), { code: 'MAP_DETAIL_BODY_READ_FAILED' }); };
    await controller.dispatch('start-task', { taskId });
    await new Promise(resolve => setImmediate(resolve));
    const failureLog = JSON.parse(fs.readFileSync(path.join(dataDir, 'map-acquisition', 'diagnostics', 'latest-failure.json'), 'utf8'));
    assert.equal(failureLog.code, 'MAP_DETAIL_BODY_READ_FAILED');
    const originalTask = controller.snapshot().tasks.find(t => t.id === taskId);
    const nextBatch = await controller.dispatch('save-task', { ...originalTask, id: undefined, continueTaskId: taskId });
    assert.deepEqual(nextBatch.tasks.at(-1).checkpoint, originalTask.checkpoint, 'next batch resumes after the last inspected POI');
    assert.equal(nextBatch.tasks.at(-1).count, 0, 'next batch has its own result limit');
    await assert.rejects(controller.dispatch('save-task', { ...originalTask, id: undefined, city: '杭州市', continueTaskId: taskId }), /续批范围/);
    assert.equal(controller.snapshot().tasks[0].diagnosticsSaved, true);
    assert.equal(controller.snapshot().leads[0].favorite, true);
    await assert.rejects(controller.dispatch('organize-leads', { leadIds: [leadId] }), /预算/);
    assert.equal(allowedUrl('https://www.amap.com.evil.test/'), false);
    assert.equal(parseDetail({ data: { base: { poiid: 'A', name: '公司', cityname: '上海市' } } }).city, '上海市');
    const liveShape = parseDetail({ data: { base: { poiid: 'B', name: '物业', city_name: '嘉兴市', std_t_tag_0_v: '物业管理' } } });
    assert.equal(liveShape.city, '嘉兴市', 'use the city_name returned by current Amap details');
    assert.equal(liveShape.industry, '物业管理');
    assert.equal(parseDetail({ data: {} }), null);
    console.log('map-acquisition self-check passed: request ownership, classified detail failures, safe failure log, dedup, recovery, CSV');
  } finally { controller?.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); }
}
if (require.main === module) check().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { check };
