const path = require('node:path');
const crypto = require('node:crypto');
const { createOfficialMaterialsController } = require('./official-materials.cjs');
const { CONTENT_MEDIA_SCHEME } = require('./content-media-scheme.cjs');

function registerOfficialMaterials({ ipcMain, getMainWindow, rootDir, appDir, config, gatewayClient, contentEngine, shell }) {
  const previews = new Map();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  const controller = createOfficialMaterialsController({
    seedDir: path.join(appDir, 'resources', 'official-materials'),
    cacheDir: path.join(rootDir, 'official-materials'),
    baseUrl: config.enabled ? config.origin : '',
    caPem: config.caPem,
    getGatewayClient: () => gatewayClient,
    openExternal: (url) => shell.openExternal(url),
    importFiles: async (files) => {
      if (global.__xiaoxiUpdateHold) throw new Error('正在准备更新，请等待或取消更新后继续。');
      await contentEngine.start();
      const result = await contentEngine.importFiles(files);
      return { assetIds: (result.items || []).map(item => item.asset_id).filter(Boolean) };
    },
    toPreviewUrl: (filename) => {
      const absolute = path.resolve(filename);
      const id = crypto.createHash('sha256').update(absolute).digest('hex');
      previews.set(id, { officialId: id, absolute_path: absolute, mime_type: mime[path.extname(absolute).toLowerCase()] });
      return `${CONTENT_MEDIA_SCHEME}://official/${id}/preview`;
    },
    emitSearchUpdate: (value) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send('official-materials:searchUpdate', value);
    }
  });
  for (const name of ['list', 'importMaterial', 'previewMaterial', 'openSource', 'search', 'cancelSearch']) {
    ipcMain.handle(`official-materials:${name}`, async (event, value) => {
      const window = getMainWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('materials_sender_invalid');
      return controller[name](value);
    });
  }
  return { resolveMedia: (id) => previews.get(id), controller };
}
module.exports = { registerOfficialMaterials };
