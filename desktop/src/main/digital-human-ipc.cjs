const { createDigitalHumanService, assertKeys, ID } = require('./digital-human-service.cjs');
const { cleanMessage, fail } = require('./digital-human-provider.cjs');
const { createReferenceHumanService, TASK_ID: REFERENCE_ID } = require('./reference-human-service.cjs');
const { createViralScout } = require('./viral-scout.cjs');
const { createViralPipeline, JOB_ID } = require('./viral-pipeline.cjs');
const { createBailianVideoProvider } = require('./bailian-video-provider.cjs');
const { renderBigtypeCover } = require('./bigtype-cover.cjs');
const { probeMedia } = require('./reference-human-media.cjs');
const { buildLibrary, validateLibrary, loadLibrary } = require('./viral-library.cjs');
const fs = require('node:fs');
const path = require('node:path');

const DIGITAL_HUMAN_CHANNELS = Object.freeze(Object.fromEntries([
  'capabilities', 'list', 'get', 'import-image', 'import-audio', 'recommend-voice', 'voice-preview', 'voice-select', 'voice-clones', 'voice-train', 'voice-clone-status', 'speech-media', 'create', 'preview', 'confirm', 'refresh', 'resume', 'media', 'images',
  'reference-capabilities', 'reference-import', 'reference-assets', 'reference-list', 'reference-create', 'reference-get', 'reference-quote', 'reference-prepare', 'reference-confirm', 'reference-refresh', 'reference-resume', 'reference-speech', 'reference-train', 'reference-voice-status', 'reference-write-script', 'reference-repackage',
  'reference-cover-frame', 'reference-cover-quote', 'reference-cover-generate',
  'reference-workspace', 'reference-save-workspace', 'reference-script-quota', 'reference-source-status', 'reference-source-connect', 'reference-source-search', 'reference-source-read',
  'reference-viral-scan', 'reference-viral-stop',
  'reference-viral-pipeline-start', 'reference-viral-pipeline-list', 'reference-viral-pipeline-retry', 'reference-viral-pipeline-remove', 'reference-viral-pipeline-cover',
  'reference-viral-library', 'reference-confirm-consent', 'reference-viral-pipeline-start-script', 'reference-viral-library-build', 'reference-viral-library-export',
  'reference-viral-library-publish', 'reference-viral-library-publish-token',
].map((name) => [name, `digital-human:${name}`])));

