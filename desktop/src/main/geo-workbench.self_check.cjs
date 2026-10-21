const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGeoWorkbenchController, classifyVisibility } = require('./geo-workbench.cjs');
async function main() {
    const { createGeoBrowserAdapter } = require('./geo-browser-adapter.cjs');
    const partitions = [];
    class FailedLoginWindow {
        webContents = { setWindowOpenHandler() {}, on() {} };
        isDestroyed() { return false; }
        loadURL() { return Promise.reject(Error('isolated offline login')); }
        destroy() {}
    }
    for (const partitionId of ['account-A', 'account-B']) {
        const isolated = createGeoBrowserAdapter({ BrowserWindow: FailedLoginWindow, partitionId,
            session: { fromPartition(id) { partitions.push(id); return { setPermissionRequestHandler() {}, on() {} }; } } });
        await assert.rejects(isolated.openAccount('zhihu'), /登录页未能加载/);
        isolated.dispose();
    }
    assert.notEqual(partitions[0], partitions[1], 'GEO platform sessions must follow the account namespace');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-workbench-check-'));
    let publishes = 0, charges = 0;
    const adapter = { capabilities: { toutiao: { publish: true } }, openAccount: async () => ({ id: 'account', platform: 'toutiao', authorized: true, fingerprint: 'identity-1' }), publish: async () => { publishes++; throw Error('connection interrupted'); }, reconcilePublication: async () => ({ status: 'public', url: 'https://example.com/article/1' }) };
    let work = createGeoWorkbenchController({ dataDir, adapter, generateText: async () => { charges++; return 'content'; } });
    try {
        await work.dispatch('save-brand', { name: '清洁品牌', aliases: ['清洁别名'] });
        await work.dispatch('save-keyword', { text: '如何选择洗地机' });
        await assert.rejects(work.dispatch('generate-article', { keywordId: work.snapshot().keywords[0].id }), /预算/);
        assert.equal(charges, 0);
        await assert.rejects(work.dispatch('save-settings', { budgetApproved: true }), /可信主进程/);
        await work.dispatch('open-account', { platform: 'toutiao' });
        await work.dispatch('save-article', { title: '选型指南', body: '内容' });
        const articleId = work.snapshot().articles[0].id;
        await work.dispatch('approve-publication', { articleId, platform: 'toutiao', accountId: 'account' });
        const oldApproval = work.snapshot().publications[0].id;
        await work.dispatch('save-article', { id: articleId, title: '选型指南', body: '改稿' });
        assert.equal(work.snapshot().publications[0].status, 'invalidated');
        await assert.rejects(work.dispatch('publish', { publicationId: oldApproval }), /不能重复发布/);
        await work.dispatch('approve-publication', { articleId, platform: 'toutiao', accountId: 'account' });
        const publicationId = work.snapshot().publications[1].id;
        await assert.rejects(work.dispatch('publish', { publicationId }), /interrupted/);
        assert.equal(work.snapshot().publications[1].status, 'outcome_unknown');
        await assert.rejects(work.dispatch('publish', { publicationId }), /不能重复发布/);
        assert.equal(publishes, 1);
        work.dispose();
        work = createGeoWorkbenchController({ dataDir, adapter });
        assert.equal(work.snapshot().publications[1].status, 'outcome_unknown');
        await work.dispatch('reconcile-publication', { publicationId });
        assert.equal(publishes, 1);
        const result = classifyVisibility({ answer: '清洁品牌的洗地机', references: [{ title: '选型指南', url: 'https://other.example/1' }, { title: '引用', url: 'https://example.com/article/1' }], brand: work.snapshot().brand, articles: work.snapshot().articles, publications: work.snapshot().publications });
        assert.equal(result.mentioned, true);
        assert.equal(result.references[0].association, 'suspected');
        assert.equal(result.references[1].association, 'confirmed');
        assert.equal(classifyVisibility({ answer: '没有品牌', brand: work.snapshot().brand, articles: [], publications: [] }).referenceStatus, 'unknown');
        work.dispose();
        const file = path.join(dataDir, 'geo_workbench', 'state.json'), saved = JSON.parse(fs.readFileSync(file));
        saved.publications[1].status = 'executing';
        saved.ledger.push({ id: 'interrupted-call', status: 'executing' });
        fs.writeFileSync(file, JSON.stringify(saved));
        work = createGeoWorkbenchController({ dataDir, adapter });
        assert.equal(work.snapshot().publications[1].status, 'outcome_unknown');
        assert.equal(work.snapshot().ledger[0].status, 'outcome_unknown');
        work.dispose();
        let visibilityCalls = 0;
        adapter.capabilities.doubao = { visibility: true };
        adapter.openAccount = async platform => ({ id: platform === 'doubao' ? 'doubao-account' : 'account', platform, authorized: true, fingerprint: 'identity-1' });
        adapter.runVisibility = async () => { visibilityCalls++; throw Error('answer read interrupted'); };
        work = createGeoWorkbenchController({ dataDir, adapter, budgetPolicy: { approved: true, maxCalls: 5 }, generateText: async ({ kind }) => ({ content: JSON.stringify(kind === 'geo-keywords' ? { keywords: ['洗地机如何维护'] } : { title: '维护指南', body: '实际维护说明', sources: [] }), usage: { promptTokens: 10, completionTokens: 20 } }) });
        await work.dispatch('generate-keywords');
        const generated = work.snapshot().keywords.find(k => k.text === '洗地机如何维护');
        assert.ok(generated);
        await work.dispatch('generate-article', { keywordId: generated.id });
        assert.equal(work.snapshot().articles.at(-1).body, '实际维护说明');
        assert.equal(work.snapshot().ledger.at(-1).usage.promptTokens, 10);
        await work.dispatch('open-account', { platform: 'doubao' });
        await assert.rejects(work.dispatch('run-visibility', { keywordIds: [generated.id] }), /interrupted/);
        await assert.rejects(work.dispatch('run-visibility', { keywordIds: [generated.id] }), /待核对检测/);
        assert.equal(visibilityCalls, 1);
        console.log('geo-workbench self-check passed: approval, budget, unknown outcomes, recovery and reference evidence');
    }
    finally {
        work.dispose();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
