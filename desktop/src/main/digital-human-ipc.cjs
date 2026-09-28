const { createDigitalHumanService, assertKeys, ID } = require('./digital-human-service.cjs');
const { cleanMessage, fail } = require('./digital-human-provider.cjs');

const DIGITAL_HUMAN_CHANNELS = Object.freeze(Object.fromEntries([
  'capabilities', 'list', 'get', 'import-image', 'create', 'preview', 'confirm', 'refresh', 'resume', 'media', 'images',
].map((name) => [name, `digital-human:${name}`])));

function registerDigitalHumanIpc(options = {}) {
  const { ipcMain, dialog, getMainWindow = () => null } = options;
  const service = options.service || createDigitalHumanService(options);
  const id = (payload, extra = []) => {
    assertKeys(payload, ['id', ...extra]);
    if (!ID.test(String(payload.id || ''))) throw fail('digital_human_invalid_id', '请重新选择这条任务。');
    return payload.id;
  };
  const operations = {
    capabilities: () => service.capabilities(),
    list: () => service.list(),
    get: (payload) => service.get(id(payload)),
    'import-image': async (payload) => {
      assertKeys(payload, []);
      const window = getMainWindow();
      const settings = { title: '选择形象或产品图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] };
      const result = await (window ? dialog.showOpenDialog(window, settings) : dialog.showOpenDialog(settings));
      if (result.canceled || !result.filePaths?.[0]) return null;
      return service.importImage(result.filePaths[0]);
    },
    create: (payload) => service.create(payload),
    preview: (payload) => service.preview(id(payload)),
    confirm: (payload) => service.confirm(id(payload, ['previewRevision']), payload.previewRevision),
    refresh: (payload) => service.refresh(id(payload)),
    resume: (payload) => service.resume(id(payload)),
    media: (payload) => service.media(id(payload)),
    images: (payload) => service.images(id(payload)),
  };
  for (const [name, handler] of Object.entries(operations)) {
    ipcMain.handle(DIGITAL_HUMAN_CHANNELS[name], async (event, payload = {}) => {
      try {
        const window = getMainWindow();
        const trusted = options.isTrustedEvent ? options.isTrustedEvent(event)
          : Boolean(window?.webContents && event.sender === window.webContents && (!event.senderFrame || event.senderFrame === window.webContents.mainFrame));
        if (!trusted) throw fail('digital_human_untrusted_sender', '请在应用主窗口操作。');
        if (['preview', 'confirm', 'resume'].includes(name)) {
          // Caller supplies the same trusted-click policy used for paid content work.
          if (!options.requireTrustedClick) throw fail('digital_human_click_guard_missing', '数字人生成入口尚未完成接入。');
          await options.requireTrustedClick(event, payload, name);
          // The click token is transport-only and is never persisted with a task.
          payload = { ...payload }; delete payload.clickToken;
        }
        return { ok: true, data: await handler(payload) };
      } catch (error) {
        return { ok: false, code: error.code || 'digital_human_operation_failed', error: cleanMessage(error.message || '操作未完成，请稍后重试。') };
      }
    });
  }
  return { service, close: async () => {
    for (const channel of Object.values(DIGITAL_HUMAN_CHANNELS)) ipcMain.removeHandler(channel);
    await service.close();
  } };
}
module.exports = { registerDigitalHumanIpc, DIGITAL_HUMAN_CHANNELS };
