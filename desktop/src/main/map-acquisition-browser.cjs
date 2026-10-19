const { randomUUID } = require('node:crypto');
const HOME = 'https://www.amap.com/';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const compact = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const problem = (message) => { throw new Error(message); };
function allowedUrl(value) { try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'amap.com' || u.hostname.endsWith('.amap.com')); } catch { return false; } }
function parseDetail(body) {
  const base = body?.data?.base;
  if (!base || !compact(base.poiid) || !compact(base.name)) return null;
  return { poiId: compact(base.poiid, 200), name: compact(base.name, 200), address: compact(base.address), phone: compact(base.telephone, 200),
    industry: compact(base.category || base.std_t_tag_0_v || base.tag || base.type, 200), city: compact(base.city_name || base.cityname || base.city, 100), district: compact(base.adname, 100),
    sourceUrl: `https://www.amap.com/place/${encodeURIComponent(base.poiid)}` };
}
function inspectPage() {
  const visible = (node) => !!node?.getClientRects?.().length;
  const text = (node) => String(node?.innerText || node?.textContent || '').trim();
  const body = text(document.body);
  const challenge = [...document.querySelectorAll('[class*="captcha"], [id*="captcha"], [role="dialog"]')].some((node) => visible(node) && /拖动滑块|请按住滑块|安全验证|验证失败|点击框体重试/.test(text(node)))
    || [...document.querySelectorAll('iframe#baxia-dialog-content, iframe[src*="/_____tmd_____/punish"]')].some(visible);
  // Both Amap versions keep the signed-in profile in a collapsed own-account
  // menu. Require its logout control; an avatar alone does not prove login.
  const profile = [...document.querySelectorAll('#loginbox .user-panel, .aipc-toolbar__segment--user-avatar ~ .user-panel, .ant-popover .user-panel')]
    .find((node) => /退出登录/.test(text(node)));
  const identity = profile?.querySelector('.user-name') || [...document.querySelectorAll('[class*="user-name"], [class*="username"], .user-info .name, #username')].find((node) => visible(node) && text(node) && !/登录|注册/.test(text(node)));
  const items = [...document.querySelectorAll('li.poibox[id]')].filter((node) => visible(node) && node.querySelector('.poi-title'))
    .map((node) => ({ id: node.id, name: text(node.querySelector('.poi-title')) }));
  const next = document.querySelector('.paging-next');
  const pageNumber = text(document.querySelector('.paging-current')).match(/^(\d+)\s*\//);
  const emptyMessage = text(document.querySelector('.poibox-empty .empty-sorry')) || body.match(/(?:抱歉，[^\n]{0,80})?没有找到相关的地点|在选定范围内没有找到相关的地点/)?.[0] || '';
  const rect = (node) => { if (!node || !visible(node)) return null; const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const loginRequired = [...document.querySelectorAll('#loginbox a, .user-login, .login-btn, button')].some(node => visible(node) && ['登录', '立即登录', '登录/注册'].includes(text(node)));
  return { challenge, loginRequired, accountName: identity ? text(identity).slice(0, 100) : '', items, pageIndex: pageNumber ? Number(pageNumber[1]) - 1 : null,
    empty: !!emptyMessage || /抱歉，在当前分类下没有找到相关地点/.test(body), emptyMessage: emptyMessage.slice(0,200),
    next: next && !/disabled/.test(next.className) && next.getAttribute('aria-disabled') !== 'true' ? rect(next) : null,
    city: text(document.querySelector('#citybox .city, #citybox .city-title, .city-name, .cityname')).slice(0, 100),
    query: document.querySelector('#searchipt, input[placeholder="搜索位置、公交站、地铁站"]')?.value || '' };
}
function createMapAcquisitionBrowser({ BrowserWindow, session, partitionId, existingWindow, allowExistingSearch = false, onStatus = () => {}, onClose = () => {}, Menu, onReturn, onFinish }) {
  const partition = `persist:map-acquisition-${partitionId || randomUUID()}`;
  let window = null, state = 'closed', account = null, canceled = false, generation = 0, captureError = '', captureCode = '';
  let attempt = 0, expectedPoiId = '', lastPage = null;
  const responses = new Map(), details = new Map();
  const events = [];
  const record = (event, fields = {}) => {
    events.push({ at: new Date().toISOString(), event, generation, attempt, ...fields });
    if (events.length > 100) events.shift();
  };
  const current = (entry) => entry.generation === generation && entry.attempt === attempt && entry.poiId === expectedPoiId && !!expectedPoiId && !canceled;
  const captureFailure = (entry, code, message) => {
    record('detail-failed', { requestId: entry.requestId, poiId: entry.poiId, requestGeneration: entry.generation, code, ignored: !current(entry) });
    if (current(entry)) { captureCode = code; captureError = message; }
  };
  const diagnostics = () => ({ generation, attempt, expectedPoiId, windowId: window?.id ?? null, code: captureCode,
    page: lastPage, events: events.map(event => ({ ...event })) });
  const listeners = [];
  const listen = (emitter, event, handler) => { emitter.on(event, handler); listeners.push(() => emitter.removeListener(event, handler)); };
  const removeListeners = () => { for (const remove of listeners.splice(0)) remove(); };
  const status = () => ({ state, account, capabilities: { collect: true, validated: false, nearbyRadius: false }, message: captureError });
  const notify = () => onStatus(status());
  function requireWindow() { if (!window || window.isDestroyed()) problem('请先打开高德授权窗口'); return window; }
  async function evaluate(fn, ...args) { const target = requireWindow(); if (!allowedUrl(target.webContents.getURL())) problem('请返回高德地图页面'); return target.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`); }
  async function navigate(url) {
    if (!allowedUrl(url)) problem('不支持此地图网址');
    const target = requireWindow(); let timer;
    try { await Promise.race([target.loadURL(url), new Promise((_, reject) => { timer = setTimeout(() => { if (!target.isDestroyed()) target.webContents.stop(); reject(new Error('高德页面加载超时，请检查网络后继续')); }, 25000); })]); }
    finally { clearTimeout(timer); }
  }
  async function open() {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return status(); }
    if (!BrowserWindow || !session) problem('地图浏览器环境不可用');
    const isolated = session.fromPartition(partition);
    if (existingWindow && (existingWindow.isDestroyed() || existingWindow.webContents.session !== isolated || !allowedUrl(existingWindow.webContents.getURL()))) problem('当前高德窗口不可复用，未替换窗口或重新搜索');
    isolated.setPermissionRequestHandler((_, __, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    window = existingWindow || new BrowserWindow({ title: '地图获客 · 高德账号', width: 1180, height: 820, autoHideMenuBar: true,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    if (Menu && window.setMenu && onReturn) {
      window.setMenu(Menu.buildFromTemplate([{ label: '返回结果（暂停采集）', click: onReturn }, { label: '结束本次', click: onFinish }]));
      window.setAutoHideMenuBar(false); window.setMenuBarVisibility(true);
    }
    const wc = window.webContents;
    if (!existingWindow) wc.setWindowOpenHandler(({ url }) => { if (allowedUrl(url)) void navigate(url).catch(() => {}); return { action: 'deny' }; });
    for (const event of ['will-navigate', 'will-redirect']) listen(wc, event, (e, url) => { if (!allowedUrl(url)) e.preventDefault(); });
    listen(wc, 'will-attach-webview', (e) => e.preventDefault());
    const interrupted = () => { canceled = true; state = 'interrupted'; notify(); onClose(); };
    listen(wc, 'render-process-gone', interrupted);
    listen(window, 'closed', () => { generation++; canceled = true; window = null; account = null; state = 'closed'; responses.clear(); details.clear(); notify(); onClose(); removeListeners(); });
    listen(wc.debugger, 'detach', () => { record('observer-detached'); if (window && !window.isDestroyed()) interrupted(); });
    listen(wc.debugger, 'message', async (_, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        if (params.redirectResponse && responses.has(params.requestId)) {
          const entry = responses.get(params.requestId);
          record('detail-redirect', { requestId: params.requestId, poiId: entry.poiId, requestGeneration: entry.generation, status: params.redirectResponse.status });
          return; // A redirect retains the original request's task and click ownership.
        }
        if (!allowedUrl(params.request?.url) || new URL(params.request.url).pathname !== '/detail/get/detail') return;
        // Bind at request time, before a task or POI can change while it is in flight.
        const entry = { requestId: params.requestId, poiId: compact(new URL(params.request.url).searchParams.get('id'), 200), generation, attempt };
        if (responses.size >= 100 && !responses.has(params.requestId)) {
          const oldest = responses.keys().next().value;
          captureFailure(responses.get(oldest), 'MAP_DETAIL_OBSERVER_OVERFLOW', '地图详情观察队列已满，已保留位置');
          responses.delete(oldest);
        }
        responses.set(params.requestId, entry);
        record('detail-request', { requestId: entry.requestId, poiId: entry.poiId });
      } else if (method === 'Network.responseReceived') {
        const response = params.response;
        const entry = responses.get(params.requestId);
        const detailResponse = allowedUrl(response?.url) && new URL(response.url).pathname === '/detail/get/detail';
        if (entry || detailResponse) {
          record('detail-response', { requestId: params.requestId, poiId: entry?.poiId || '', requestGeneration: entry?.generation ?? null,
            status: response.status, cached: !!(response.fromDiskCache || response.fromServiceWorker), ignored: !entry || !current(entry) });
          if (!entry) return; // An observer attached mid-request must not claim its response.
          entry.status = response.status;
          entry.detailResponse = detailResponse;
          if (!detailResponse) { captureFailure(entry, 'MAP_DETAIL_REDIRECTED', '地图详情被转到其他页面，已保留位置，请检查高德窗口'); return; }
          if (response.status !== 200) captureFailure(entry, 'MAP_DETAIL_HTTP_ERROR', '地图详情访问受限，请在高德窗口检查后继续');
        }
      } else if (method === 'Network.loadingFailed' && responses.has(params.requestId)) {
        const entry = responses.get(params.requestId); responses.delete(params.requestId);
        record('detail-loading-failed', { requestId: params.requestId, poiId: entry.poiId, requestGeneration: entry.generation,
          networkCode: /^net::ERR_[A-Z_]+$/.test(params.errorText || '') ? params.errorText : 'unknown', canceled: !!params.canceled });
        captureFailure(entry, 'MAP_DETAIL_NETWORK_FAILED', '地图详情请求失败或被中断，已保留位置，请检查高德页面');
      }
      else if (method === 'Network.loadingFinished' && responses.has(params.requestId)) {
        const entry = responses.get(params.requestId); responses.delete(params.requestId);
        record('detail-loading-finished', { requestId: params.requestId, poiId: entry.poiId, requestGeneration: entry.generation,
          bytes: params.encodedDataLength, ignored: !current(entry) });
        if (!current(entry) || entry.status !== 200 || !entry.detailResponse) return;
        let phase = 'body-read';
        try {
          if (params.encodedDataLength > 2 * 1024 * 1024) problem('地图详情响应过大');
          const result = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          if (!current(entry)) { record('detail-read-discarded', { requestId: params.requestId, requestGeneration: entry.generation }); return; }
          const raw = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          if (raw.length > 2 * 1024 * 1024) problem('地图详情响应过大');
          phase = 'body-parse';
          const detail = parseDetail(JSON.parse(raw));
          if (!detail) { captureFailure(entry, 'MAP_DETAIL_INVALID_BODY', '地图详情格式变化或需要验证，已暂停采集'); return; }
          if (detail.poiId !== entry.poiId) {
            record('detail-poi-mismatch', { requestId: params.requestId, expectedPoiId: entry.poiId, receivedPoiId: detail.poiId });
            captureFailure(entry, 'MAP_DETAIL_POI_MISMATCH', '地图详情与点击地点不一致，已保留位置'); return;
          }
          record('detail-parsed', { requestId: params.requestId, poiId: detail.poiId });
          details.set(detail.poiId, detail);
        } catch (error) {
          // Keep useful CDP causes without persisting arbitrary error text or payloads.
          const message = String(error?.message || '');
          const reason = /evicted.*(?:cache|buffer)/i.test(message) ? 'body_evicted'
            : /No resource with given identifier/i.test(message) ? 'body_unavailable'
            : message === '地图详情响应过大' ? 'body_too_large'
            : error instanceof SyntaxError ? 'invalid_json' : 'unknown';
          record('detail-read-failed', { requestId: params.requestId, phase, reason, requestGeneration: entry.generation });
          captureFailure(entry, phase === 'body-read' ? 'MAP_DETAIL_BODY_READ_FAILED' : 'MAP_DETAIL_BODY_PARSE_FAILED', '地图详情暂时无法读取，请检查页面后继续');
        }
      }
    });
    state = 'loading'; notify();
    try {
      // The initial document must exist before waiting for CDP commands.
      if (!existingWindow) await navigate(HOME);
      if (!wc.debugger.isAttached?.()) wc.debugger.attach('1.3');
      let timer;
      try {
        await Promise.race([
          wc.debugger.sendCommand('Network.enable', { maxResourceBufferSize: 2 * 1024 * 1024, maxTotalBufferSize: 4 * 1024 * 1024 }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('地图数据观察器连接超时，请重新打开高德窗口')), 10000); })
        ]);
      } finally { clearTimeout(timer); }
      await wc.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
      state = 'login_required'; notify(); return status();
    } catch (error) {
      if (!existingWindow && window && !window.isDestroyed()) window.destroy();
      removeListeners(); window = null;
      captureError = error?.message || '高德页面加载失败，请重新打开';
      state = 'load_failed'; notify(); throw new Error(captureError);
    }
  }
  async function pageState(ignoreDetailFailure = false) {
    const page = await evaluate(inspectPage);
    lastPage = { path: new URL(requireWindow().webContents.getURL()).pathname, pageIndex: page.pageIndex,
      challenge: !!page.challenge, accountIdentified: !!page.accountName, itemCount: page.items.length };
    if (page.challenge) { record('verification-required'); state = 'verification_required'; notify(); problem('高德需要验证，请在当前窗口手动完成，然后点击继续任务'); }
    if (!page.accountName && page.loginRequired) { state = 'login_required'; account = null; notify(); problem('高德登录已失效，请在当前窗口登录后继续'); }
    if (!page.accountName && !account) { state = 'identity_unavailable'; notify(); problem('页面账号信息暂不可读取，请等待页面就绪后核对'); }
    if (account && page.accountName && page.accountName !== account.name) problem('高德登录账号已变化，请重新确认任务');
    if (captureError && !ignoreDetailFailure) throw Object.assign(new Error(captureError), { code: captureCode });
    return page;
  }
  async function refreshAccount() {
    requireWindow(); captureError = ''; captureCode = '';
    let page = await evaluate(inspectPage);
    if (!page.accountName && !page.challenge) {
      const expanded = await evaluate(() => {
        const avatar = document.querySelector('.user-avatar-button');
        if (!avatar?.getClientRects().length || avatar.classList.contains('ant-popover-open')) return false;
        avatar.click(); return true;
      });
      if (expanded) {
        try { await wait(300); page = await evaluate(inspectPage); }
        finally { await evaluate(() => { const avatar = document.querySelector('.user-avatar-button.ant-popover-open'); avatar?.click(); }).catch(() => {}); }
      }
    }
    if (page.accountName) account = { id: partition, name: page.accountName };
    else if (page.loginRequired && !page.challenge) account = null;
    state = page.challenge ? 'verification_required' : page.loginRequired && !page.accountName ? 'login_required' : account ? 'connected' : 'identity_unavailable'; notify(); return status();
  }
  function click(point) {
    const target = requireWindow(), wc = target.webContents;
    target.focus?.();
    const position = { x: Math.round(point.x), y: Math.round(point.y) };
    wc.sendInputEvent({ type: 'mouseMove', ...position });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', ...position, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', ...position, clickCount: 1 });
  }
  async function targetPoint(kind, id) {
    return evaluate(async (kind, id) => {
      const node = kind === 'poi' ? [...document.querySelectorAll('li.poibox[id]')].find(n => n.id === id)?.querySelector('.poi-title')
        : document.querySelector(kind === 'next' ? '.paging-next' : kind === 'expand' ? '.amap-search-panctrl' : '#placereturnfixed');
      if (!node?.getClientRects().length || /disabled/.test(node.className) || node.getAttribute('aria-disabled') === 'true') return null;
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return r.width && r.height && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && hit && (hit === node || node.contains(hit)) ? { x, y } : null;
    }, kind, id);
  }
  async function readyPoint(kind, id, keepGoing) {
    // Returning from a detail animates the list; two frames alone can still
    // hit the departing panel. Wait for the real target to become clickable.
    for (let poll = 0; poll < 12 && keepGoing(); poll++) {
      await pageState();
      const point = await targetPoint(kind, id);
      if (point) return point;
      await wait(150);
    }
    return null;
  }
  async function expandResults() {
    const collapsed = await evaluate(() => {
      const node = document.querySelector('.amap-search-panctrl');
      return !!node?.getClientRects().length && node.textContent.trim() === '展开搜索结果';
    });
    if (!collapsed) return false;
    const point = await targetPoint('expand');
    if (!point) return false;
    click(point); return true;
  }
  async function navigateSearch(url) {
    await navigate(url);
    if (await evaluate(() => !!document.querySelector('#searchipt'))) return;
    // Amap provides an official classic-page entry; use that UI rather than
    // changing site preferences or assuming the new result DOM is compatible.
    await evaluate(() => {
      const avatar = document.querySelector('.user-avatar-button');
      if (avatar && !avatar.classList.contains('ant-popover-open')) avatar.click();
    });
    await wait(300);
    const switched = await evaluate(() => {
      const item = [...document.querySelectorAll('.user-panel .menu-item')].find(node => node.textContent.trim() === '返回旧版');
      if (!item) return false;
      item.click(); return true;
    });
    if (!switched) problem('当前高德页面不支持已验收的搜索结构，请在官方页面切换旧版后继续');
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await wait(300);
      try { ready = await evaluate(() => !!document.querySelector('#searchipt')); } catch { /* navigation in progress */ }
      if (ready) break;
    }
    if (!ready) problem('高德旧版页面尚未就绪，请检查官方窗口后继续');
    await navigate(url);
  }
  async function collect({ task, shouldContinue, onLead, onCheckpoint, onProgress = () => {}, onOutcome = () => {} }) {
    if (state !== 'connected' || !account) problem('请先登录高德并刷新账号');
    if (task.rangeMeters || task.address) problem('地址附近搜索与半径选择器尚未完成高德页面验收，请清空地址和半径后进行城市关键词搜索');
    canceled = false; captureError = ''; captureCode = ''; generation++; expectedPoiId = ''; details.clear(); lastPage = null; events.length = 0;
    record('collect-start');
    const keepGoing = () => !canceled && shouldContinue();
    let consecutiveFailures = 0, consecutiveRegionSkips = 0;
    const pace = async (ms) => { for (let remaining = ms; remaining > 0 && keepGoing(); remaining -= 200) await wait(Math.min(200, remaining)); };
    let listQuery = '';
    const returnToList = async (poiId, expectDetail = false) => {
      expectedPoiId = ''; captureError = ''; captureCode = '';
      let back;
      // The response can finish before Amap mounts its detail panel. Do not
      // mistake the still-visible old list for a completed return transition.
      for (let poll = 0; poll < (expectDetail ? 20 : 1) && !canceled; poll++) {
        await pageState();
        const currentDetail = await evaluate(id => {
          const panel = document.querySelector('.placebox[data-id]');
          return !id || !panel || panel.getAttribute('data-id') === id;
        }, poiId);
        back = currentDetail ? await targetPoint('back') : null;
        if (back) break;
        await wait(150);
      }
      if (back) click(back);
      for (let poll = 0; poll < 20 && !canceled; poll++) {
        await wait(150);
        const restored = await pageState();
        if (restored.items.length && restored.query === listQuery) return;
        if (restored.query === listQuery && await expandResults()) continue;
        // Amap can replace the back button between hit testing and mouse-up.
        // Re-resolve its visible control instead of navigating/searching again.
        if (poll === 4 || poll === 10) { const point = await targetPoint('back'); if (point) click(point); }
      }
      if (!canceled) problem('企业详情已读取，但返回搜索列表未完成，已保留当前位置');
    };
    const checkpoint = task.checkpoint || {};
    for (let keywordIndex = Number(checkpoint.keywordIndex || 0); keywordIndex < task.keywords.length && keepGoing(); keywordIndex++) {
      const query = [task.city, task.district, task.address, task.keywords[keywordIndex]].filter(Boolean).join(' ');
      listQuery = query;
      let restorePage = keywordIndex === Number(checkpoint.keywordIndex || 0) ? Number(checkpoint.page || 0) : 0;
      let page = await pageState();
      if (page.query === query && !page.items.length && await expandResults()) { await wait(300); page = await pageState(); }
      if (page.query !== query && restorePage >= 0 && Number(checkpoint.item || 0) > 0 && await targetPoint('back')) {
        await returnToList();
        page = await pageState();
      }
      if (keywordIndex === Number(checkpoint.keywordIndex || 0) && Number.isInteger(checkpoint.pendingPage)) {
        const ids = page.items.map(v => v.id).join('|');
        if (page.query !== query || !page.items.length) problem('翻页后的列表尚未恢复，请检查当前高德窗口后继续');
        if (page.pageIndex === checkpoint.pendingPage && ids !== checkpoint.pendingFromIds) {
          if (checkpoint.pendingPage > restorePage) {
            restorePage = checkpoint.pendingPage;
            Object.assign(checkpoint, { page: restorePage, item: 0 });
          }
          delete checkpoint.pendingPage;
          delete checkpoint.pendingFromIds;
          delete checkpoint.pendingFromPage;
          onCheckpoint({ keywordIndex, page: restorePage, item: Number(checkpoint.item || 0) });
        } else if (page.pageIndex !== (checkpoint.pendingFromPage ?? restorePage) || ids !== checkpoint.pendingFromIds) {
          problem('翻页位置与断点不一致，已保留当前页面，请核对后继续');
        }
      }
      const reuse = page.query === query && page.items.length && Number.isInteger(page.pageIndex) && page.pageIndex <= restorePage;
      const initialPage = reuse ? page.pageIndex : 0;
      if (!reuse && existingWindow && !allowExistingSearch) problem('当前页面与任务搜索或断点不一致，已暂停，未重新搜索');
      onProgress(reuse ? `继续当前搜索：${query}，第 ${initialPage + 1} 页` : `正在搜索：${query}`);
      if (!reuse) await navigateSearch(`${HOME}search?query=${encodeURIComponent(query)}`);
      for (let attempt = 0; attempt < 30 && keepGoing(); attempt++) { await wait(300); page = await pageState(); if (page.items.length || page.empty) break; }
      if (!keepGoing()) return;
      if (!page?.items.length && !page?.empty) problem('高德搜索结果结构无法识别，请在地图窗口检查');
      if (page.empty) { onCheckpoint({ keywordIndex: keywordIndex + 1, page: 0, item: 0, empty: true, query, sourceMessage: page.emptyMessage }); continue; }
      for (let pageIndex = initialPage; keepGoing(); pageIndex++) {
        page = await pageState();
        if (!page.items.length) problem('地图结果列表不可见，请展开搜索结果后继续');
        if (pageIndex >= restorePage) {
          const start = pageIndex === restorePage && keywordIndex === Number(checkpoint.keywordIndex || 0) ? Number(checkpoint.item || 0) : 0;
          for (let item = start; item < page.items.length && keepGoing(); item++) {
            const poi = page.items[item];
            const key = `${keywordIndex}:${poi.id}`;
            let detail, failure;
            for (let retry = 0; retry <= 2 && keepGoing(); retry++) {
              await pageState(true); // Login and visible verification always take precedence.
              captureError = ''; captureCode = ''; attempt++; expectedPoiId = poi.id; details.clear();
              const point = await readyPoint('poi', poi.id, keepGoing);
              if (!point) { if (!keepGoing()) return; problem('地图列表无法继续操作，已保留当前位置'); }
              onProgress(`第 ${pageIndex + 1} 页 · 正在读取第 ${item + 1} 家${retry ? `（重试 ${retry}/2）` : ''}`);
              try {
                record('detail-click', { poiId: poi.id, retry, x: Math.round(point.x), y: Math.round(point.y) });
                click(point);
                for (let poll = 0; poll < 30 && !details.has(poi.id) && keepGoing(); poll++) { await wait(300); await pageState(); }
                if (!keepGoing()) return;
                detail = details.get(poi.id);
                if (!detail) {
                  const observed = events.filter(event => event.attempt === attempt);
                  captureCode = observed.some(event => event.event === 'detail-response' && !event.ignored) ? 'MAP_DETAIL_BODY_NOT_READY'
                    : observed.some(event => event.event === 'detail-request' && event.poiId === poi.id) ? 'MAP_DETAIL_RESPONSE_MISSING'
                    : observed.some(event => event.event === 'detail-request') ? 'MAP_DETAIL_UNEXPECTED_REQUEST' : 'MAP_DETAIL_REQUEST_MISSING';
                  record('detail-timeout', { poiId: poi.id, code: captureCode });
                  throw Object.assign(new Error('当前企业详情暂不可读取'), { code: captureCode });
                }
                break;
              } catch (error) {
                if (!keepGoing()) return;
                await pageState(true);
                if (!/^MAP_DETAIL_/.test(error.code || '') || /HTTP_ERROR|REDIRECTED|OBSERVER_OVERFLOW/.test(error.code)) throw error;
                failure = error;
                await returnToList(poi.id);
              }
            }
            if (!keepGoing()) return;
            if (!detail) {
              onOutcome({ key, outcome: 'failed', code: failure?.code || 'MAP_DETAIL_RESPONSE_MISSING' });
              if (++consecutiveFailures >= 3) throw Object.assign(new Error('连续三家企业详情读取失败，已暂停；检查高德页面后可继续'), { code: 'MAP_DETAIL_CONSECUTIVE_FAILURES' });
            } else {
              consecutiveFailures = 0;
              const normalizeCity = v => compact(v).replace(/市$/, '');
              const observedCity = detail.city || page.city;
              const cityMatches = observedCity && normalizeCity(observedCity) === normalizeCity(task.city);
              const districtMatches = !task.district || detail.district === task.district || detail.address.includes(task.district);
              if (!cityMatches || !districtMatches) { onOutcome({ key, outcome: 'skipped', code: observedCity ? 'REGION_MISMATCH' : 'REGION_UNKNOWN' }); consecutiveRegionSkips++; }
              else { consecutiveRegionSkips = 0; onLead(detail); onOutcome({ key, outcome: 'saved' }); }
              if (keepGoing()) await returnToList(poi.id, true);
            }
            onCheckpoint({ keywordIndex, page: pageIndex, item: item + 1 });
            if (consecutiveRegionSkips >= 10) problem('连续10家地区不匹配，已暂停；请检查城市与区县，避免继续空跑');
            await pace(2000);
          }
        }
        if (!keepGoing()) return;
        const next = await pageState(); if (!next.next) break;
        const before = next.items.map((v) => v.id).join('|');
        const nextPoint = await readyPoint('next', undefined, keepGoing);
        if (!nextPoint) problem('下一页按钮当前不可操作，已保留翻页位置');
        await pace(5000);
        if (!keepGoing()) return;
        onCheckpoint({ keywordIndex, page: Math.max(pageIndex, restorePage),
          item: pageIndex < restorePage ? Number(checkpoint.item || 0) : next.items.length,
          pendingPage: pageIndex + 1, pendingFromPage: pageIndex, pendingFromIds: before });
        click(nextPoint);
        let moved = false;
        for (let attempt = 0; attempt < 30 && keepGoing(); attempt++) { await wait(300); page = await pageState(); if (page.items.length && page.items.map((v) => v.id).join('|') !== before) { moved = true; break; } }
        if (!keepGoing()) return;
        if (!moved) problem('地图翻页未得到确认，已保留当前位置');
        if (pageIndex >= restorePage) onCheckpoint({ keywordIndex, page: pageIndex + 1, item: 0 });
      }
      onCheckpoint({ keywordIndex: keywordIndex + 1, page: 0, item: 0 });
    }
  }
  async function revoke() { if (existingWindow) problem('复用窗口的账号由原工作台管理，未退出或清理登录'); canceled = true; if (window && !window.isDestroyed()) window.destroy(); await session.fromPartition(partition).clearStorageData(); account = null; state = 'closed'; notify(); return status(); }
  return { status, diagnostics, open, refreshAccount, collect, revoke, hide() { if (window && !window.isDestroyed()) window.hide(); }, cancel() { canceled = true; }, dispose() { canceled = true; generation++; if (!existingWindow && window && !window.isDestroyed()) window.destroy(); removeListeners(); window = null; responses.clear(); details.clear(); } };
}
module.exports = { createMapAcquisitionBrowser, parseDetail, allowedUrl, inspectPage };
