const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreciseAcquisitionController, classify } = require('./precise-acquisition.cjs');

async function check() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'precise-check-'));
  const clock = () => Date.parse('2026-10-15T08:00:00+08:00');
  const legacy = { leads: [{ id: 'legacy-1', name: '隔离验收保洁公司', phone: '0000-1234567', favorite: true, city: '嘉兴市', address: '嘉兴市南湖区', sourceUrl: 'https://www.amap.com/place/fixture', evidence: [], followUps: [{ id: 'old-follow-up', content: '保留原记录' }] }], browser: { state: 'closed' } };
  const original = JSON.stringify(legacy);
  let copied = '', copyFails = false;
  const c = createPreciseAcquisitionController({ dataDir: root, mapController: { snapshot: () => legacy }, clock,
    copyText: async value => { if (copyFails) throw Error('clipboard unavailable'); copied = value; } });
  try {
    await c.dispatch('save-profile', { city: '嘉兴市', equipment: ['洗地机'], services: ['sale', 'rental', 'repair', 'consumables'] });
    const make = (project, service, signal = 'procurement', extra = '') => {
      const sourceText = `${project} 嘉兴市 南湖区 隔离验收保洁公司 2026年10月14日 2026年10月20日 洗地机 ${service} ${signal === 'award' ? '保洁服务中标' : signal === 'delivery' ? '厂房交付 开荒' : '采购询价'} ${extra}`;
      return { title: project, url: `https://example.com/${project}`, text: sourceText, facts: { projectName: project, projectCity: '嘉兴市', district: '南湖区', eventDate: '2026年10月14日', deadline: '2026年10月20日', signal,
        equipment: ['洗地机'], services: [Object.entries({ sale: '购置', rental: '租赁', repair: '维修', consumables: '耗材' }).find(([, v]) => v === service)?.[0]], organizations: [{ name: '隔离验收保洁公司' }], quote: sourceText } };
    };
    for (const business of ['购置', '租赁', '维修', '耗材']) await c.dispatch('import-source', make(`隔离项目-${business}`, business));
    let state = c.snapshot();
    assert.equal(state.cards.length, 4);
    assert.ok(state.cards.every(card => card.bucket === 'missing-contact' && card.eventDate === '2026-10-14'));
    assert.deepEqual(state.cards.map(card => card.services[0]), ['sale', 'rental', 'repair', 'consumables']);
    const company = state.enterprises.find(e => e.mapLeadIds.includes('legacy-1'));
    assert.equal(company.favorite, true); assert.equal(company.followUps.length, 1);
    for (const card of state.cards) await c.dispatch('link-map', { cardId: card.id, enterpriseId: company.id, confirmed: true });
    state = c.snapshot(); assert.ok(state.cards.every(card => card.bucket === 'recommended'));
    await c.dispatch('save-follow-up', { enterpriseId: company.id, cardId: state.cards[0].id, content: '隔离记录，未联系客户' });
    assert.ok(c.snapshot().cards.every(card => card.enterpriseIds.includes(company.id)));
    copyFails = true;
    await assert.rejects(c.dispatch('copy-contact', { enterpriseId: company.id, contactId: company.contacts[0].id }), /clipboard/);
    assert.equal(c.snapshot().copyEvents.length, 0);
    copyFails = false; await c.dispatch('copy-contact', { enterpriseId: company.id, contactId: company.contacts[0].id });
    assert.equal(copied, legacy.leads[0].phone); assert.equal(c.snapshot().copyEvents.length, 1);
    assert.ok(c.snapshot().cards.every(card => card.demand === 'signal'));
    await c.dispatch('status'); assert.equal(c.snapshot().enterprises.find(e => e.id === company.id).followUps.length, 2);
    assert.equal(JSON.stringify(legacy), original, 'migration must not mutate legacy map state');
    const good = c.snapshot().cards[0];
    assert.equal(classify({ ...good, deadline: '2026-10-14' }, state.profile, clock()).bucket, 'review');
    assert.equal(classify({ ...good, projectCity: '杭州市' }, state.profile, clock()).bucket, 'review');
    assert.equal(classify({ ...good, eventDate: '2026-08-01', deadline: '' }, state.profile, clock()).bucket, 'review');
    assert.equal(classify({ ...good, signal: 'award', evidence: [{ quote: '保洁服务中标候选人' }] }, state.profile, clock()).bucket, 'review');
    const wrongContact = make('归属检查', '购置', 'procurement', '采购人：隔离验收保洁公司。代理：隔离代理公司 联系电话0000-7654321');
    wrongContact.facts.contacts = [{ organization: '隔离验收保洁公司', phone: '0000-7654321', role: 'buyer', roleQuote: '采购人：隔离验收保洁公司。代理：隔离代理公司 联系电话0000-7654321' }];
    await c.dispatch('import-source', wrongContact);
    assert.equal(c.snapshot().cards.at(-1).contacts[0].role, 'unknown', 'agency telephone cannot become buyer telephone');
    const qualified = make('资格条款', '购置', 'procurement', '招标人：隔离验收保洁公司 商务联系人 电话0000-1234567。资料不全将取消其报名资格。');
    qualified.facts.contacts = [{ organization: '隔离验收保洁公司', phone: '0000-1234567', role: 'buyer', roleQuote: '招标人：隔离验收保洁公司 商务联系人 电话0000-1234567' }];
    qualified.facts.address = 'https://example.com/product'; qualified.text += ' https://example.com/product'; qualified.facts.quote = qualified.text;
    await c.dispatch('import-source', qualified);
    assert.equal(c.snapshot().cards.at(-1).cancelled, false, 'a bidder disqualification clause does not cancel the procurement');
    assert.equal(c.snapshot().cards.at(-1).contacts[0].role, 'buyer');
    assert.equal(c.snapshot().cards.at(-1).address, '', 'a shopping URL is not a project address');
    const chineseTime = make('中文截止时间', '购置', 'procurement', '2026 年10月14日9时00分');
    chineseTime.facts.deadlineRaw = '2026 年10月14日9时00分';
    await c.dispatch('import-source', chineseTime);
    assert.equal(c.snapshot().cards.at(-1).deadline, '2026-10-14T09:00:00+08:00');
    assert.equal(c.snapshot().cards.at(-1).bucket, 'review');
    const stopped = make('终止项目', '购置', 'procurement', '项目终止');
    await c.dispatch('import-source', stopped);
    const updated = { ...stopped, text: stopped.text.replace('项目终止', '仍在采购') };
    updated.facts = { ...stopped.facts, quote: updated.text }; await c.dispatch('import-source', updated);
    const terminal = c.snapshot().cards.filter(card => card.projectName === '终止项目');
    assert.equal(terminal.length, 1); assert.equal(terminal[0].cancelled, true);
    for (const [title, field] of [['洗地机采购终止公告', 'cancelled'], ['洗地机采购项目中标结果公告', 'procurementCompleted']]) {
      const document = make(title, '购置');
      await c.dispatch('import-source', { ...document, facts: undefined });
      const before = c.snapshot().cards.length;
      await c.dispatch('import-source', { ...document, facts: { ...document.facts, projectCode: '' } });
      const card = c.snapshot().cards.at(-1);
      assert.equal(card[field], true); assert.equal(card.bucket, 'review');
      assert.equal(c.snapshot().cards.length, before, 'fact confirmation must update the existing original draft');
    }
    await c.dispatch('save-profile', { city: '杭州市', equipment: ['洗地机'], services: ['sale'] });
    assert.equal(c.snapshot().profiles.length, 2);
    await c.dispatch('select-profile', { id: c.snapshot().profiles[0].id });
    assert.equal(c.snapshot().profile.city, '嘉兴市');
    await c.dispatch('start-task');
    for (let i = 0; i < 20 && c.snapshot().busy; i++) await new Promise(r => setImmediate(r));
    assert.equal(c.snapshot().tasks.at(-1).precise.status, 'unavailable');
    assert.equal(c.snapshot().tasks.at(-1).map.status, 'paused');
    const reloaded = createPreciseAcquisitionController({ dataDir: root, mapController: { snapshot: () => legacy }, clock });
    assert.equal(reloaded.snapshot().enterprises.find(e => e.id === company.id).followUps.length, 2); reloaded.dispose();
  } finally { c.dispose(); }
  let queue, pauseOnce = true;
  const gateway = async action => {
    if (action === 'status') return { search: true, read: true };
    if (action === 'search') return { status: 'completed', items: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b', title: 'B' }] };
    if (pauseOnce) { pauseOnce = false; await queue.dispatch('pause-task'); }
    return { status: 'completed', text: '只有原文资料，不能认定需求' };
  };
  queue = createPreciseAcquisitionController({ dataDir: path.join(root, 'queue'), gateway, clock });
  const settled = async () => { for (let i = 0; i < 100 && queue.snapshot().busy; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(queue.snapshot().busy, false); };
  try {
    await queue.dispatch('save-profile', { city: '嘉兴市', equipment: ['洗地机'], services: ['sale'] });
    await queue.dispatch('start-task'); await settled();
    assert.deepEqual(queue.snapshot().tasks[0].pendingItems.map(i => i.url), ['https://example.com/b'], 'pause saves the completed read and retains remaining items without rediscovery');
    assert.equal(queue.snapshot().tasks[0].searches, 1);
    await queue.dispatch('resume-task', { taskId: queue.snapshot().tasks[0].id }); await settled();
    assert.equal(queue.snapshot().tasks[0].candidates, 2, 'resume must process remaining cached items');
    console.log('precise acquisition passed: evidence, four businesses, contact ownership, shared history, copy receipt, terminal updates, pause recovery and budget gate');
  } finally { queue.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
  const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'precise-source-failure-'));
  const failureQueue = createPreciseAcquisitionController({ dataDir: failureRoot, clock, gateway: async action => action === 'status' ? { search: true } : { status: 'completed', items: [], failures: [{ sourceId: 'blocked', code: 'PUBLIC_SOURCE_HTTP_403' }] } });
  try {
    await failureQueue.dispatch('save-profile', { city: '嘉兴市', equipment: ['洗地机'], services: ['sale'] });
    await failureQueue.dispatch('start-task');
    for (let i = 0; i < 100 && failureQueue.snapshot().busy; i++) await new Promise(r => setImmediate(r));
    const task = failureQueue.snapshot().tasks[0];
    assert.equal(task.precise.status, 'failed'); assert.equal(task.sourceFailures.length, 1); assert.ok(task.message.includes('覆盖不完整'));
  } finally { failureQueue.dispose(); fs.rmSync(failureRoot, { recursive: true, force: true }); }
  const pagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'precise-paging-'));
  const waitIdle = async controller => {
    for (let i = 0; i < 100 && controller.snapshot().busy; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.snapshot().busy, false);
  };
  const items = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/page-${i}`, title: `洗地机采购${i}` }));
  try {
    for (const scenario of ['failed-reads', 'two-pages', 'attachment-limit', 'interrupted-last']) {
      let searches = 0, reads = 0, interrupted = false;
      const requests = [];
      const controller = createPreciseAcquisitionController({ dataDir: path.join(pagingRoot, scenario), clock, gateway: async (action, input) => {
        if (action === 'status') return { search: true, read: true };
        if (action === 'search') {
          requests.push(clone(input)); searches++;
          if (scenario === 'two-pages') return { status: 'completed', mode: 'public-index', pagesRead: 1, cursor: { page: searches + 1 }, exhausted: searches === 2, items: [items[searches - 1]] };
          return { status: 'completed', mode: 'public-index', pagesRead: 1, cursor: { page: 2 }, exhausted: scenario !== 'failed-reads', items: items.slice(0, input.limit) };
        }
        reads++;
        if (scenario === 'failed-reads') return { status: 'unavailable', reason: 'PUBLIC_SOURCE_UNAVAILABLE' };
        if (scenario === 'interrupted-last' && input.url === items[9].url && !interrupted) { interrupted = true; throw Error('temporary interrupted read'); }
        return { status: 'completed', text: '公开资料不足，不能认定采购需求', attachments: scenario === 'attachment-limit' ? Array.from({ length: Math.min(3, input.maxAttachments) }, () => ({ status: 'unavailable', reason: 'PUBLIC_ATTACHMENT_UNAVAILABLE' })) : [] };
      } });
      try {
        await controller.dispatch('save-profile', { city: '杭州市', equipment: ['洗地机'], services: ['sale'] });
        await controller.dispatch('start-task'); await waitIdle(controller);
        const first = controller.snapshot().tasks[0];
        if (scenario === 'failed-reads') {
          assert.equal(reads, 10, 'failed body reads count towards the ten-candidate cap');
          assert.equal(first.candidates, 10); assert.equal(first.failures, 10);
          assert.equal(first.precise.status, 'failed', 'all unreadable bodies must not claim successful processing');
        } else if (scenario === 'two-pages') {
          assert.equal(searches, 2, 'sale-only query must follow its next page');
          assert.equal(first.directoryPages, 2); assert.equal(first.discoveryExhausted, true);
          assert.equal(requests[0].query, requests[1].query); assert.deepEqual(requests[1].cursor, { page: 2 });
          assert.equal(first.urls.length, 2);
        } else if (scenario === 'attachment-limit') {
          assert.equal(first.reads, 20); assert.equal(first.candidates, 5);
          assert.deepEqual(first.pendingItems.map(i => i.url), items.slice(5).map(i => i.url));
          await controller.dispatch('continue-task', { taskId: first.id }); await waitIdle(controller);
          const next = controller.snapshot().tasks[1];
          assert.equal(searches, 1, 'continuation consumes saved candidates without rediscovering the page');
          assert.equal(next.pendingItems.length, 0); assert.equal(reads, 10);
          assert.deepEqual(next.urls, items.slice(5).map(i => i.url));
        } else {
          assert.equal(first.candidates, 10); assert.equal(first.pendingItems[0].url, items[9].url);
          await controller.dispatch('resume-task', { taskId: first.id }); await waitIdle(controller);
          const resumed = controller.snapshot().tasks[0];
          assert.equal(searches, 1); assert.equal(reads, 11, 'retry only the interrupted tenth candidate');
          assert.equal(resumed.candidates, 10); assert.equal(resumed.pendingItems.length, 0); assert.equal(resumed.urls.length, 10);
        }
      } finally { await controller.dispose(); }
    }
    console.log('public paging passed: failed-read cap, same-query pagination, pending continuation and interrupted-at-cap resume');
  } finally { fs.rmSync(pagingRoot, { recursive: true, force: true }); }
  const mapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'precise-map-recovery-'));
  const mapState = { leads: [], tasks: [], busy: false, browser: { state: 'connected' } };
  let starts = 0;
  const mockMap = { snapshot: () => clone(mapState), dispatch: async (action, payload) => {
    if (action === 'save-task') mapState.tasks.push({ id: 'same-map-task', status: 'draft' });
    if (action === 'start-task') { assert.equal(payload.taskId, 'same-map-task'); starts++; mapState.tasks[0].status = starts === 1 ? 'paused' : 'completed'; }
    return clone(mapState);
  } };
  const mapQueue = createPreciseAcquisitionController({ dataDir: mapRoot, mapController: mockMap, clock });
  try {
    const quote = '隔离地图项目 嘉兴市 2026-10-14 隔离地图公司 厂房交付';
    await mapQueue.dispatch('import-source', { text: quote, url: 'https://example.com/map', facts: { quote, projectName: '隔离地图项目', projectCity: '嘉兴市', eventDate: '2026-10-14', signal: 'delivery', organizations: [{ name: '隔离地图公司' }] } });
    const cardId = mapQueue.snapshot().cards[0].id;
    await mapQueue.dispatch('enrich-map', { cardId });
    for (let i = 0; i < 20 && mapQueue.snapshot().busy; i++) await new Promise(r => setImmediate(r));
    assert.equal(mapQueue.snapshot().tasks[0].status, 'paused');
    await mapQueue.dispatch('resume-task', { taskId: mapQueue.snapshot().tasks[0].id });
    for (let i = 0; i < 20 && mapQueue.snapshot().busy; i++) await new Promise(r => setImmediate(r));
    assert.equal(mapQueue.snapshot().tasks[0].status, 'completed'); assert.equal(mapState.tasks.length, 1); assert.equal(starts, 2);
    console.log('map supplement recovery passed: one original task, no replacement search');
  } finally { mapQueue.dispose(); fs.rmSync(mapRoot, { recursive: true, force: true }); }
}
const clone = value => JSON.parse(JSON.stringify(value));
if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { check };
