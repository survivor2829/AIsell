// App-owned login sessions. Remote pages receive no preload, Node, IPC, or
// developer browser profile. Only the fixed source reader executes in them.
function createNarrationBrowser(platforms) {
  const windows = new Map();
  const securedSessions = new WeakSet();
  const allowed = (value, platform) => {
    try { const u = new URL(value); return u.protocol === 'https:' && platforms[platform].hosts.includes(u.hostname); } catch { return false; }
  };
  function windowFor(platform) {
    const existing = windows.get(platform);
    if (existing && !existing.isDestroyed()) return existing;
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({ width: 1120, height: 800, show: false, title: `${platforms[platform].name} · 行业参考`,
      webPreferences: { partition: `persist:narration-source-${platform}`, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    win.setMenu(null);
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    if (!securedSessions.has(win.webContents.session)) {
      securedSessions.add(win.webContents.session);
      win.webContents.session.on('will-download', (event) => event.preventDefault());
    }
    win.webContents.on('will-navigate', (event, url) => { if (!allowed(url, platform)) event.preventDefault(); });
    win.webContents.on('will-redirect', (event, url) => { if (!allowed(url, platform)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (allowed(url, platform)) void win.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    windows.set(platform, win);
    win.on('closed', () => windows.delete(platform));
    return win;
  }
  async function visit(platform, url, code, show = false) {
    if (!allowed(url, platform)) throw Error('请选择平台的官方链接。');
    const win = windowFor(platform);
    if (show) { win.show(); win.focus(); }
    let timer;
    try {
      return await Promise.race([(async () => {
        await win.loadURL(url);
        if (!code) return;
        const result = await win.webContents.executeJavaScript(code);
        if (result?.blocked) { win.show(); win.focus(); }
        return result;
      })(), new Promise((_, reject) => { timer = setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
        reject(Error('平台加载超时，请重新打开平台登录或粘贴参考文案；其他平台结果仍会保留。'));
      }, 20000); })]);
    } finally { clearTimeout(timer); }
  }
  return { visit, available: () => Boolean(process.versions.electron), close: () => {
    for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
    windows.clear();
  } };
}
module.exports = { createNarrationBrowser };
