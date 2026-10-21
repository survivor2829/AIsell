const fs = require('node:fs');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const CHANNELS = [['toutiao', '今日头条'], ['baijiahao', '百家号'], ['sohu', '搜狐'], ['netease', '网易新闻'], ['zhihu', '知乎'], ['xueqiu', '雪球'], ['csdn', 'CSDN']];
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const str = (value, max = 100000) => String(value || '').trim().slice(0, max);
const list = value => (Array.isArray(value) ? value : str(value).split(/[\n,，]/)).map(v => str(v, 1000)).filter(Boolean);
function parseGeneration(text) { try {
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
catch {
    throw Error('AI 结果不是有效 JSON；已保留调用记录，不自动重试');
} }
async function bounded(operation, timeoutMs = 120000) { let timer; try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('执行超时，请先核对原结果')), timeoutMs); })]);
}
finally {
    clearTimeout(timer);
} }
function classifyVisibility({ answer = '', references, brand, articles, publications }) {
    const names = [brand.name, ...(brand.aliases || [])].filter(Boolean);
    const hits = names.flatMap(name => { const at = answer.toLowerCase().indexOf(name.toLowerCase()); return at < 0 ? [] : [{ name, snippet: answer.slice(Math.max(0, at - 50), at + name.length + 80) }]; });
    const urls = value => { try {
        const u = new URL(value);
        u.hash = '';
        return u.href;
    }
    catch {
        return '';
    } };
    return { hits, mentioned: hits.length > 0, referenceStatus: Array.isArray(references) ? 'extracted' : 'unknown', references: (references || []).map(ref => {
            const published = publications.find(p => p.status === 'public' && urls(p.url) && urls(p.url) === urls(ref.url));
            const similar = articles.find(a => a.title && str(ref.title).toLowerCase() === a.title.toLowerCase());
            return { title: str(ref.title, 1000), url: /^https?:\/\//.test(ref.url || '') ? str(ref.url, 3000) : '', association: published ? 'confirmed' : similar ? 'suspected' : 'unmatched', articleId: published?.articleId || similar?.id || null };
        }) };
}
function createGeoWorkbenchController({ dataDir, adapter, onChange = () => { }, generateText, budgetPolicy = { approved: false } }) {
    const directory = path.join(dataDir, 'geo_workbench'), file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true });
    let state = { schemaVersion: 1, brand: { id: randomUUID(), version: 0, name: '', aliases: [], regions: [], services: '', cases: '', competitors: [], restrictions: '' }, brandHistory: [], keywords: [], articles: [], publications: [], visibilityRuns: [], accounts: [], settings: { maxKeywords: 5 }, ledger: [], lastError: null };
    if (fs.existsSync(file))
        state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    let busy = false, disposed = false;
    const channels = () => CHANNELS.map(([id, name]) => ({ id, name, publish: adapter?.capabilities?.[id]?.publish === true, reason: adapter?.capabilities?.[id]?.reason || '尚未完成真实账号授权与发布回执验收，暂不可发布' }));
    const snapshot = () => clone({ ...state, busy, channels: channels(), budget: { approved: budgetPolicy.approved === true, maxCalls: budgetPolicy.maxCalls || 0 } });
    function persist() { writeJsonAtomic(file, state, { mode: 0o600 }); onChange(snapshot()); }
    for (const p of state.publications)
        if (p.status === 'executing') {
            p.status = 'outcome_unknown';
            p.reason = '上次执行被中断，先核对原发布结果';
        }
    for (const entry of state.ledger)
        if (entry.status === 'executing') {
            entry.status = 'outcome_unknown';
            entry.finishedAt = now();
        }
    for (const run of state.visibilityRuns)
        if (run.status === 'executing') {
            run.status = 'outcome_unknown';
            run.reason = '上次检测中断，保留原任务，未自动重试';
        }
    for (const account of state.accounts) {
        account.authorized = false;
        account.status = 'needs_verification';
        account.reason = '本地会话已保留，请打开官方窗口后重新核对账号。';
    }
    persist();
    const find = (items, id, label) => { const item = items.find(v => v.id === id); if (!item)
        throw Error(`${label}不存在`); return item; };
    const article = id => find(state.articles, id, '文章');
    function invalidate() { for (const p of state.publications)
        if (p.status === 'approved' && !valid(p)) {
            p.status = 'invalidated';
            p.reason = '文章或账号已变化，请重新审稿';
        } }
    function valid(p) { const a = state.articles.find(a => a.id === p.articleId), account = state.accounts.find(a => a.id === p.accountId); return a && account && account.authorized && a.revision === p.revision && hash({ title: a.title, body: a.body }) === p.contentHash && account.fingerprint === p.accountFingerprint; }
    async function generate(kind, prompt, context) {
        const requestHash = hash({ kind, prompt });
        if (state.ledger.some(e => e.requestHash === requestHash && e.status === 'outcome_unknown'))
            throw Error('相同请求结果待核对，禁止自动重复购买');
        const previous = state.ledger.find(entry => entry.requestHash === requestHash && entry.status === 'completed' && entry.content);
        if (previous) return previous.content;
        if (!budgetPolicy.approved || !Number.isFinite(budgetPolicy.maxCalls) || budgetPolicy.maxCalls <= state.ledger.length || !generateText)
            throw Error('付费预算未批准或调用额度不足，尚未发起 AI 请求');
        const entry = { id: randomUUID(), kind, requestHash, status: 'executing', startedAt: now(), usage: null, amount: null };
        state.ledger.push(entry);
        persist();
        try {
            const result = await bounded(() => generateText({ kind, prompt, ...context }));
            entry.status = 'completed';
            entry.finishedAt = now();
            entry.usage = result?.usage || null;
            entry.amount = result?.amount ?? null;
            persist();
            const text = str(typeof result === 'string' ? result : result?.text || result?.content);
            if (!text)
                throw Error('AI 未返回有效内容');
            entry.content = text;
            persist();
            return text;
        }
        catch (error) {
            entry.status = 'outcome_unknown';
            entry.finishedAt = now();
            persist();
            throw error;
        }
    }
    async function execute(action, p = {}) {
        switch (action) {
            case 'status': return;
            case 'save-brand': {
                if (!str(p.name, 200))
                    throw Error('请填写品牌名称');
                state.brandHistory.push(clone(state.brand));
                state.brand = { ...state.brand, version: state.brand.version + 1, name: str(p.name, 200), aliases: list(p.aliases), regions: list(p.regions), services: str(p.services), cases: str(p.cases), competitors: list(p.competitors), restrictions: str(p.restrictions), updatedAt: now() };
                break;
            }
            case 'save-keyword': {
                if (!str(p.text, 1000))
                    throw Error('请填写关键词');
                const old = p.id ? find(state.keywords, p.id, '关键词') : null;
                const row = { id: old?.id || randomUUID(), text: str(p.text, 1000), enabled: p.enabled !== false };
                if (old)
                    Object.assign(old, row);
                else
                    state.keywords.push(row);
                break;
            }
            case 'import-keywords': {
                for (const text of list(p.text))
                    if (!state.keywords.some(k => k.text === text))
                        state.keywords.push({ id: randomUUID(), text, enabled: true });
                break;
            }
            case 'generate-keywords': {
                if (!state.brand.name)
                    throw Error('请先保存品牌资料');
                const text = await generate('geo-keywords', `基于以下真实品牌资料，生成 5 个潜在客户会询问的问题。只返回 JSON {"keywords":["问题"]}，不编造品牌事实：\n${JSON.stringify(state.brand)}`, { brand: clone(state.brand) });
                const result = parseGeneration(text);
                if (!Array.isArray(result.keywords) || !result.keywords.length || result.keywords.some(k => typeof k !== 'string' || !k.trim()))
                    throw Error('AI 关键词结构无效；未写入关键词');
                await execute('import-keywords', { text: result.keywords.slice(0, 5) });
                break;
            }
            case 'save-article': {
                if (!str(p.title, 500) || !str(p.body))
                    throw Error('请填写文章标题和正文');
                const old = p.id ? article(p.id) : null;
                const row = { id: old?.id || randomUUID(), revision: (old?.revision || 0) + 1, title: str(p.title, 500), body: str(p.body), keywordIds: list(p.keywordIds), sources: (Array.isArray(p.sources) ? p.sources : []).map(s => ({ title: str(s.title, 1000), url: /^https?:\/\//.test(s.url || '') ? str(s.url, 3000) : '' })), brandVersion: state.brand.version, brandSnapshot: clone(state.brand), updatedAt: now(), history: old ? [...(old.history || []), { revision: old.revision, title: old.title, body: old.body, brandVersion: old.brandVersion, sources: old.sources }] : [] };
                if (old)
                    Object.assign(old, row);
                else
                    state.articles.push(row);
                invalidate();
                break;
            }
            case 'generate-article': {
                const keyword = find(state.keywords, p.keywordId, '关键词');
                if (!state.brand.name)
                    throw Error('请先保存品牌资料');
                const text = await generate('geo-article', `为清洁设备渠道商撰写回答以下客户问题的文章：${keyword.text}\n只返回 JSON {"title":"标题","body":"正文","sources":[{"title":"资料名称","url":"原始来源"}]}。仅使用品牌资料中的事实，不编造案例、排名或来源链接；没有链接时sources为空数组。品牌资料：${JSON.stringify(state.brand)}`, { brand: clone(state.brand), keyword: clone(keyword) });
                const result = parseGeneration(text);
                if (typeof result.title !== 'string' || typeof result.body !== 'string' || !result.title.trim() || !result.body.trim() || !Array.isArray(result.sources))
                    throw Error('AI 文章结构无效；未保存为文章');
                await execute('save-article', { title: result.title, body: result.body, sources: result.sources, keywordIds: [keyword.id] });
                break;
            }
            case 'open-account':
            case 'refresh-account': {
                if (![...CHANNELS.map(c => c[0]), 'doubao'].includes(p.platform))
                    throw Error('不支持的平台');
                if (!adapter)
                    throw Error('浏览器适配器尚未初始化');
                const account = await adapter[action === 'open-account' ? 'openAccount' : 'refreshAccount'](p.platform);
                const old = state.accounts.find(a => a.platform === p.platform);
                if (old)
                    Object.assign(old, account);
                else
                    state.accounts.push(account);
                invalidate();
                break;
            }
            case 'approve-publication': {
                const a = article(p.articleId), account = find(state.accounts, p.accountId, '账号');
                if (account.platform !== p.platform || !account.authorized)
                    throw Error('目标账号尚未核实授权');
                if (!channels().some(c => c.id === p.platform))
                    throw Error('不支持的平台');
                const duplicate = state.publications.find(row => row.articleId === a.id && row.revision === a.revision && row.platform === p.platform && row.accountId === account.id && !['failed', 'invalidated'].includes(row.status));
                if (duplicate)
                    return;
                state.publications.push({ id: randomUUID(), articleId: a.id, revision: a.revision, platform: p.platform, accountId: account.id, accountFingerprint: account.fingerprint, contentHash: hash({ title: a.title, body: a.body }), approvedArticle: { title: a.title, body: a.body }, status: 'approved', approvedAt: now() });
                break;
            }
            case 'publish': {
                const publication = find(state.publications, p.publicationId, '发布记录');
                if (publication.status !== 'approved')
                    throw Error('此记录不能重复发布，请先核对结果');
                if (!valid(publication))
                    throw Error('审稿已失效，请重新确认');
                if (!channels().find(c => c.id === publication.platform)?.publish)
                    throw Error('该渠道尚未完成发布验收，保持不可发布');
                publication.status = 'executing';
                publication.startedAt = now();
                persist();
                try {
                    const result = await bounded(() => adapter.publish(clone(publication)));
                    Object.assign(publication, normalizeResult(result));
                }
                catch (error) {
                    publication.status = 'outcome_unknown';
                    publication.reason = '发布执行中断，结果待核对';
                    throw error;
                }
                finally {
                    persist();
                }
                break;
            }
            case 'reconcile-publication': {
                const publication = find(state.publications, p.publicationId, '发布记录');
                if (!['outcome_unknown', 'submitted', 'reviewing', 'public', 'unknown'].includes(publication.status))
                    throw Error('此记录没有待核对的发布结果');
                if (!adapter)
                    throw Error('浏览器适配器尚未初始化');
                Object.assign(publication, normalizeResult(await bounded(() => adapter.reconcilePublication(clone(publication)))));
                break;
            }
            case 'run-visibility': {
                if (!adapter)
                    throw Error('浏览器适配器尚未初始化');
                const account = state.accounts.find(a => a.platform === 'doubao' && a.authorized);
                if (!account)
                    throw Error('请先核实豆包账号');
                const selected = state.keywords.filter(k => k.enabled && (!p.keywordIds || p.keywordIds.includes(k.id))).slice(0, state.settings.maxKeywords);
                if (!selected.length)
                    throw Error('请选择启用的关键词');
                if (selected.some(k => state.visibilityRuns.some(r => r.question === k.text && r.accountId === account.id && r.status === 'outcome_unknown')))
                    throw Error('所选问题存在待核对检测，请在豆包核对原回答；不会重复提问');
                if (adapter.capabilities?.doubao?.visibility !== true)
                    throw Error(adapter.capabilities?.doubao?.reason || '豆包检测尚未完成真实验收，暂不可执行');
                for (const keyword of selected) {
                    const run = { id: randomUUID(), keywordId: keyword.id, question: keyword.text, accountId: account.id, accountFingerprint: account.fingerprint, brandSnapshot: clone(state.brand), startedAt: now(), status: 'executing' };
                    state.visibilityRuns.push(run);
                    persist();
                    try {
                        const result = await bounded(() => adapter.runVisibility({ question: keyword.text, accountId: account.id, accountFingerprint: account.fingerprint }));
                        if (!str(result.answer))
                            throw Error('未提取到本次回答');
                        Object.assign(run, { status: 'completed', answer: str(result.answer), sessionConditions: result.sessionConditions || {}, ...classifyVisibility({ answer: result.answer, references: result.references, brand: run.brandSnapshot, articles: state.articles, publications: state.publications }) });
                    }
                    catch (error) {
                        run.status = 'outcome_unknown';
                        run.reason = str(error.message, 1000);
                        throw error;
                    }
                    finally {
                        run.finishedAt = now();
                        persist();
                    }
                }
                break;
            }
            case 'save-settings': {
                if ('budgetApproved' in p)
                    throw Error('预算必须由可信主进程授权，界面不能解锁');
                state.settings.maxKeywords = Math.min(20, Math.max(1, Number(p.maxKeywords) || 5));
                break;
            }
            default: throw Error('未知 GEO 操作');
        }
    }
    async function dispatch(action, payload = {}) { if (disposed)
        throw Error('GEO 工作台已关闭'); if (action === 'status')
        return snapshot(); if (busy)
        throw Error('当前操作尚未完成'); busy = true; state.lastError = null; onChange(snapshot()); try {
        await execute(action, payload);
        persist();
        return snapshot();
    }
    catch (error) {
        state.lastError = str(error.message, 1000);
        persist();
        throw error;
    }
    finally {
        busy = false;
        onChange(snapshot());
    } }
    return { dispatch, snapshot, attachAdapter(value) { adapter = value; onChange(snapshot()); }, dispose() { disposed = true; adapter?.dispose?.(); } };
}
function normalizeResult(result = {}) { return { status: ['submitted', 'reviewing', 'public', 'failed', 'outcome_unknown', 'unknown'].includes(result.status) ? result.status : 'outcome_unknown', url: /^https?:\/\//.test(result.url || '') ? str(result.url, 3000) : null, reason: str(result.reason, 1000), checkedAt: now() }; }
module.exports = { createGeoWorkbenchController, classifyVisibility, CHANNELS };
