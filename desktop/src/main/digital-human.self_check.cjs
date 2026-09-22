const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createDigitalHumanService } = require('./digital-human-service.cjs');
const { createDigitalHumanProvider, nodeOf, taskIdOf, resultUrl, videoPayload, isPublicAddress, remoteUrl } = require('./digital-human-provider.cjs');

async function checkSlowDraftClick() {
  const listeners = [], expirations = [], calls = [];
  const load = (name, overrides = {}) => {
    const filename = path.join(__dirname, name), realRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, require: (id) => overrides[id] || realRequire(id),
      window: { addEventListener: (_name, listener) => listeners.push(listener) },
      setTimeout: (expire) => expirations.push(expire),
    }, { filename });
    return module.exports;
  };
  const gates = load('preload-api.cjs');
  const { createDigitalHumanApi } = load('digital-human-preload.cjs', { './preload-api.cjs': gates });
  let failSave = false, failPreview = false;
  const api = createDigitalHumanApi({ invoke: async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === 'digital-human:create') {
      // Simulate the one-second real-click gate expiring while disk IPC waits.
      expirations.splice(0).forEach((expire) => expire());
      await Promise.resolve();
      return failSave ? { ok: false, error: 'disk unavailable' } : { ok: true, data: { id: 'saved_draft', status: 'draft' } };
    }
    assert.match(payload.clickToken, /^digital-human:preview:[a-f0-9-]{36}$/u);
    return failPreview ? { ok: false, error: 'provider unavailable' } : { ok: true, data: { id: payload.id, status: 'preview_preparing' } };
  } });
  const click = () => listeners.forEach((listener) => listener({ isTrusted: true, target: {
    closest: (selector) => selector === '[data-xiaoxi-digital-human-action="preview"]' ? {} : null,
  } }));
  click();
  assert.equal((await api.saveAndPreview({ script: 'sample' })).data.status, 'preview_preparing');
  assert.deepEqual(calls.map((item) => item.channel), ['digital-human:create', 'digital-human:preview']);
  assert.equal((await api.saveAndPreview({})).ok, false, 'A consumed click cannot be reused.');
  assert.equal(calls.length, 2);
  failSave = true; click();
  assert.equal((await api.saveAndPreview({})).ok, false);
  assert.equal(calls.filter((item) => item.channel === 'digital-human:preview').length, 1, 'A failed save must not generate.');
  failSave = false; failPreview = true; click();
  const rejected = await api.saveAndPreview({});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.data.id, 'saved_draft', 'A rejected preview must preserve the saved draft in the UI.');
}

