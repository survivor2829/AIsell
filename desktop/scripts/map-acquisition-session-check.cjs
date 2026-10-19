// Electron acceptance for interrupted sessions. All HTTPS is served locally in
// non-persistent partitions; this never reads or clears a user's Amap session.
if (!process.versions.electron) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env: environment, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
  return;
}
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createMapAcquisitionBrowser } = require('../src/main/map-acquisition-browser.cjs');
const { createMapAcquisitionController } = require('../src/main/map-acquisition.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-map-session-check-'));
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(mode) {
  let phase = mode.startsWith('pagination-') ? 'pagination' : mode, target, searchRequests = 0;
  const isolated = session.fromPartition(`map-session-check-${randomUUID()}`);
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !details.url.startsWith('https://www.amap.com/') }));
  await isolated.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.pathname === '/search') searchRequests++;
    if (url.origin !== 'https://www.amap.com') return new Response('', { status: 403 });
    if (url.pathname.endsWith('/_____tmd_____/punish')) return new Response('<!doctype html><meta charset="utf-8">安全验证：请按住滑块', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/detail/get/detail') {
      if (phase === 'network-failure') return Response.error();
      const id = url.searchParams.get('id');
      return new Response(JSON.stringify({ data: { base: { poiid: id, name: `隔离验收物业 ${id}`, city_name: '嘉兴市', address: '嘉兴市南湖区隔离验收地址' } } }), { headers: { 'content-type': 'application/json' } });
    }
    const identity = '<div id="loginbox"><div class="user-panel"><span class="user-name">隔离验收账号</span><span>退出登录</span></div></div>';
    const list = phase === 'empty' ? '<div class="poibox-empty"><p class="empty-sorry">抱歉，在北京市没有找到相关的地点</p></div>'
      : '<ul id="results">' + (phase === 'pagination' ? [11, 12] : phase === 'network-failure' ? [1, 2, 3] : [1, 2]).map(id => `<li class="poibox" id="fixture-${id}"><button class="poi-title" onclick="openDetail(${id})">隔离验收物业 ${id}</button></li>`).join('') + '</ul>'
        + (phase === 'pagination' ? '<div style="height:1800px"></div><button class="paging-next" onclick="goNext(this)">下一页</button>' : '');
    const html = `<!doctype html><meta charset="utf-8"><style>html{scroll-behavior:smooth}li{margin:20px}button{padding:12px}</style>${identity}<input id="searchipt" value="${url.searchParams.get('query') || '嘉兴市 物业'}">${phase === 'pagination' ? '<span class="paging-current">1/2页</span>' : ''}${list}<script>
      async function openDetail(id){
        if(id===2&&${JSON.stringify(phase)}==='expired'){document.querySelector('#loginbox').remove();const login=document.createElement('button');login.textContent='登录';document.body.append(login)}
        if(id===2&&${JSON.stringify(phase)}==='verification'){const node=document.createElement('iframe');node.id='baxia-dialog-content';node.src='/service/poiInfo/_____tmd_____/punish';document.body.append(node)}
        await fetch('/detail/get/detail?id=fixture-'+id);
        if(${JSON.stringify(phase)}==='detail-return')setTimeout(()=>{
          document.querySelector('#results').style.display='none';document.querySelector('#searchipt').value='企业'+id;
          const detail=document.createElement('div');detail.id='detail';detail.innerHTML='<button id="placereturnfixed">返回</button>';document.body.append(detail);
          detail.querySelector('button').onclick=event=>{if(!event.isTrusted)return;detail.remove();document.querySelector('#searchipt').value='嘉兴市 物业';const expand=document.createElement('button');expand.className='amap-search-panctrl';expand.textContent='展开搜索结果';expand.onclick=e=>{if(e.isTrusted){document.querySelector('#results').style.display='block';expand.remove()}};document.body.append(expand)};
        },120);
      }
      function goNext(button){document.querySelector('#results').innerHTML=[21,22].map(id=>'<li class="poibox" id="fixture-'+id+'"><button class="poi-title" onclick="openDetail('+id+')">隔离验收物业 '+id+'</button></li>').join('');button.classList.add('disabled');document.querySelector('.paging-current').textContent='2/2页';if(${JSON.stringify(mode)}.startsWith('pagination-')){const node=document.createElement('iframe');node.id='baxia-dialog-content';node.src='/service/poiInfo/_____tmd_____/punish';document.body.append(node)}}
    </script>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  class IsolatedWindow extends BrowserWindow { constructor(options) { super({ ...options, show: false }); target = this; } }
  const adapter = createMapAcquisitionBrowser({ BrowserWindow: IsolatedWindow, session: { fromPartition: () => isolated } });
  const dataDir = path.join(directory, mode);
  if (mode === 'pagination' || mode === 'pagination-replay') {
    fs.mkdirSync(path.join(dataDir, 'map-acquisition'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'map-acquisition/state.json'), JSON.stringify({ tasks: [{ id: 'page-two', city: '嘉兴市', district: '', device: '清洁设备', keywords: ['物业'], limit: 2, maxMinutes: 1, count: 0, newCount: 0, status: 'paused', checkpoint: { keywordIndex: 0, page: 1, item: mode === 'pagination-replay' ? 1 : 0 } }], leads: [], settings: { limit: 2, maxMinutes: 1 } }));
  }
  const controller = createMapAcquisitionController({ dataDir, adapter });
  async function settled() {
    const deadline = Date.now() + 40000;
    while (controller.snapshot().busy && Date.now() < deadline) await wait(50);
    assert.equal(controller.snapshot().busy, false, `${mode}: task must stop without manual killing`);
    return controller.snapshot();
  }
  try {
    await adapter.open();
    assert.equal((await adapter.refreshAccount()).state, 'connected');
    if (mode !== 'pagination' && mode !== 'pagination-replay') await controller.dispatch('save-task', { city: '嘉兴市', device: '清洁设备', keywords: ['物业'], limit: mode === 'pagination-verification' ? 4 : 2, maxMinutes: 1 });
    const taskId = controller.snapshot().tasks[0].id;
    await controller.dispatch('start-task', { taskId });
    const interrupted = await settled();
    const task = interrupted.tasks[0];
    if (mode === 'pagination-verification' || mode === 'pagination-replay') {
      assert.equal(task.status, 'paused'); assert.equal(task.count, mode === 'pagination-replay' ? 0 : 2);
      assert.equal(task.checkpoint.pendingPage, 1);
      const before = searchRequests;
      // Synthetic fixture only: preserve the window and the second page.
      await target.webContents.executeJavaScript("document.querySelector('#baxia-dialog-content').remove()");
      await adapter.refreshAccount();
      await controller.dispatch('start-task', { taskId });
      const recovered = await settled();
      assert.equal(recovered.tasks[0].status, 'completed');
      assert.equal(recovered.tasks[0].count, mode === 'pagination-replay' ? 1 : 4);
      if (mode === 'pagination-replay') assert.deepEqual(recovered.leads.map(l => l.poiId), ['fixture-22']);
      assert.equal(searchRequests, before, 'resume must not repeat search');
      assert.equal(new Set(recovered.leads.map(lead => lead.poiId)).size, mode === 'pagination-replay' ? 1 : 4);
      results.push({ mode, count: recovered.tasks[0].count, resumedWithoutSearch: true });
      return;
    }
    if (mode === 'network-failure') {
      assert.equal(task.status, 'paused'); assert.equal(task.count, 0);
      assert.equal(task.checkpoint.item, 2, 'skip individual failures, pause on the third'); assert.equal(task.failedCount, 3);
      assert.equal(task.failureCode, 'MAP_DETAIL_CONSECUTIVE_FAILURES');
      assert.equal(task.diagnosticsSaved, true);
      const logFile = path.join(dataDir, 'map-acquisition', 'diagnostics', 'latest-failure.json');
      const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      assert.equal(log.code, task.failureCode);
      assert.equal(log.expectedPoiId, '');
      assert.ok(log.events.some(e => e.event === 'detail-request'));
      assert.ok(log.events.some(e => e.event === 'detail-loading-failed' && e.networkCode.startsWith('net::ERR_')));
      assert.ok(log.events.some(e => e.event === 'detail-failed' && !e.ignored));
      assert.ok(log.events.length <= 100);
      assert.doesNotMatch(JSON.stringify(log), /cookie|authorization|https:\/\//i);
      results.push({ mode, status: task.status, count: task.count, code: task.failureCode, checkpoint: log.checkpoint, logFile, eventCount: log.events.length });
      return;
    }
    if (mode === 'detail-return') {
      assert.equal(task.status, 'completed'); assert.equal(task.count, 2); assert.equal(task.newCount, 2);
      results.push({mode, status:task.status, count:task.count, delayedDetail:true, trustedExpandClick:true}); return;
    }
    if (mode === 'pagination') {
      assert.equal(task.status, 'completed'); assert.equal(task.count, 2);
      assert.equal(task.checkpoint.page, 1);
      assert.deepEqual(interrupted.leads.map(lead => lead.poiId), ['fixture-21', 'fixture-22']);
      const listenerCount = target.webContents.debugger.listenerCount('message');
      const borrowed = createMapAcquisitionBrowser({ BrowserWindow: IsolatedWindow, session: { fromPartition: () => isolated }, existingWindow: target });
      await borrowed.open(); assert.equal((await borrowed.refreshAccount()).state, 'connected');
      await assert.rejects(borrowed.revoke(), /未退出或清理登录/);
      borrowed.dispose(); assert.equal(target.isDestroyed(), false);
      assert.equal(target.webContents.debugger.listenerCount('message'), listenerCount, 'borrowed observer must remove only its own listeners');
      results.push({ mode, status: task.status, count: 2, checkpoint: task.checkpoint, offscreenNextButton: 'scrolled then clicked', sharedWindowPreserved: true });
      return;
    }
    if (mode === 'empty') {
      assert.equal(task.status, 'completed'); assert.equal(task.count, 0);
      assert.match(task.message, /返回 0 个匹配地点/); assert.match(task.message, /北京市/);
      assert.match(task.message, /不代表所选城市/);
      results.push({ mode, status: task.status, count: task.count, sourceMessage: task.checkpoint.sourceMessage });
      return;
    }
    assert.equal(task.status, 'paused'); assert.equal(task.count, 1);
    assert.equal(task.checkpoint.item, 1, 'interruption must not advance past an unread POI');
    assert.equal(adapter.status().state, mode === 'expired' ? 'login_required' : 'verification_required');
    assert.match(task.message, mode === 'expired' ? /登录已失效/ : /手动完成/);
    await controller.dispatch('save-lead', { id: interrupted.leads[0].id, favorite: true });
    phase = 'recovered';
    // This only changes our fixture. No login or verification is performed on
    // a real provider page, and no challenge is automatically solved.
    await target.loadURL('https://www.amap.com/'); await adapter.refreshAccount();
    await controller.dispatch('start-task', { taskId });
    const recovered = await settled();
    assert.equal(recovered.tasks[0].status, 'completed'); assert.equal(recovered.leads.length, 2);
    assert.equal(recovered.leads[0].favorite, true); assert.equal(recovered.tasks[0].checkpoint.item, 2);
    results.push({ mode, interruption: { status: task.status, count: task.count, checkpoint: task.checkpoint, browser: mode === 'expired' ? 'login_required' : 'verification_required' }, recovery: { status: 'completed', count: 2, favoriteRetained: true } });
  } finally { controller.dispose(); }
}
app.whenReady().then(async () => {
  const modes = ['detail-return', 'pagination', 'pagination-verification', 'pagination-replay', 'empty', 'expired', 'verification', 'network-failure'];
  const requestedMode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
  assert.ok(!requestedMode || modes.includes(requestedMode), 'unknown isolated acceptance mode');
  for (const mode of requestedMode ? [requestedMode] : modes) await check(mode);
  const report = { passed: true, authority: 'controlled Electron HTTPS fixtures; not real account expiry or provider CAPTCHA', externalNetwork: 'blocked', originalAccountTouched: false, results };
  fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, artifact: path.join(directory, 'acceptance.json') }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
