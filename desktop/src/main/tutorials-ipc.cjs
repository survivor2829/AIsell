const path = require('node:path');
const crypto = require('node:crypto');
const { createTutorialsController } = require('./tutorials.cjs');
const { CONTENT_MEDIA_SCHEME } = require('./content-media-scheme.cjs');

function registerTutorials({ ipcMain, getMainWindow, rootDir, config }) {
  const previews = new Map();
  const controller = createTutorialsController({
    cacheDir: path.join(rootDir, 'tutorials'), baseUrl: config.enabled ? config.origin : '', caPem: config.caPem,
    toPreviewUrl(filename) {
      const id = crypto.createHash('sha256').update(filename).digest('hex');
      previews.set(id, { officialId: id, absolute_path: filename,
        mime_type: { '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(filename)] });
      return `${CONTENT_MEDIA_SCHEME}://official/${id}/preview`;
    },
    emitProgress(value) { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send('tutorials:progress', value); }
  });
  for (const name of ['list', 'play', 'cancel']) ipcMain.handle(`tutorials:${name}`, (event, value) => {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('tutorials_sender_invalid');
    return controller[name](value);
  });
  return { resolveMedia: id => previews.get(id) };
}
module.exports = { registerTutorials };
