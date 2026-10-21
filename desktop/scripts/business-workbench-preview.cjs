// Runs the production panels and IPC in an isolated local profile. No WeChat,
// license, content-engine, paid provider, or publication driver is started.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
const directory = path.join(desktop, '.build', 'business-preview');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: blob:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'; object-src \'none\'"><title>地图与 GEO · 本地验收</title><div id="root"></div><script type="module" src="./entry.tsx"></script></html>');
fs.writeFileSync(path.join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';
import {MapAcquisitionPanel} from '../../src/renderer/MapAcquisitionPanel';
import {GeoWorkbenchPanel} from '../../src/renderer/GeoWorkbenchPanel';
import '../../src/renderer/styles.css';
function Preview(){const [tab,setTab]=React.useState('${process.argv.includes('--map') ? 'map' : 'geo'}');return <div id="preview-scroll" tabIndex={0} style={{height:'100vh',overflowY:'auto',overflowX:'hidden',background:'#f8f4f0'}}><main style={{maxWidth:1280,margin:'0 auto',padding:24,color:'#302a2b',background:'#f8f4f0',minHeight:'100vh','--business-muted':'#6d604f','--business-border':'#e3d1b4','--business-panel':'#fffaf2','--agent-accent-strong':'#49331b'} as React.CSSProperties}><header style={{display:'flex',alignItems:'center',gap:16}}><strong>地图与 GEO · 本地验收</strong><button className="secondary-button" onClick={()=>setTab('map')}>地图获客</button><button className="secondary-button" onClick={()=>setTab('geo')}>GEO 推广</button><small>独立本地会话，发布与付费尚未启用</small></header>{tab==='geo'?<GeoWorkbenchPanel/>:<MapAcquisitionPanel/>}</main></div>};createRoot(document.getElementById('root')!).render(<Preview/>);`);
fs.writeFileSync(path.join(directory, 'vite.config.cjs'), `module.exports={root:${JSON.stringify(directory)},base:'./',build:{outDir:${JSON.stringify(path.join(directory, 'dist'))},emptyOutDir:true},esbuild:{jsx:'automatic'}};`);
fs.writeFileSync(path.join(directory, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');const{createBusinessWorkbenchApi}=require(${JSON.stringify(path.join(desktop, 'src/main/business-workbench-preload.cjs'))});contextBridge.exposeInMainWorld('xiaoxiMapAcquisition',createBusinessWorkbenchApi(ipcRenderer,'map-acquisition'));contextBridge.exposeInMainWorld('xiaoxiGeo',createBusinessWorkbenchApi(ipcRenderer,'geo-workbench'));`);
const built = spawnSync(process.execPath, [path.join(path.dirname(require.resolve('vite')), 'bin/vite.js'), 'build', '--config', path.join(directory, 'vite.config.cjs')], { cwd: desktop, stdio: 'inherit', windowsHide: true });
if (built.status !== 0) process.exit(built.status || 1);
const electron = require('electron');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, 'business-workbench-preview-entry.cjs'), ...process.argv.slice(2).filter(arg => arg === '--verify' || arg === '--map' || /^--(?:remote-debugging-port|inspect)=\d+$/.test(arg))], { cwd: desktop, env: environment, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
