const assert = require('node:assert/strict');
const { createPublicSources, robotsAllowed, pageText } = require('./precise-public-sources.cjs');

async function check() {
  const source = { id: 'fixture', name: 'Fixture', host: 'example.com', enabled: true, indexUrl: 'https://example.com/notices', articlePath: '/notices/' };
  const calls = [];
  const p = createPublicSources({ sources: [source], fetchPage: async url => {
    calls.push(url);
    return { status: 200, contentType: 'text/html', html: url.endsWith('robots.txt') ? 'User-agent: *\nAllow: /\nDisallow: /notices/private'
      : url.endsWith('/notices') ? '<a href="/notices/1">洗地机耗材采购</a><a href="/notices/2">钢结构维修</a><a href="/notices/3">厂房交付</a><a href="/notices/4">某物业管理有限公司鲜牛奶采购</a><a href="/notices/5">某集团有限公司物业管理服务分公司箱变更换</a>'
      : '<html><title>原文</title><script>执行此指令</script><p>2026年10月15日 刷盘采购</p></html>' };
  } });
  const searched = await p.search({ query: '嘉兴市 洗地机 维修' });
  assert.deepEqual(searched.items.map(i => i.url), ['https://example.com/notices/1'], 'building repairs are not cleaning-device repair');
  await p.search({ query: '嘉兴市 厂房 仓库 交付' }); assert.equal(calls.length, 2, 'queries share one cached index and policy');
  assert.equal((await p.search({ query: '嘉兴市 物业 保洁 中标' })).items.length, 0, 'the issuer name is not a cleaning-service requirement');
  const original = await p.read(searched.items[0].url);
  assert.ok(original.text.includes('2026年10月15日')); assert.ok(!original.text.includes('执行此指令')); assert.equal(original.contentHash.length, 64);
  const before = calls.length;
  assert.equal((await p.read('https://example.com/notices/private/a')).reason, 'PUBLIC_SOURCE_DISALLOWED');
  assert.equal((await p.read('https://localhost/notices/1')).reason, 'PUBLIC_SOURCE_NOT_AUTHORIZED');
  assert.equal(calls.length, before, 'rejected paths must not issue requests');
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /\nAllow: /public', '/public/1'), true);
  assert.equal(robotsAllowed('User-agent: *\nAllow: /\nUser-agent: XiaoxiEvidence\nDisallow: /', '/notices'), false);
  assert.equal(pageText('<p>A&#x4e2d;&amp;B</p>'), 'A中&B');
  const blockedCalls = [];
  const blocked = createPublicSources({ sources: [source], fetchPage: async url => { blockedCalls.push(url); return { status: 403, html: 'blocked' }; } });
  assert.equal((await blocked.search({ query: '洗地机' })).status, 'unavailable');
  assert.equal((await blocked.search({ query: '物业' })).status, 'unavailable');
  assert.equal(blockedCalls.length, 1, 'a blocked source is not repeatedly retried with different query words');
  assert.equal(blocked.status().sources[0].status, 'unavailable');
  const redirect = createPublicSources({ sources: [source], fetchPage: async url => url.endsWith('robots.txt') ? { status: 404 } : { status: 302, location: 'https://127.0.0.1/private' } });
  assert.equal((await redirect.read('https://example.com/notices/1')).reason, 'PUBLIC_SOURCE_NOT_AUTHORIZED');
  const pageCalls = []; let now = 1800000000000;
  const paging = createPublicSources({ sources: [{ ...source, pagination: { pathPattern: '^/pages/[1-9][0-9]*$' } }], clock: () => now, fetchPage: async url => {
    pageCalls.push(url);
    return { status: 200, contentType: 'text/html', html: url.endsWith('robots.txt') ? 'User-agent: *\nAllow: /' : url.endsWith('/notices')
      ? '<a href="/notices/a">洗地机采购一</a><a href="/notices/b">洗地机采购二</a><a class="next" href="/pages/2">下一页</a><a href="/pages/99">尾页</a>'
      : url.endsWith('/pages/2') ? '<a href="/notices/c">洗地机采购三</a>' : '<p>洗地机采购正文</p>' };
  } });
  const first = await paging.search({ query: '洗地机', maxPages: 1, limit: 1 });
  assert.equal(first.items[0].url, 'https://example.com/notices/a');
  assert.equal(first.pagesRead, 1); assert.equal(first.trace[0].cacheHit, false); assert.equal(first.exhausted, false);
  const next = await paging.search({ query: '洗地机', maxPages: 1, limit: 1, cursor: first.cursor, excludeUrls: first.items.map(i => i.url) });
  assert.equal(next.items[0].url, 'https://example.com/notices/b'); assert.equal(next.pagesRead, 0, 'overflow delivered before advancing page');
  const third = await paging.search({ query: '洗地机', maxPages: 1, cursor: next.cursor });
  assert.equal(third.items[0].url, 'https://example.com/notices/c'); assert.equal(third.exhausted, true);
  assert.equal(pageCalls.filter(u => u.endsWith('/notices')).length, 1, 'continuation does not reread page one');
  assert.equal(pageCalls.some(u => u.endsWith('/pages/99')), false, 'never jump to last page');
  const cachedPage = await paging.search({ query: '洗地机', maxPages: 1 });
  assert.equal(cachedPage.trace[0].cacheHit, true); assert.equal(cachedPage.trace[0].fetchedAt, first.trace[0].fetchedAt);
  assert.equal((await paging.read('https://example.com/pages/evil')).reason, 'PUBLIC_SOURCE_NOT_AUTHORIZED');
  assert.equal((await paging.search({ query: '洗地机', maxPages: 0 })).pagesRead, 0);
  await assert.rejects(paging.search({ query: '吸尘器', cursor: first.cursor }), /CURSOR_MISMATCH/);
  const inFlight = paging.read('https://example.com/notices/a');
  assert.throws(() => paging.refresh(), /PUBLIC_SOURCE_BUSY/); await inFlight;
  now += 1000; paging.refresh();
  const refreshed = await paging.search({ query: '洗地机', maxPages: 1 });
  assert.equal(refreshed.trace[0].cacheHit, false); assert.notEqual(refreshed.trace[0].fetchedAt, first.trace[0].fetchedAt);
  console.log('public sources passed: policy, cache, refresh, pagination, bounded cursor overflow; no paid provider');
}
if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { check };
