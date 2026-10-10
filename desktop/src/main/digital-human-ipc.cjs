const { createDigitalHumanService, assertKeys, ID } = require('./digital-human-service.cjs');
const { cleanMessage, fail } = require('./digital-human-provider.cjs');

const DIGITAL_HUMAN_CHANNELS = Object.freeze(Object.fromEntries([
  'capabilities', 'list', 'get', 'import-image', 'import-audio', 'recommend-voice', 'voice-preview', 'voice-select', 'voice-clones', 'voice-train', 'voice-clone-status', 'speech-media', 'create', 'preview', 'confirm', 'refresh', 'resume', 'media', 'images',
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
    'import-audio': async (payload) => {
      assertKeys(payload, []);
      const window = getMainWindow(), settings = { title: '选择自己的口播录音', properties: ['openFile'], filters: [{ name: '录音', extensions: ['wav', 'mp3', 'm4a'] }] };
      const result = await (window ? dialog.showOpenDialog(window, settings) : dialog.showOpenDialog(settings));
      return result.canceled || !result.filePaths?.[0] ? null : service.importAudio(result.filePaths[0]);
    },
    'recommend-voice': (payload) => { assertKeys(payload, ['personAssetId']); return service.recommendVoice(payload.personAssetId); },
    'voice-preview': (payload) => { assertKeys(payload, ['voicePersonaId']); return service.previewVoice(payload.voicePersonaId); },
    'voice-select': (payload) => { assertKeys(payload, ['voicePersonaId', 'characterVoice']); return service.selectVoice(payload.voicePersonaId, payload.characterVoice); },
    'voice-clones': () => service.voiceClones(),
    'voice-train': (payload) => { assertKeys(payload, ['speakerId', 'audioAssetId', 'customerConsent']); return service.trainVoice(payload); },
    'voice-clone-status': (payload) => { assertKeys(payload, ['speakerId', 'operationId']); return service.cloneStatus(payload); },
    create: (payload) => service.create(payload),
    preview: (payload) => service.preview(id(payload)),
    confirm: (payload) => service.confirm(id(payload, ['previewRevision', 'transcriptText']), payload.previewRevision, payload.transcriptText),
    refresh: (payload) => service.refresh(id(payload)),
    resume: (payload) => service.resume(id(payload)),
    media: (payload) => service.media(id(payload)),
    'speech-media': (payload) => service.speechMedia(id(payload)),
    images: (payload) => service.images(id(payload)),
  };
  for (const [name, handler] of Object.entries(operations)) {
    ipcMain.handle(DIGITAL_HUMAN_CHANNELS[name], async (event, payload = {}) => {
      try {
        const window = getMainWindow();
        const trusted = options.isTrustedEvent ? options.isTrustedEvent(event)
          : Boolean(window?.webContents && event.sender === window.webContents && (!event.senderFrame || event.senderFrame === window.webContents.mainFrame));
        if (!trusted) throw fail('digital_human_untrusted_sender', '请在应用主窗口操作。');
        if (['preview', 'confirm', 'resume', 'voice-preview', 'voice-train'].includes(name)) {
          // Caller supplies the same trusted-click policy used for paid content work.
          if (!options.requireTrustedClick) throw fail('digital_human_click_guard_missing', '数字人生成入口尚未完成接入。');
          await options.requireTrustedClick(event, payload, name);
          // The click token is transport-only and is never persisted with a task.
          payload = { ...payload }; delete payload.clickToken;
        }
        return { ok: true, data: await handler(payload) };
      } catch (error) {
        return { ok: false, code: error.code || 'digital_human_operation_failed', error: cleanMessage(error.message || '操作未完成，请稍后重试。'),
          ...(name === 'voice-train' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(String(error.operationId || '')) ? { operationId: error.operationId, outcomeUnknown: error.outcomeUnknown === true } : {}) };
      }
    });
  }
  return { service, close: async () => {
    for (const channel of Object.values(DIGITAL_HUMAN_CHANNELS)) ipcMain.removeHandler(channel);
    await service.close();
  } };
}
module.exports = { registerDigitalHumanIpc, DIGITAL_HUMAN_CHANNELS };
