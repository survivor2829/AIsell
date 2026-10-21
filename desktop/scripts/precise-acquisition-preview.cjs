// Production React/IPC/controllers in a separate profile. --live-public enables
// only the production public reader; paid providers and real accounts stay absent.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const desktop = path.resolve(__dirname, '..'), base = path.join(desktop, '.build/precise-preview');
const livePublic = process.argv.includes('--live-public');
const verify = process.argv.includes('--verify');
const interactive = livePublic && !verify;
function restoreExperience(directory) {
  const marker = path.join(directory, 'restoration.json');
  if (fs.existsSync(marker)) return;
  const runs = path.join(base, 'runs');
  const requested = process.argv.find(v => v.startsWith('--restore-from='))?.slice('--restore-from='.length);
  const candidates = requested ? [path.resolve(requested)] : (fs.existsSync(runs) ? fs.readdirSync(runs).sort().reverse().map(n => path.join(runs, n)) : []);
  const source = candidates.find(run => {
    if (path.dirname(run) !== runs || fs.existsSync(path.join(run, 'acceptance.json')) || fs.existsSync(path.join(run, 'failure.json'))) return false;
    try { const state = JSON.parse(fs.readFileSync(path.join(run, 'data/precise-acquisition/state.json'), 'utf8')); return state.tasks?.length && state.sources?.some(s => s.origin === 'public-original' || /^https:\/\/(?!example\.)/.test(s.url || '')); } catch { return false; }
  });
  const copied = [];
  // Restore business records only: never browser profiles, cookies or billing approvals.
  if (source) for (const domain of ['precise-acquisition', 'map-acquisition']) {
    const from = path.join(source, 'data', domain, 'state.json'), to = path.join(directory, 'data', domain, 'state.json');
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); copied.push(domain); }
  }
  fs.writeFileSync(marker, JSON.stringify({ restoredAt: new Date().toISOString(), source: source || null, copied }, null, 2), { flag: 'wx' });
}
if (!process.versions.electron) {
  const { spawn, spawnSync } = require('node:child_process');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'; object-src \'none\'"><div id="root"></div><script type="module" src="./entry.tsx"></script></html>');
  fs.writeFileSync(path.join(base, 'entry.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{PreciseAcquisitionPanel}from'../../src/renderer/PreciseAcquisitionPanel';import'../../src/renderer/styles.css';createRoot(document.getElementById('root')!).render(<div id="preview-scroll" tabIndex={0} aria-label="精准获客体验页面" style={{height:'100vh',overflowY:'auto',overflowX:'hidden',background:'#f8f4f0'}}><main style={{maxWidth:1280,margin:'0 auto',padding:24,color:'#302a2b',background:'#f8f4f0',minHeight:'100%','--business-muted':'#6d604f','--business-border':'#e3d1b4','--business-panel':'#fffaf2'} as React.CSSProperties}><small>隔离验收 · 不联网，不使用真实账号</small><PreciseAcquisitionPanel/></main></div>);`);
  fs.writeFileSync(path.join(base, 'vite.config.cjs'), `module.exports={root:${JSON.stringify(base)},base:'./',build:{outDir:${JSON.stringify(path.join(base, 'dist'))},emptyOutDir:true},esbuild:{jsx:'automatic'}};`);
  fs.writeFileSync(path.join(base, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');const{createBusinessWorkbenchApi}=require(${JSON.stringify(path.join(desktop, 'src/main/business-workbench-preload.cjs'))});for(const[n,d]of[['xiaoxiPreciseAcquisition','precise-acquisition'],['xiaoxiMapAcquisition','map-acquisition']])contextBridge.exposeInMainWorld(n,createBusinessWorkbenchApi(ipcRenderer,d));`);
  const build = spawnSync(process.execPath, [path.join(path.dirname(require.resolve('vite')), 'bin/vite.js'), 'build', '--config', path.join(base, 'vite.config.cjs')], { cwd: desktop, stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) process.exit(build.status || 1);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: !interactive, stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code || 0; }); child.on('error', e => { console.error(e.message); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain, session, clipboard, shell } = require('electron');
  const { registerBusinessWorkbenchIpc } = require('../src/main/business-workbench-ipc.cjs');
  const directory = interactive ? path.join(base, 'interactive') : path.join(base, 'runs', new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', path.join(directory, 'profile'));
  let window, registration, closing = false;
  const foreground = () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
  const ownsProfile = !interactive || app.requestSingleInstanceLock();
  if (!ownsProfile) app.quit();
  app.on('second-instance', foreground);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (registration && !closing) { event.preventDefault(); closing = true; void registration.dispose().finally(() => app.quit()); } });
  if (ownsProfile) app.whenReady().then(async () => {
    if (interactive) restoreExperience(directory);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, cb) => cb({ cancel: true }));
    const dataDir = path.join(directory, 'data'); fs.mkdirSync(path.join(dataDir, 'map-acquisition'), { recursive: true });
    const legacyFile = path.join(dataDir, 'map-acquisition/state.json');
    if (!fs.existsSync(legacyFile)) fs.writeFileSync(legacyFile, JSON.stringify({ tasks: [], settings: { limit: 100, maxMinutes: 30 }, leads: livePublic ? [] : [{ id: 'fixture-map-enterprise', poiId: 'fixture', source: 'amap', name: '隔离验收保洁公司', address: '嘉兴市南湖区', city: '嘉兴市', phone: '0000-1234567', phoneType: 'landline', sourceUrl: 'https://www.amap.com/place/fixture', favorite: true, evidence: [], followUps: [{ id: 'fixture-follow-up', content: '原有跟进保留（隔离样本）', createdAt: new Date().toISOString() }], collectedAt: new Date().toISOString(), demandLevel: 'none' }] }));
    const w = new BrowserWindow({ width: 1320, height: 980, show: !verify, title: '精准获客 · 隔离验收', webPreferences: { preload: path.join(base, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    window = w;
    let clip = '', originalFixture;
    registration = registerBusinessWorkbenchIpc({ ipcMain, BrowserWindow, session, dataDir, domains: ['map-acquisition'], getMainWindow: () => w,
      ...(livePublic ? { mapAdapter: { status: () => ({ state: 'unavailable', capabilities: {}, message: '本次隔离验收不访问高德账号' }) } } : {}),
      publicSources: livePublic ? require('../src/main/precise-public-sources.cjs').createPublicSources() : {
      status: () => ({ search: false, read: true, reason: '隔离验收：搜索尚未连接', sources: [{ id: 'fixture', name: '隔离原文来源', enabled: true, scope: '仅本地验收样本' }] }),
      read: async url => url === 'https://example.com/fixture' ? originalFixture : { status: 'unavailable', reason: 'PUBLIC_SOURCE_NOT_AUTHORIZED' }
    },
      clipboard: interactive ? clipboard : { writeText: v => { clip = v; }, readText: () => clip }, shell: interactive ? shell : { openExternal: async () => {} }, dialog: {} });
    await w.loadFile(path.join(base, 'dist/index.html'));
    if (livePublic) await w.webContents.executeJavaScript("document.querySelector('main>small').textContent='公开来源真实验收 · 独立数据 · 不访问高德账号 · 不付费、不联系客户'");
    if (!verify) { foreground(); console.log('Isolated preview:', directory); return; }
    const evaluate = js => w.webContents.executeJavaScript(js);
    const waitFor = async js => { for (let i = 0; i < 100; i++) { if (await evaluate(js)) return; await new Promise(r => setTimeout(r, 50)); } throw Error('UI condition not reached: ' + js); };
    const click = label => evaluate(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!n||n.disabled)throw Error('Unavailable button');n.click()})()`);
    const fill = (label, value) => evaluate(`(()=>{const n=[...document.querySelectorAll('label')].find(n=>n.firstChild?.textContent===${JSON.stringify(label)})?.querySelector('input,textarea');if(!n)throw Error('Field missing');Object.getOwnPropertyDescriptor(n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const verifyScrolling = async () => {
      const dimensions = await evaluate(`(()=>{const n=document.querySelector('#preview-scroll');n.scrollTop=0;n.focus();return {height:n.clientHeight,content:n.scrollHeight,overflow:getComputedStyle(n).overflowY}})()`);
      assert.equal(dimensions.overflow, 'auto'); assert.ok(dimensions.content > dimensions.height, 'real detail content must overflow the dedicated container');
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' });
      await waitFor("document.querySelector('#preview-scroll').scrollTop>0");
      await evaluate("document.querySelector('#preview-scroll').scrollTop=0");
      w.webContents.sendInputEvent({ type: 'mouseWheel', x: 30, y: 200, deltaY: -300, deltaX: 0, canScroll: true });
      await waitFor("document.querySelector('#preview-scroll').scrollTop>0");
      await evaluate("(()=>{const n=document.querySelector('#preview-scroll');n.scrollTop=n.scrollHeight})()");
      assert.equal(await evaluate("(()=>{const n=document.querySelector('#preview-scroll');return Math.abs(n.scrollHeight-n.clientHeight-n.scrollTop)<2})()"), true, 'follow-up area is reachable');
      await evaluate("document.querySelector('#preview-scroll').scrollTop=0");
    };
    await waitFor("document.querySelector('.pa-search-bar')!==null");
    if (livePublic) {
      await evaluate(`window.__batchProof={updates:0,pendingUpdates:0,earlyCards:0,earlyDomRows:0};window.xiaoxiPreciseAcquisition.onUpdate(s=>{const p=window.__batchProof;p.updates++;p.pending=!!s.batchPending;if(p.pending){p.pendingUpdates++;p.earlyCards+=s.cards.length;}});window.__batchDomTimer=setInterval(()=>{if(window.__batchProof.pending)window.__batchProof.earlyDomRows+=document.querySelectorAll('.pa-workbench .bw-lead').length},20);`);
      await click('服务设置'); await fill('服务城市', '杭州市');
      for (const { name } of require('../src/shared/cleaning-equipment.json')) {
        await evaluate(`(()=>{const l=[...document.querySelectorAll('label.bw-check')].find(n=>n.textContent.trim()===${JSON.stringify(name)});const n=l?.querySelector('input');if(!n)throw Error('Equipment option missing');if(!n.checked)n.click()})()`);
      }
      await click('保存设置'); await waitFor("document.querySelector('.pa-search-bar strong').textContent==='杭州市'");
      await click('帮我找客户');
      const deadline = Date.now() + 7 * 60_000;
      let actual;
      do {
        actual = await evaluate("window.xiaoxiPreciseAcquisition.invoke('status')");
        if (actual.ok && actual.state.tasks.length && !actual.state.busy) break;
        await new Promise(r => setTimeout(r, 250));
      } while (Date.now() < deadline);
      await evaluate('clearInterval(window.__batchDomTimer)');
      const proof = await evaluate('window.__batchProof');
      const report = { passed: false, mode: 'live-public', network: 'production allowlisted public reader only; renderer external network blocked', originalAccountTouched: false, paidProviders: false, clipboard: 'isolated memory', directory, proof, state: actual.state };
      fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
      assert.equal(actual.ok, true); assert.equal(actual.state.busy, false, 'automatic batch must finish without a manual resume');
      assert.ok(proof.pendingUpdates > 0); assert.equal(proof.earlyCards, 0, 'pending snapshots must not expose partial cards'); assert.equal(proof.earlyDomRows, 0, 'pending UI must not show partial cards');
      const card = actual.state.cards.find(c => c.bucket === 'recommended');
      assert.ok(card, 'real directory discovery must produce a currently valid recommendation');
      assert.ok(card.evidence.length && card.deadline && card.participationDeadline && card.address && card.equipment.length, 'recommendation must retain source facts and participation window');
      assert.equal(actual.state.enterprises.some(e => e.mapLeadIds.length), false, 'no synthetic map data');
      await waitFor(`document.body.innerText.includes(${JSON.stringify(card.projectName)})`); await click(card.projectName);
      await evaluate("(()=>{const n=document.querySelector('button[aria-label=收藏企业]');if(!n)throw Error('Favorite button missing');n.click()})()");
      await waitFor("[...document.querySelectorAll('button')].some(n=>n.textContent.trim()==='复制电话'&&!n.disabled)");
      await click('复制电话'); await fill('跟进结果', '真实公开来源界面验收：仅保存本地记录，未联系客户'); await click('保存跟进');
      await waitFor("window.xiaoxiPreciseAcquisition.invoke('status').then(r=>r.state.enterprises.some(e=>e.followUps.some(f=>f.content.includes('真实公开来源界面验收'))))");
      actual = await evaluate("window.xiaoxiPreciseAcquisition.invoke('status')");
      assert.equal(actual.state.copyEvents.length, 1); assert.ok(card.contacts.some(c => c.phone === clip));
      assert.ok(actual.state.enterprises.some(e => e.favorite && e.followUps.some(f => f.content.includes('真实公开来源界面验收'))));
      await evaluate('window.scrollTo(0,0)');
      w.setSize(1321, 980); await new Promise(r => setTimeout(r, 150)); w.setSize(1320, 980); await new Promise(r => setTimeout(r, 150));
      fs.writeFileSync(path.join(directory, 'desktop.png'), (await w.webContents.capturePage()).toPNG());
      w.setSize(1024, 820); await new Promise(r => setTimeout(r, 200));
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      await verifyScrolling();
      fs.writeFileSync(path.join(directory, 'compact.png'), (await w.webContents.capturePage()).toPNG());
      Object.assign(report, { passed: true, state: actual.state, checks: ['Hangzhou settings and shared equipment catalog', 'real public directory discovery', 'automatic fact and attachment verification', 'batch publication without early cards', 'real recommendation', 'favorite', 'isolated copy receipt', 'local follow-up', '1024px layout'] });
      fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, mode: report.mode, directory, recommendations: actual.state.cards.filter(c => c.bucket === 'recommended').length, checks: report.checks }));
      await registration.dispose(); app.exit(0); return;
    }
    await click('服务设置'); await fill('服务城市', '嘉兴市'); await click('保存设置');
    await waitFor("document.querySelector('.pa-search-bar strong').textContent==='嘉兴市'");
    await click('帮我找客户'); await waitFor("document.querySelector('.pa-task')?.textContent.includes('尚未连接')");
    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const content = `隔离验收园区采购项目 嘉兴市 南湖区 隔离验收保洁公司 洗地机采购询价 日期${day} 截止${future}`;
    originalFixture = { status: 'completed', title: '隔离验收园区采购项目', text: content, resolvedUrl: 'https://example.com/fixture', origin: 'public-original' };
    await click('导入资料'); await fill('原文链接', 'https://example.com/fixture'); await click('读取公开原文');
    await waitFor("document.querySelectorAll('.pa-workbench .bw-lead').length===1");
    await click('隔离验收园区采购项目'); await click('逐项核对事实');
    for (const [label, value] of [['项目名称', '隔离验收园区采购项目'], ['项目城市', '嘉兴市'], ['项目区县', '南湖区'], ['事件日期（原文日期）', day], ['采购截止', future], ['相关单位全称', '隔离验收保洁公司']]) await fill(label, value);
    await click('保存核对');
    await evaluate("[...document.querySelectorAll('nav[aria-label=精准获客列表] button')].find(n=>n.textContent.startsWith('待补联系方式')).click()");
    await waitFor("document.querySelectorAll('.pa-workbench .bw-lead').length===1"); await click('隔离验收园区采购项目');
    await evaluate("(()=>{const n=document.querySelector('select[aria-label=选择地图企业]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,n.options[1].value);n.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await click('已核对，关联资料');
    await evaluate("[...document.querySelectorAll('nav[aria-label=精准获客列表] button')].find(n=>n.textContent.startsWith('推荐商机')).click()");
    await waitFor("document.querySelectorAll('.pa-workbench .bw-lead').length===1"); await click('隔离验收园区采购项目');
    await click('复制电话'); await fill('跟进结果', '隔离验收保存，没有联系客户'); await click('保存跟进');
    await waitFor("document.body.innerText.includes('隔离验收保存，没有联系客户')");
    const actual = await evaluate("window.xiaoxiPreciseAcquisition.invoke('status')");
    assert.equal(actual.state.copyEvents.length, 1); assert.equal(clip, '0000-1234567'); assert.equal(actual.state.cards[0].bucket, 'recommended');
    assert.equal(actual.state.enterprises.find(e=>e.mapLeadIds.length).followUps.length, 2);
    assert.equal(actual.state.tasks.length, 1); assert.equal(actual.state.tasks[0].precise.status, 'unavailable', 'source unavailable is distinct from zero results');
    w.setSize(1321, 980); await new Promise(r => setTimeout(r, 120)); w.setSize(1320, 980); await new Promise(r => setTimeout(r, 120));
    fs.writeFileSync(path.join(directory, 'desktop.png'), (await w.webContents.capturePage()).toPNG());
    w.setSize(1024, 820); await new Promise(r => setTimeout(r, 200));
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    await verifyScrolling();
    fs.writeFileSync(path.join(directory, 'compact.png'), (await w.webContents.capturePage()).toPNG());
    await w.loadFile(path.join(base, 'dist/index.html'));
    await waitFor("document.querySelector('.pa-search-bar')!==null");
    const reopened = await evaluate("window.xiaoxiPreciseAcquisition.invoke('status')");
    assert.equal(reopened.state.copyEvents.length, actual.state.copyEvents.length);
    assert.deepEqual(reopened.state.enterprises, actual.state.enterprises);
    const report = { passed: true, network: 'blocked', originalAccountTouched: false, authority: 'production renderer + preload IPC + controllers; isolated sample source and clipboard', checks: ['settings', 'search unavailable distinguished', 'public-original IPC import', 'fact confirmation', 'missing contact', 'map identity link', 'recommendation', 'copy receipt', 'shared follow-up', '1024px layout', 'PageDown and wheel scrolling', 'scroll to bottom', 'page reopen retains records'], directory };
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    await registration.dispose(); app.exit(0);
  }).catch(error => { fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ passed: false, mode: livePublic ? 'live-public' : 'fixture', error: error.message }, null, 2)); console.error(error.stack); app.exit(1); });
}
