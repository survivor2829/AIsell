const { createDigitalHumanService, assertKeys, ID } = require('./digital-human-service.cjs');
const { cleanMessage, fail } = require('./digital-human-provider.cjs');
const { createReferenceHumanService, TASK_ID: REFERENCE_ID } = require('./reference-human-service.cjs');
const { createViralScout } = require('./viral-scout.cjs');
const { createViralPipeline, JOB_ID } = require('./viral-pipeline.cjs');
const { createBailianVideoProvider } = require('./bailian-video-provider.cjs');
const { renderBigtypeCover } = require('./bigtype-cover.cjs');
const { probeMedia } = require('./reference-human-media.cjs');
const path = require('node:path');

const DIGITAL_HUMAN_CHANNELS = Object.freeze(Object.fromEntries([
  'capabilities', 'list', 'get', 'import-image', 'import-audio', 'recommend-voice', 'voice-preview', 'voice-select', 'voice-clones', 'voice-train', 'voice-clone-status', 'speech-media', 'create', 'preview', 'confirm', 'refresh', 'resume', 'media', 'images',
  'reference-capabilities', 'reference-import', 'reference-assets', 'reference-list', 'reference-create', 'reference-get', 'reference-quote', 'reference-prepare', 'reference-confirm', 'reference-refresh', 'reference-resume', 'reference-speech', 'reference-train', 'reference-voice-status', 'reference-write-script', 'reference-repackage',
  'reference-cover-frame', 'reference-cover-quote', 'reference-cover-generate',
  'reference-workspace', 'reference-save-workspace', 'reference-script-quota', 'reference-source-status', 'reference-source-connect', 'reference-source-search', 'reference-source-read',
  'reference-viral-scan', 'reference-viral-stop',
  'reference-viral-pipeline-start', 'reference-viral-pipeline-list', 'reference-viral-pipeline-retry', 'reference-viral-pipeline-remove', 'reference-viral-pipeline-cover',
].map((name) => [name, `digital-human:${name}`])));