async function main() {
  await checkSlowDraftClick();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-digital-human-'));
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const input = path.join(directory, 'input.png'); fs.writeFileSync(input, image);
  const services = [];
  try {
    const posts = [], receipts = new Map(); let registered = [], disconnectPreview = false, disconnectPreflight = false, disconnectRegistration = false;
    const provider = {
      capabilities: async () => ({ ready: true }), nodeOf, taskIdOf, resultUrl, videoPayload,
      previewPayload: () => ({ model: 'gpt-image-2' }), imageUploadBody: () => ({ body: Buffer.from('fixture'), headers: {} }),
      download: async (_url, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, target.endsWith('.mp4') ? Buffer.from('0000ftypisom') : image); },
      request: async (route, request = {}) => {
        if (route.startsWith('/operations/')) return receipts.get(route.split('/').pop());
        if (request.method === 'POST') {
          posts.push({ route, body: request.body, operationId: request.operationId });
          let result;
          if (route.endsWith('uploads/images')) result = { data: { url: 'https://cdn.example.com/reference.png' } };
          if (route.endsWith('images/generations')) result = { data: [{ task_id: 'preview_fixture' }] };
          if (route.endsWith('private-avatar/assets')) {
            registered = request.body.assets.map((item, index) => ({ name: item.name, id: `asset_fixture_${index}`, status: 'approved' }));
            result = { data: { id: 'review_fixture' } };
          }
          if (route.endsWith('videos/generations')) result = { data: [{ task_id: 'video_fixture' }] };
          receipts.set(request.operationId, result);
          if (disconnectPreview && route.endsWith('images/generations')) throw Object.assign(new Error('connection lost'), { outcomeUnknown: true });
          if (disconnectRegistration && route.endsWith('private-avatar/assets')) throw Object.assign(new Error('connection lost'), { outcomeUnknown: true });
          return result;
        }
        if (route.startsWith('/apimart/seedance2/private-avatar/assets?group=')) {
          if (disconnectPreflight) throw Object.assign(new Error('内容制作服务暂时无法连接。'), { code: 'digital_human_provider_unavailable' });
          return { data: { items: [{ id: 'someone_else', name: 'other', status: 'approved' }, ...registered] } };
        }
        return { data: { status: 'completed', progress: 100, result: { images: [{ url: ['https://cdn.example.com/preview.png'] }], videos: [{ url: ['https://cdn.example.com/base.mp4'] }] } } };
      },
    };
    let packaging, packagingStatus = 'completed', packagingErrorCode = '';
    const packagingAdmissions = new Map();
    const options = { rootDir: path.join(directory, 'data'), provider,
      packageVideo: async (payload) => {
        packaging = payload;
        const count = (packagingAdmissions.get(payload.source_id) || 0) + 1;
        packagingAdmissions.set(payload.source_id, count);
        if (count > 1 && ['paused', 'failed', 'cancelled'].includes(packagingStatus)) packagingStatus = 'completed';
        return { task_id: `task_${payload.source_id}`, project_id: 'creative_project_test' };
      },
      queryPackaging: async () => ({ status: packagingStatus, error_code: packagingErrorCode, generated_video_id: 'generated_video_fixture' }),
    };
    let service = createDigitalHumanService(options); services.push(service);
    const localDraft = service.create({ personAssetId: '', productAssetId: '', sceneId: 'studio', voiceStyle: 'natural_female', durationSeconds: 12, script: '' });
    const changedDraft = service.create({ id: localDraft.id, personAssetId: '', productAssetId: '', sceneId: 'store', voiceStyle: 'steady_male', durationSeconds: 15, script: '草稿修改' });
    assert.equal(changedDraft.id, localDraft.id);
    assert.equal(service.list().items.length, 1, 'Editing a draft must update it, not create another task.');
    assert.equal(posts.length, 0);
    const person = service.importImage(input), product = service.importImage(input);
    const draft = { personAssetId: person.id, productAssetId: product.id, sceneId: 'studio', voiceStyle: 'natural_female', durationSeconds: 12, script: '这个杯子出门携带很方便。', templateId: 'key_points', musicTrackId: 'music_track_fixture' };
    const task = service.create(draft);
    const savedImages = service.images(task.id);
    assert.equal(savedImages.person.id, person.id);
    assert.equal(savedImages.product.previewDataUrl, product.previewDataUrl);
    assert.equal(JSON.stringify(service.list()).includes('previewDataUrl'), false, 'Polling must not include image data.');
    assert.equal(posts.length, 0, 'Saving a local draft must never upload or generate.');
    await assert.rejects(service.confirm(task.id, 'stale'), /预览/);
    disconnectPreflight = true;
    const offline = service.create({ ...draft, script: '离线预检样片。' });
    await service.preview(offline.id); await service.refresh(offline.id);
    assert.equal(service.get(offline.id).status, 'needs_attention');
    assert.equal(posts.length, 0, 'A failed free preflight must stop before uploading customer images.');
    disconnectPreflight = false;
    await service.preview(task.id); await service.refresh(task.id);
    assert.equal(service.get(task.id).status, 'preview_ready');
    assert.equal(posts.filter((p) => p.route.endsWith('videos/generations')).length, 0, 'Preview must not start a video before confirmation.');
    const ready = service.get(task.id);
    await service.confirm(task.id, ready.previewRevision); await service.refresh(task.id);
    assert.equal(service.get(task.id).status, 'completed');
    const registration = posts.find((p) => p.route.endsWith('private-avatar/assets')).body;
    assert.match(registration.group.name, /^dh_[a-f0-9]{24}$/u);
    assert.ok([registration.group.name, ...registration.assets.map((item) => item.name)]
      .every((name) => name.length + 28 <= 64), 'Gateway-prefixed avatar names must fit the supplier limit.');
    const video = posts.find((p) => p.route.endsWith('videos/generations')).body;
    assert.deepEqual(video.image_urls.slice(0, 2), ['asset://asset_fixture_1', 'asset://asset_fixture_0']);
    assert.equal(video.duration, 12); assert.equal(video.generate_audio, true);
    assert.equal(packaging.template_id, 'key_points'); assert.equal(packaging.music_track_id, 'music_track_fixture');
    assert.match(packaging.source_id, /^digital_human_[a-f0-9-]{36}$/u);
    assert.equal(packaging.confirmed_script, draft.script); assert.ok(fs.existsSync(packaging.input_video_path));
    assert.equal(JSON.stringify(service.list()).includes(directory.replace(/\\/gu, '\\\\')), false, 'Renderer output must not expose local paths.');

    disconnectRegistration = true;
    const recovered = service.create({ ...draft, script: '人物素材登记回执丢失。' });
    await service.preview(recovered.id); await service.refresh(recovered.id);
    await service.confirm(recovered.id, service.get(recovered.id).previewRevision); await service.refresh(recovered.id);
    assert.equal(service.get(recovered.id).status, 'outcome_unknown');
    const registrationPosts = posts.filter((p) => p.route.endsWith('private-avatar/assets')).length;
    disconnectRegistration = false;
    await service.refresh(recovered.id);
    assert.equal(service.get(recovered.id).status, 'completed');
    assert.equal(posts.filter((p) => p.route.endsWith('private-avatar/assets')).length, registrationPosts,
      'An unknown registration with two approved assets must never be reposted.');

    disconnectPreview = true;
    const unknown = service.create({ ...draft, script: '这是另一条样片。' });
    await service.preview(unknown.id); await service.refresh(unknown.id);
    // refresh can recover the receipt immediately; no second paid POST occurs.
    const count = posts.filter((p) => p.route.endsWith('images/generations')).length;
    await service.close(); service = createDigitalHumanService(options); services.push(service);
    assert.deepEqual(service.images(task.id), savedImages, 'Saved asset previews must be restored after restart.');
    assert.throws(() => service.images('../task'), /数字人/);
    await service.refresh(unknown.id);
    assert.equal(service.get(unknown.id).status, 'preview_ready');
    assert.equal(posts.filter((p) => p.route.endsWith('images/generations')).length, count);

    disconnectPreview = false;
    for (const status of ['paused', 'failed', 'cancelled', 'outcome_unknown', 'failed_unknown']) {
      packagingStatus = status === 'failed_unknown' ? 'failed' : status;
      packagingErrorCode = status === 'failed_unknown' ? 'cover_outcome_unknown' : '';
      const paused = service.create({ ...draft, script: `包装恢复 ${status}` });
      await service.preview(paused.id); await service.refresh(paused.id);
      await service.confirm(paused.id, service.get(paused.id).previewRevision); await service.refresh(paused.id);
      const isUnknown = status.includes('unknown'), sourceId = `digital_human_${paused.id.slice(3)}`;
      assert.equal(service.get(paused.id).status, isUnknown ? 'outcome_unknown' : 'needs_attention');
      const providerPosts = posts.length, taskId = service.get(paused.id).packagingTaskId;
      await service.close(); service = createDigitalHumanService(options); services.push(service);
      await service.refresh(paused.id);
      assert.equal(packagingAdmissions.get(sourceId), 1, 'Restart/refresh must not re-admit stopped or unknown packaging.');
      if (isUnknown) await assert.rejects(service.resume(paused.id), /没有可继续/);
      else {
        await service.resume(paused.id); await service.refresh(paused.id);
        assert.equal(packagingAdmissions.get(sourceId), 2);
        assert.equal(service.get(paused.id).packagingTaskId, taskId, 'Explicit resume must reuse the local packaging task.');
        assert.equal(service.get(paused.id).status, 'completed');
      }
      assert.equal(posts.length, providerPosts, 'Packaging recovery must never regenerate the provider video.');
    }
    assert.throws(() => service.create({ ...draft, localPath: input }), /刷新/);
    assert.throws(() => service.get('../task'), /数字人/);
    assert.throws(() => remoteUrl('https://127.0.0.1/test'), /素材地址/);
    assert.equal(isPublicAddress('192.168.0.1'), false);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    const unavailable = createDigitalHumanProvider({ gatewayClient: { isEnabled: () => true, initialize: async () => ({ ready: true, capabilities: { apimart: true } }) } });
    assert.equal((await unavailable.capabilities()).ready, false, 'Image capability alone must never imply video capability.');
    console.log('digital-human self-check passed: slow-save click, preview gate, approved assets, native voice, packaging resume, unknown guard, restart receipts, protected paths');
  } finally {
    await Promise.allSettled(services.map((service) => service.close()));
    const resolved = path.resolve(directory);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('xiaoxi-digital-human-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
