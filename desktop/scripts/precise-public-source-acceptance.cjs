// Read reviewed original receipts, optionally exercise the real public queue.
// Always uses an isolated data directory, no map adapter, no clipboard or model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createPublicSources } = require('../src/main/precise-public-sources.cjs');
const { createPreciseAcquisitionController } = require('../src/main/precise-acquisition.cjs');
const arg = key => process.argv[process.argv.indexOf(key) + 1];

async function main() {
  if (!process.argv.includes('--input') || !process.argv.includes('--output')) throw Error('Required: --input reviewed-originals.json --output new-directory [--live]');
  const input = JSON.parse(fs.readFileSync(arg('--input'), 'utf8'));
  assert.ok(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 10);
  const output = path.resolve(arg('--output'));
  assert.ok(!fs.existsSync(output), 'preserve earlier evidence; choose a new output directory');
  fs.mkdirSync(output, { recursive: true });
  const publicSources = createPublicSources(), candidateUrls = new Set(input.items.map(i => i.url));
  const gateway = async (action, body) => {
    if (action === 'status') return publicSources.status();
    if (action === 'search') return publicSources.search(body);
    assert.equal(action, 'read');
    assert.ok(candidateUrls.has(body.url) || candidateUrls.size < 10, 'total candidate cap, including cached originals');
    candidateUrls.add(body.url);
    const result = await publicSources.read(body.url);
    fs.writeFileSync(path.join(output, `read-${createHash('sha256').update(body.url).digest('hex').slice(0, 12)}.json`), JSON.stringify({ url: body.url, ...result }, null, 2));
    return result;
  };
  const controller = createPreciseAcquisitionController({ dataDir: path.join(output, 'data'), gateway,
    ai: { policy: () => ({ approved: false, maxCalls: 0 }), request: () => { throw Error('PAID_CALL_FORBIDDEN'); } } });
  try {
    await controller.dispatch('save-profile', input.profile);
    if (process.argv.includes('--live')) {
      await controller.dispatch('start-task');
      for (let i = 0; i < 1300 && controller.snapshot().busy; i++) await new Promise(r => setTimeout(r, 250));
      assert.equal(controller.snapshot().busy, false, 'public queue must stop within its bounded soft limit');
    }
    for (const item of input.items) {
      const receipt = item.receipt;
      assert.equal(receipt.status, 'completed'); assert.equal(receipt.origin, 'public-original');
      assert.equal(receipt.resolvedUrl, item.url);
      assert.equal(createHash('sha256').update(receipt.text).digest('hex'), receipt.contentHash);
      assert.equal(item.facts.quote, receipt.text, 'review the saved original, not search snippets');
      await controller.dispatch('import-source', { ...receipt, url: item.url, title: item.facts.projectName, facts: item.facts });
      const card = controller.snapshot().cards.find(c => c.sourceUrl === item.url && c.projectName === item.facts.projectName);
      assert.ok(card); assert.equal(card.bucket, item.expectedBucket);
      if (item.expectedCity) assert.equal(card.projectCity, item.expectedCity);
      fs.writeFileSync(path.join(output, `original-${input.items.indexOf(item) + 1}.json`), JSON.stringify(item, null, 2));
    }
    const state = controller.snapshot();
    assert.ok(candidateUrls.size <= 10);
    assert.equal(state.tasks.reduce((n, t) => n + t.models, 0), 0);
    const result = { passed: true, at: new Date().toISOString(), candidateCount: candidateUrls.size, originalsReviewed: input.items.length,
      recommended: state.cards.filter(c => c.bucket === 'recommended').length, missingContact: state.cards.filter(c => c.bucket === 'missing-contact').length,
      awaitingReviewOrHistorical: state.cards.filter(c => c.bucket === 'review').length,
      paidCalls: 0, mapOperations: 0, customerContact: false, originalDataModified: false, sourceCapabilities: publicSources.status(),
      tasks: state.tasks, inspections: input.items.map(({ receipt, facts, ...item }) => ({ ...item, facts: { projectName: facts.projectName, projectCity: facts.projectCity, eventDate: facts.eventDateRaw || facts.eventDate } })) };
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ passed: true, candidateCount: result.candidateCount, originalsReviewed: result.originalsReviewed, recommended: result.recommended, paidCalls: 0, output }));
  } finally { controller.dispose(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