function registerDigitalHumanIpc(options = {}) {
  const { ipcMain, dialog, getMainWindow = () => null } = options;
  const service = options.service || createDigitalHumanService(options);
  const reference = options.referenceService || createReferenceHumanService(options);
  // 扒爆款：首次使用时才创建平台窗口；进度推送给主窗口画流图。
  let viralScout = options.viralScout || null;
  const viral = () => viralScout || (viralScout = createViralScout({ BrowserWindow: options.BrowserWindow || require('electron').BrowserWindow, session: options.session || require('electron').session,
    onProgress: (progress) => { const window = getMainWindow(); if (window && !window.isDestroyed?.()) window.webContents.send('digital-human:viral-progress', progress); } }));
  // 一键成片：排队和断点记在数字人目录里；付费环节全部交给写稿回执和本人口播任务。
  const sendPipeline = (state) => { const window = getMainWindow(); if (window && !window.isDestroyed?.()) window.webContents.send('digital-human:viral-pipeline', state); };
  const pipeline = options.viralPipeline || (options.rootDir ? createViralPipeline({ root: options.rootDir, reference, scout: { downloadMedia: (item, target) => viral().downloadMedia(item, target) },
    provider: options.referenceProvider || createBailianVideoProvider(options), ffmpegPath: options.ffmpegPath || 'ffmpeg', fontFile: options.coverFontFile,
    renderCover: renderBigtypeCover, probe: (file) => probeMedia(file, options.ffmpegPath || 'ffmpeg'), resolveVideo: (videoId) => options.resolveGeneratedVideoPath?.(videoId),
    notify: options.notify || (() => {}), onChange: sendPipeline }) : null);
  const pipelineReady = () => { if (!pipeline) throw fail('viral_pipeline_unavailable', '一键成片暂不可用，请重新打开软件。'); return pipeline; };
  const jobId = (payload) => { assertKeys(payload, ['id']); if (!JOB_ID.test(String(payload.id || ''))) throw fail('viral_job_not_found', '找不到这条一键成片任务。'); return payload.id; };
  const referenceId = (payload, extra = []) => {
    assertKeys(payload, ['id', ...extra]);
    if (!REFERENCE_ID.test(String(payload.id || ''))) throw fail('reference_not_found', '请重新选择本人分身任务。');
    return payload.id;
  };
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
    'reference-capabilities': () => reference.capabilities(),
    'reference-workspace': () => reference.workspace(),
    'reference-save-workspace': (payload) => reference.saveWorkspace(payload),
    'reference-script-quota': () => reference.scriptQuota(),
    'reference-source-status': () => reference.sourceStatus(),
    'reference-source-connect': (payload) => reference.sourceConnect(payload),
    'reference-source-search': (payload) => reference.sourceSearch(payload),
    'reference-source-read': (payload) => reference.sourceRead(payload),
    'reference-viral-scan': (payload) => { assertKeys(payload, ['industryIds', 'platforms', 'days']); return viral().scan(payload); },
    'reference-viral-stop': () => { viralScout?.stop(); return { stopped: true }; },
    'reference-viral-pipeline-start': (payload) => {
      assertKeys(payload, ['item', 'maxCny']);
      // 出镜人物、行业和产品资料以本人数字分身里保存的为准，不由页面传入。
      const saved = reference.workspace();
      return pipelineReady().start({ item: payload.item, maxCny: payload.maxCny, assetId: saved.preferences?.referenceAssetId || saved.draft?.referenceAssetId,
        industry: saved.draft?.industry, business: saved.draft?.business });
    },
    'reference-viral-pipeline-list': () => pipelineReady().list(),
    'reference-viral-pipeline-retry': (payload) => pipelineReady().retry(jobId(payload)),
    'reference-viral-pipeline-remove': (payload) => pipelineReady().remove(jobId(payload)),
    'reference-viral-pipeline-cover': (payload) => ({ dataUrl: `data:image/jpeg;base64,${require('node:fs').readFileSync(pipelineReady().coverPath(jobId(payload))).toString('base64')}` }),
    'reference-assets': () => reference.assets(),
    'reference-list': () => reference.list(),
    'reference-import': async (payload) => {
      assertKeys(payload, []);
      const window = getMainWindow(), settings = { title: '选择本人正面口播视频', properties: ['openFile'], filters: [{ name: '真人视频', extensions: ['mp4', 'mov', 'avi'] }] };
      const result = await (window ? dialog.showOpenDialog(window, settings) : dialog.showOpenDialog(settings));
      return result.canceled || !result.filePaths?.[0] ? null : reference.importVideo(result.filePaths[0]);
    },
    'reference-create': (payload) => reference.create(payload),
    'reference-cover-frame': (payload) => reference.coverFrame(referenceId(payload, ['seconds']), payload.seconds),
    'reference-cover-quote': (payload) => reference.coverQuote(referenceId(payload, ['design']), payload.design),
    'reference-cover-generate': (payload) => reference.generateCover(referenceId(payload, ['revision', 'recover']), payload.revision, payload.recover === true),
    'reference-repackage': (payload) => { const taskId = referenceId(payload, ['captionStyleId', 'emphasisPhrases', 'title', 'nextStyle', 'soundEffects']); const { id, ...settings } = payload; return reference.repackage(taskId, settings); },
    'reference-get': (payload) => reference.get(referenceId(payload)),
    'reference-quote': (payload) => reference.quote(referenceId(payload)),
    'reference-prepare': (payload) => reference.prepare(referenceId(payload, ['quoteRevision', 'customerConsent', 'generateVideo']), payload.quoteRevision, payload.customerConsent === true, payload.generateVideo === true),
    'reference-write-script': (payload) => reference.writeScript(payload),
    'reference-confirm': (payload) => reference.confirm(referenceId(payload, ['previewRevision']), payload.previewRevision),
    'reference-refresh': (payload) => reference.refresh(referenceId(payload)),
    'reference-resume': (payload) => reference.resume(referenceId(payload)),
    'reference-speech': (payload) => reference.speechMedia(referenceId(payload)),
    'reference-train': (payload) => reference.trainVoice(payload),
    'reference-voice-status': (payload) => { assertKeys(payload, ['assetId']); return reference.voiceStatus(payload.assetId); },
  };
  for (const [name, handler] of Object.entries(operations)) {
    ipcMain.handle(DIGITAL_HUMAN_CHANNELS[name], async (event, payload = {}) => {
      try {
        const window = getMainWindow();
        const trusted = options.isTrustedEvent ? options.isTrustedEvent(event)
          : Boolean(window?.webContents && event.sender === window.webContents && (!event.senderFrame || event.senderFrame === window.webContents.mainFrame));
        if (!trusted) throw fail('digital_human_untrusted_sender', '请在应用主窗口操作。');
        if (['preview', 'confirm', 'resume', 'voice-preview', 'voice-train', 'reference-prepare', 'reference-confirm', 'reference-resume', 'reference-train', 'reference-write-script', 'reference-cover-generate', 'reference-viral-pipeline-start', 'reference-viral-pipeline-retry'].includes(name)) {
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
  pipeline?.resume();
  const combined = { ...service, isBusy: () => service.isBusy() || reference.isBusy() || Boolean(viralScout?.isBusy()) || Boolean(pipeline?.isBusy()),
    prepareForUpdate: () => { const old = service.prepareForUpdate(), next = reference.prepareForUpdate(); return { busy: old.busy || next.busy }; },
    resumeAfterUpdate: () => { service.resumeAfterUpdate(); reference.resumeAfterUpdate(); } };
  return { service: combined, close: async () => {
    for (const channel of Object.values(DIGITAL_HUMAN_CHANNELS)) ipcMain.removeHandler(channel);
    await pipeline?.close();
    viralScout?.close();
    await Promise.all([service.close(), reference.close()]);
  } };
}
module.exports = { registerDigitalHumanIpc, DIGITAL_HUMAN_CHANNELS };