function registerDigitalHumanIpc(options = {}) {
  const { ipcMain, dialog, getMainWindow = () => null } = options;
  const service = options.service || createDigitalHumanService(options);
  const reference = options.referenceService || createReferenceHumanService(options);
  // 扒爆款：首次使用时才创建平台窗口；进度推送给主窗口画流图。
  let viralScout = options.viralScout || null;
  const viral = () => viralScout || (viralScout = createViralScout({ BrowserWindow: options.BrowserWindow || require('electron').BrowserWindow, session: options.session || require('electron').session, net: options.net || require('electron').net,
    onProgress: (progress) => { const window = getMainWindow(); if (window && !window.isDestroyed?.()) window.webContents.send('digital-human:viral-progress', progress); } }));
  // 一键成片：排队和断点记在数字人目录里；付费环节全部交给写稿回执和本人口播任务。
  const sendPipeline = (state) => { const window = getMainWindow(); if (window && !window.isDestroyed?.()) window.webContents.send('digital-human:viral-pipeline', state); };
  const gatewayProvider = options.referenceProvider || createBailianVideoProvider(options);
  // 最近一次扒取结果：内部发布文案库时用来画流图，重启后从磁盘读回。
  const scanFile = options.rootDir ? path.join(options.rootDir, 'viral-library', 'last-scan.json') : null;
  let lastScan = null;
  // 运营发布密钥：用 Windows 当前用户加密后存在数字人目录里。
  const publishTokenFile = options.rootDir ? path.join(options.rootDir, 'viral-library', 'publish-token.bin') : null;
  const secure = () => options.safeStorage || require('electron').safeStorage;
  const publishToken = {
    saved: () => Boolean(publishTokenFile && fs.existsSync(publishTokenFile)),
    save(value) {
      if (!publishTokenFile) throw fail('viral_library_internal_only', '这是内部功能。');
      if (!value) { fs.rmSync(publishTokenFile, { force: true }); return; }
      if (value.length < 32 || !/^[!-~]+$/u.test(value)) throw fail('viral_library_publish_token_invalid', '发布密钥格式不对，请从服务器配置里完整复制。');
      if (!secure().isEncryptionAvailable()) throw fail('viral_library_secure_storage_unavailable', '无法启用 Windows 账户加密存储。');
      fs.mkdirSync(path.dirname(publishTokenFile), { recursive: true });
      fs.writeFileSync(publishTokenFile, secure().encryptString(value));
    },
    read() {
      if (!publishToken.saved()) throw fail('viral_library_publish_token_missing', '请先填写发布密钥。');
      try { return secure().decryptString(fs.readFileSync(publishTokenFile)); } catch { throw fail('viral_library_publish_token_unreadable', '发布密钥无法在当前 Windows 用户下解密，请重新填写。'); }
    }
  };
  const pipeline = options.viralPipeline || (options.rootDir ? createViralPipeline({ root: options.rootDir, reference, scout: { downloadMedia: (item, target) => viral().downloadMedia(item, target) },
    provider: gatewayProvider, ffmpegPath: options.ffmpegPath || 'ffmpeg', fontFile: options.coverFontFile,
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
    'reference-viral-scan': async (payload) => {
      assertKeys(payload, ['industryIds', 'platforms', 'days']);
      const result = await viral().scan(payload);
      lastScan = result;
      if (scanFile) { fs.mkdirSync(path.dirname(scanFile), { recursive: true }); fs.writeFileSync(scanFile, JSON.stringify(result)); }
      return result;
    },
    'reference-viral-stop': () => { viralScout?.stop(); return { stopped: true }; },
    'reference-viral-pipeline-start': (payload) => {
      assertKeys(payload, ['item', 'maxCny']);
      // 出镜人物、行业和产品资料以本人数字分身里保存的为准，不由页面传入。
      const saved = reference.workspace();
      return pipelineReady().start({ item: payload.item, maxCny: payload.maxCny, assetId: saved.preferences?.referenceAssetId || saved.draft?.referenceAssetId,
        industry: saved.draft?.industry, business: saved.draft?.business });
    },
    'reference-viral-pipeline-list': () => pipelineReady().list(),
    // 客户：从云端读爆款文案库（只读），逐项校验后给页面；读不到时用本地缓存或安装包自带的一份，不让页面空着。
    'reference-viral-library': async () => {
      // 开发版预览：指定了本地文案库文件时读它，并标记为预览数据；客户版永远只读云端。
      const preview = options.developmentEdition ? String(process.env.XIAOXI_VIRAL_LIBRARY_FILE || '').trim() : '';
      if (preview) return { ...validateLibrary(JSON.parse(fs.readFileSync(preview, 'utf8'))), preview: true };
      return loadLibrary({ fetchRemote: () => gatewayProvider.request('/viral-library'),
        cacheFile: options.rootDir ? path.join(options.rootDir, 'viral-library', 'cache.json') : null,
        seedFile: options.viralLibrarySeedFile || path.join(__dirname, '..', '..', 'resources', 'viral-library', 'seed.json') });
    },
    'reference-confirm-consent': (payload) => { assertKeys(payload, ['assetId']); return reference.confirmConsent(payload.assetId); },
    'reference-viral-pipeline-start-script': (payload) => {
      assertKeys(payload, ['libraryItem', 'assetId', 'maxCny']);
      const saved = reference.workspace();
      // 只用页面上这位本人；不认识的 id 直接拒绝，不换成别的已保存人物。
      if (!reference.assets().items.some((a) => a.id === payload.assetId)) throw fail('viral_person_missing', '请先上传本人视频。');
      return pipelineReady().startFromScript({ libraryItem: payload.libraryItem, maxCny: payload.maxCny, assetId: payload.assetId, industry: saved.draft?.industry, business: saved.draft?.business });
    },
    // 内部（只在开发版）：把最近一次扒取的前几条爆款改写成文案库稿子，再导出成待发布文件。
    'reference-viral-library-build': async (payload) => {
      if (!options.developmentEdition) throw fail('viral_library_internal_only', '这是内部功能。');
      assertKeys(payload, ['limit']);
      const scan = lastScan || (scanFile && fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, 'utf8')) : null);
      if (!scan?.items?.length) throw fail('viral_library_scan_missing', '还没有扒取结果，请先扒一次爆款。');
      const saved = reference.workspace(), assetId = saved.preferences?.referenceAssetId || saved.draft?.referenceAssetId;
      const limit = Math.max(1, Math.min(300, Number(payload.limit) || 10));
      // 一条不合格不影响其余条目，也不让已排上的再排一次；上次失败但还能重试的（如下载失败）重新排队。
      const jobs = [], skipped = [];
      for (const item of scan.items.slice(0, limit)) {
        try {
          const job = pipelineReady().start({ item, assetId, industry: '清洁设备渠道商', business: '', mode: 'library' });
          jobs.push(job.status === 'failed' && job.holdsItem ? await pipelineReady().retry(job.id) : job);
        } catch (error) { skipped.push({ id: String(item?.id || ''), error: error.message }); }
      }
      if (!jobs.length && skipped.length) throw fail('viral_library_build_failed', skipped[0].error);
      return { jobs, skipped };
    },
    'reference-viral-library-export': () => {
      if (!options.developmentEdition) throw fail('viral_library_internal_only', '这是内部功能。');
      const scan = lastScan || (scanFile && fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, 'utf8')) : null);
      const library = buildLibrary({ scan, transcripts: pipelineReady().libraryTranscripts() });
      const file = path.join(options.rootDir, 'viral-library', `library-${library.updatedAt.replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(library, null, 1));
      return { file, items: library.items.length, collected: library.stats.collected };
    },
    // 内部（只在开发版）：保存运营发布密钥（Windows 当前用户加密，不进源码和日志）；只返回有没有保存。
    'reference-viral-library-publish-token': (payload) => {
      if (!options.developmentEdition) throw fail('viral_library_internal_only', '这是内部功能。');
      assertKeys(payload, ['token']);
      if (payload.token === undefined) return { saved: publishToken.saved() };
      publishToken.save(String(payload.token || '').trim());
      return { saved: publishToken.saved() };
    },
    // 内部（只在开发版）：把提取好的原口播发布到云端（云端合并进已有的库），再分批拆结构，直到拆完或一轮没有进展。
    // 拆结构是我们内部的 AI 花费，不扣客户额度；一轮失败的条目留着下次发布时再拆。
    'reference-viral-library-publish': async () => {
      if (!options.developmentEdition) throw fail('viral_library_internal_only', '这是内部功能。');
      const token = publishToken.read();
      const scan = lastScan || (scanFile && fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, 'utf8')) : null);
      const library = buildLibrary({ scan, transcripts: pipelineReady().libraryTranscripts() });
      const client = options.gatewayClient;
      if (!client?.isEnabled?.()) throw fail('viral_library_gateway_unavailable', '统一 AI 服务没有连接，不能发布。');
      const post = async (route, body) => {
        const response = await client.fetch(client.url(route), { method: 'POST', operatorToken: token, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body), timeoutMs: 240000, maxBytes: 64 * 1024 });
        let result = null;
        try { result = await response.json(); } catch { /* 下面按状态码报错 */ }
        if (response.status === 401) throw fail('viral_library_publish_token_invalid', '发布密钥不对，请重新填写。');
        if (response.status === 404) throw fail('viral_library_publish_unavailable', '云端还没有开通文案库发布，请先部署网关并配置发布密钥。');
        if (!response.ok || !result?.ok) throw fail('viral_library_publish_failed', `云端没有接收（${response.status}${result?.error ? ` ${result.error}` : ''}）`);
        return result;
      };
      const published = await post('/viral-library/publish', library);
      let structured = 0, missing = published.missingStructure;
      for (let round = 0; missing > 0 && round < 200; round += 1) {
        const step = await post('/viral-library/structure', { limit: 8 });
        structured += step.structured; missing = step.missingStructure;
        if (!step.structured) break;
      }
      return { sent: library.items.length, added: published.added, updated: published.updated, total: published.total, structured, missingStructure: missing };
    },
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
        if (['preview', 'confirm', 'resume', 'voice-preview', 'voice-train', 'reference-prepare', 'reference-confirm', 'reference-resume', 'reference-train', 'reference-write-script', 'reference-cover-generate', 'reference-viral-pipeline-start', 'reference-viral-pipeline-retry', 'reference-confirm-consent', 'reference-viral-pipeline-start-script', 'reference-viral-library-build', 'reference-viral-library-publish'].includes(name)) {
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
