const { app, BrowserWindow, ipcMain, session, dialog, shell, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { registerBusinessWorkbenchIpc } = require('../src/main/business-workbench-ipc.cjs');
const desktop = path.resolve(__dirname, '..');
const directory = path.join(desktop, '.build', 'business-preview');
const verify = process.argv.includes('--verify');
app.setPath('userData', verify ? fs.mkdtempSync(path.join(directory, 'verification-profile-')) : path.join(app.getPath('appData'), 'xiaoxi-business-workbench-preview'));
let window, registration;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    window = new BrowserWindow({ width: 1320, height: 920, title: '地图与 GEO · 本地验收', backgroundColor: '#f8f4f0', autoHideMenuBar: true,
      webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (verify) window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('Preview renderer:', message); });
    const dataDir = path.join(app.getPath('userData'), 'data');
    if (verify) {
      const { createMapAcquisitionController } = require('../src/main/map-acquisition.cjs');
      const sample = createMapAcquisitionController({ dataDir, adapter: { status: () => ({ state: 'connected', account: { id: 'isolated-fixture', name: '隔离验收账号' } }), collect: async ({ onLead }) => onLead({ poiId: 'acceptance-poi', name: '隔离验收物业企业', city: '嘉兴市', address: '隔离验收地址', industry: '物业', phone: '', sourceUrl: 'https://www.amap.com/place/acceptance-poi' }), dispose() {} } });
      await sample.dispatch('save-task', { city: '嘉兴市', device: '洗地机', keywords: ['物业'] });
      await sample.dispatch('start-task', { taskId: sample.snapshot().tasks[0].id });
      for (let count = 0; count < 50 && sample.snapshot().busy; count++) await new Promise(resolve => setTimeout(resolve, 10));
      sample.dispose();
    }
    const workbenchSession = verify ? { fromPartition: (...args) => {
      const isolated = session.fromPartition(...args);
      isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
      return isolated;
    } } : session;
    registration = registerBusinessWorkbenchIpc({ ipcMain, BrowserWindow, session: workbenchSession, dialog, shell, clipboard, dataDir, getMainWindow: () => window });
    if (verify) session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await window.loadFile(path.join(directory, 'dist/index.html'));
    if (!verify) {
      globalThis.mapPreview = { window, registration };
      window.show();
      window.focus();
      console.log('Login preview ready:', window.getTitle());
      return;
    }
    const evaluate = async script => { try { return await window.webContents.executeJavaScript(script); } catch (error) { throw Error(script.slice(0, 180) + ': ' + error.message); } };
    const capture = async name => { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); fs.writeFileSync(path.join(directory, name), (await window.webContents.capturePage()).toPNG()); };
    const waitFor = async script => { for (let count = 0; count < 100; count++) { if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error('UI condition timed out: ' + script); };
    const click = text => evaluate(`(()=>{const buttons=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()===${JSON.stringify(text)});if(buttons.length!==1)throw Error('Button not unique');buttons[0].click();})()`);
    await waitFor("document.querySelectorAll('.bw-account-row').length===8");
    assert.equal(await evaluate("[...document.querySelectorAll('.bw-account-row')].filter(e=>e.textContent.includes('打开官方登录窗口')).length"), 8);
    await new Promise(resolve => setTimeout(resolve, 100));
    await capture('geo-accounts.png');
    await evaluate("window.xiaoxiGeo.invoke('save-brand',{name:'隔离验收品牌',aliases:['验收品牌'],services:'清洁设备',cases:'仅为隔离验收资料'})");
    await evaluate("window.xiaoxiGeo.invoke('import-keywords',{text:'工厂地面清洁设备怎么选'})");
    await evaluate("window.xiaoxiGeo.invoke('save-article',{title:'隔离验收文章',body:'这是一份本地验收资料。未向任何平台提交。',sources:[]})");
    await click('文章与审稿');
    await waitFor("document.querySelectorAll('.bw-article-choice').length===1");
    await evaluate("document.querySelector('.bw-article-choice').click()");
    await waitFor("document.querySelector('.bw-approval')!==null");
    assert.equal(await evaluate("document.querySelector('.bw-approval button').disabled"), true);
    await capture('geo-review.png');
    await click('地图获客');
    await waitFor("document.querySelector('.map-toolbar')!==null");
    await waitFor("document.querySelector('.map-company')!==null");
    const saved = await evaluate("window.xiaoxiMapAcquisition.invoke('status')");
    assert.equal(saved.ok, true);
    assert.equal(saved.state.tasks[0].rangeMeters, null);
    await evaluate("document.querySelector('.map-company').click()");
    await waitFor("document.querySelector('.map-detail-title')!==null");
    await evaluate("document.querySelector('.map-detail-title button').click()");
    await waitFor("document.querySelector('.map-detail-title button').getAttribute('aria-pressed')==='true'");
    const confirmed = await evaluate("window.xiaoxiMapAcquisition.invoke('status')");
    assert.equal(confirmed.state.leads[0].favorite, true);
    assert.equal(confirmed.state.leads[0].demandLevel, 'none', 'viewing/favoriting is not confirmed demand');
    await capture('map-customer.png');
    const budget = await evaluate("window.xiaoxiGeo.invoke('generate-keywords')");
    assert.equal(budget.ok, false);
    assert.ok(/预算/.test(budget.error));
    const state = await evaluate("window.xiaoxiGeo.invoke('status')");
    assert.ok(state.state.channels.every(channel => !channel.publish));
    await window.setSize(1024, 768);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await capture('map-compact.png');
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify({ passed: true, network: 'blocked', loginEntries: 8, checks: ['real IPC persistence', 'seven publication gates closed', 'paid generation refused', 'article review requires confirmation', 'map default range empty', '1024px no horizontal overflow'], runtime: process.versions.electron }, null, 2));
    await registration.dispose();
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { void registration?.dispose(); });
}
