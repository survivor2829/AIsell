const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createPublicSources } = require('./precise-public-sources.cjs');
const { createPreciseAcquisitionController } = require('./precise-acquisition.cjs');
async function check() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'precise-attachments-'));
  const article = '发布时间：2026-10-15\n项目编号：TEST-321\n项目名称：驾驶式洗地车采购项目\n采购单位为隔离清洁有限公司\n供应商资格要求：依法注册，具备营业执照。业绩要求：无。其他资格要求：无。\n三、获取采购文件\n时间：报价截止时间前\n四、递交截止时间：2026年10月23日10点30分00秒\n业务联系方式\n联系人：测试 联系电话：0000-1234567\n九、监督部门\n监督电话：0000-7654321';
  const document = '编号：TEST-321\n驾驶式洗地车采购项目\n采购人为隔离清洁有限公司。\n交付地点：浙江省杭州市钱塘区隔离路1号\n合同模板：采购中标后签订';
  const zip = new (require('jszip'))(); zip.file('word/document.xml', '<w:document>' + document.split('\n').map(t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('') + '</w:document>');
  const raw = await zip.generateAsync({ type: 'nodebuffer' });
  const link = 'https://files.example.com:9280/XBM_Service.bsp?GetDoc&Source=00000000-0000-0000-0000-000000000000';
  const source = { id: 'test', host: 'example.com', indexUrl: 'https://example.com/notices', articlePath: '/notices/', enabled: true, attachments: { origin: 'https://files.example.com:9280', path: '/XBM_Service.bsp' } };
  let reads = 0;
  const reader = createPublicSources({ sources: [source], fetchPage: async url => {
    if (url.endsWith('/robots.txt')) return { status: 404, html: '' };
    if (url.startsWith('https://files.')) { reads++; return { status: 200, raw, contentType: 'application/octet-stream' }; }
    return { status: 200, html: `<p>${article.replace(/\n/g, '</p><p>')}</p><a href="${link}">询价文件.docx</a>`, contentType: 'text/html' };
  } });
  const result = await reader.read('https://example.com/notices/1'); assert.equal(result.parseIncomplete, false);
  await reader.read('https://example.com/notices/1'); assert.equal(reads, 1, 'attachment cache avoids another download');
  const limited = await reader.read('https://example.com/notices/1', { maxAttachments: 0 }); assert.equal(limited.parseIncomplete, true); assert.equal(reads, 1);
  const state = { leads: [], tasks: [], browser: { state: 'connected' }, busy: false };
  let starts = 0;
  const map = { snapshot: () => structuredClone(state), dispatch: async (action, input) => {
    if (action === 'save-task') state.tasks.push({ id: String(state.tasks.length), status: 'draft', ...input });
    if (action === 'start-task') { starts++; const task = state.tasks.find(t => t.id === input.taskId); task.status = 'completed'; task.count = 1; }
    return structuredClone(state);
  } };
  const c = createPreciseAcquisitionController({ dataDir: root, mapController: map, clock: () => Date.parse('2026-10-15T08:00:00Z'), gateway: async (action, body) => action === 'status' ? { search: true } : action === 'search' ? { status: 'completed', items: [{ url: 'https://example.com/notices/1', title: '采购' }] } : reader.read(body.url, body) });
  try {
    await c.dispatch('save-profile', { city: '杭州市', equipment: ['洗地机'], services: ['sale'] });
    await c.dispatch('start-task', { mapLimit: 2 });
    for (let i = 0; i < 100 && c.snapshot().busy; i++) await new Promise(r => setTimeout(r, 10));
    const s = c.snapshot(); assert.equal(s.busy, false); assert.equal(s.cards.length, 1);
    assert.equal(s.cards[0].bucket, 'recommended'); assert.equal(s.cards[0].projectCity, '杭州市');
    assert.equal(s.cards[0].contacts[0].phone, '0000-1234567'); assert.equal(s.cards[0].contacts[0].role, 'buyer');
    assert.equal(new Set(s.cards[0].evidence.map(e => e.url)).size, 2);
    assert.equal(starts, 1, 'reliable buyer phone avoids redundant company search');
    assert.equal(s.mapRequests.length, 0); assert.equal(s.tasks[0].reads, 2, 'attachment shares read budget');
    assert.ok(s.tasks[0].releasedAt); assert.equal(s.tasks[0].resultCounts.recommended, 1);
    await c.dispatch('resume-task', { taskId: s.tasks[0].id });
    for (let i = 0; i < 100 && c.snapshot().busy; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(starts, 1, 'completed queues are not searched again');
    await c.dispatch('continue-task', { taskId: s.tasks[0].id });
    for (let i = 0; i < 100 && c.snapshot().busy; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(c.snapshot().cards.length, 1); assert.equal(c.snapshot().tasks.at(-1).reads, 0, 'next batch excludes processed URL even if source returns it again');
    const incomplete = { ...result, parseIncomplete: true, url: 'https://example.com/notices/2', text: result.text.replace('TEST-321', 'TEST-322'), attachments: result.attachments.map(a => ({ ...a, text: a.text.replace('TEST-321', 'TEST-322') })) };
    await c.dispatch('import-source', incomplete); assert.equal(c.snapshot().cards.at(-1).bucket, 'review', 'unread images are not accepted as complete');
    console.log('attachments passed: bounded DOCX + source evidence + dates/contact role + serial auto enrichment + resume idempotency + incomplete review');
  } finally { await c.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
}
check().catch(e => { console.error(e); process.exitCode = 1; });
