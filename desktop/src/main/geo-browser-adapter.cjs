const { randomUUID, createHash } = require('node:crypto');
const TARGETS = {
    toutiao: { name: '今日头条', url: 'https://mp.toutiao.com/', hosts: ['mp.toutiao.com', 'sso.toutiao.com'] },
    baijiahao: { name: '百家号', url: 'https://baijiahao.baidu.com/', hosts: ['baijiahao.baidu.com', 'passport.baidu.com'] },
    sohu: { name: '搜狐', url: 'https://mp.sohu.com/', hosts: ['mp.sohu.com', 'passport.sohu.com'] },
    netease: { name: '网易新闻', url: 'https://mp.163.com/', hosts: ['mp.163.com', 'reg.163.com'] },
    zhihu: { name: '知乎', url: 'https://www.zhihu.com/creator', hosts: ['www.zhihu.com', 'zhuanlan.zhihu.com'] },
    xueqiu: { name: '雪球', url: 'https://xueqiu.com/', hosts: ['xueqiu.com'] },
    csdn: { name: 'CSDN', url: 'https://mp.csdn.net/', hosts: ['mp.csdn.net', 'passport.csdn.net', 'editor.csdn.net'] },
    doubao: { name: '豆包', url: 'https://www.doubao.com/chat/', hosts: ['www.doubao.com'] }
};
const PROFILE_PATTERNS = { toutiao: '(?:www\\.)?toutiao\\.com/(?:c/user|user)/([^/?#]+)', baijiahao: 'baijiahao\\.baidu\\.com/(?:u|home)/([^/?#]+)', sohu: '(?:mp|www)\\.sohu\\.com/(?:profile|user)/([^/?#]+)', netease: 'www\\.163\\.com/dy/media/([^/?#]+)', zhihu: 'www\\.zhihu\\.com/people/([^/?#]+)', xueqiu: 'xueqiu\\.com/(?:u/)?([0-9]{5,})', csdn: 'blog\\.csdn\\.net/([^/?#]+)' };
// Editor routes are candidate entrypoints. The editor DOM, submit control and
// receipt checks still have to pass; an entrypoint is never an acceptance claim.
const EDITORS = { toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish', baijiahao: 'https://baijiahao.baidu.com/builder/rc/edit?type=news', sohu: 'https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle', netease: 'https://mp.163.com/#/article-publish', zhihu: 'https://zhuanlan.zhihu.com/write', xueqiu: 'https://xueqiu.com/write', csdn: 'https://editor.csdn.net/md/' };
const CONTENT_HOSTS = { toutiao: ['www.toutiao.com'], baijiahao: ['baijiahao.baidu.com'], sohu: ['www.sohu.com'], netease: ['www.163.com'], zhihu: ['zhuanlan.zhihu.com', 'www.zhihu.com'], xueqiu: ['xueqiu.com'], csdn: ['blog.csdn.net'] };
async function submitEditor(contents, publication) {
    const baseline = await contents.executeJavaScript(`(()=>{const visible=e=>e.getClientRects().length>0;const nodes=[...document.querySelectorAll('[role="alert"],[role="status"],[class*="toast"],[class*="message-notice"]')].filter(visible);return nodes.map(e=>e.innerText.trim());})()`, true);
    await contents.executeJavaScript(`(()=>{const visible=e=>e.getClientRects().length>0;const body=document.body.innerText;if(/验证码|安全验证|异常访问/.test(body))throw Error('需要人工验证，未提交发布');const title=${JSON.stringify(publication.approvedArticle.title)},article=${JSON.stringify(publication.approvedArticle.body)};const titles=[...document.querySelectorAll('input,textarea')].filter(e=>visible(e)&&e.value.trim()===title);const editors=[...document.querySelectorAll('[contenteditable="true"],textarea')].filter(e=>visible(e)&&(e.value||e.innerText||'').trim()===article.trim());if(titles.length!==1||editors.length!==1)throw Error('平台正文或标题与批准稿不一致，未提交发布');const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&/^(发布|立即发布|发表文章|发布文章)$/.test((e.innerText||e.getAttribute('aria-label')||'').trim()));if(buttons.length!==1)throw Error('未识别唯一发布按钮，请人工检查平台步骤，未提交发布');buttons[0].click();})()`, true);
    for (let i = 0; i < 25; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const receipt = await contents.executeJavaScript(`(()=>{const old=new Set(${JSON.stringify(baseline)});const rows=[...document.querySelectorAll('[role="alert"],[role="status"],[class*="toast"],[class*="message-notice"]')].filter(e=>e.getClientRects().length).map(e=>e.innerText.trim()).filter(t=>!old.has(t));const reviewing=rows.find(t=>/提交审核成功|已提交审核|审核中/.test(t));if(reviewing)return {status:'reviewing',reason:reviewing.slice(0,500)};const submitted=rows.find(t=>/发布成功|提交成功|发表成功/.test(t));return submitted?{status:'submitted',reason:submitted.slice(0,500)}:null;})()`, true);
        if (receipt)
            return receipt;
    }
    return { status: 'outcome_unknown', reason: '已操作提交，但未提取到本次新增明确回执，请核对原文章；禁止重复提交' };
}
async function reconcilePage(contents, publication) {
    const hosts = CONTENT_HOSTS[publication.platform] || [];
    const current = contents.getURL();
    let parsed;
    try {
        parsed = new URL(current);
    }
    catch {
        return { status: 'outcome_unknown', reason: '当前页面地址无法识别' };
    }
    if (!hosts.includes(parsed.hostname) || /editor|\/write|\/builder\/|\/publish/.test(parsed.pathname))
        return { status: 'outcome_unknown', reason: '请在独立窗口打开原文章公开页后再次核对；当前页面不能证明已公开' };
    const matched = await contents.executeJavaScript(`(()=>{const title=${JSON.stringify(publication.approvedArticle.title)},body=${JSON.stringify(publication.approvedArticle.body)};const headings=[...document.querySelectorAll('h1,[role="heading"]')].filter(e=>e.getClientRects().length);const content=(document.querySelector('article')||document.querySelector('main')||document.body).innerText.replace(/\s+/g,'');return headings.some(e=>e.innerText.trim()===title)&&content.includes(body.replace(/\s+/g,'').slice(0,200));})()`, true);
    if (!matched)
        return { status: 'outcome_unknown', reason: '当前页面未同时匹配原文章标题和正文，不能确认结果' };
    try {
        const response = await contents.session.fetch(current, { credentials: 'omit', redirect: 'error' });
        const html = response.ok ? await response.text() : '';
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
        if (text.includes(publication.approvedArticle.title.replace(/\s+/g, '')) && text.includes(publication.approvedArticle.body.replace(/\s+/g, '').slice(0, 200)))
            return { status: 'public', url: current, reason: '官方文章页与批准稿一致，且匿名请求可以读取相同标题及正文片段' };
    }
    catch { }
    return { status: 'outcome_unknown', reason: '当前授权会话可见原文章，但尚未确认匿名公开可访问，不能标记已公开' };
}
function createCandidateDrivers() {
    const drivers = {};
    for (const platform of Object.keys(EDITORS))
        drivers[platform] = { accepted: false, editorUrl: EDITORS[platform], readIdentity: contents => readPageIdentity(contents, platform), async preparePublication(contents, article) { await contents.loadURL(EDITORS[platform]); return prepareEditor(contents, article); }, async publish(contents, publication) { const prepared = await this.preparePublication(contents, publication.approvedArticle); if (prepared.status !== 'prepared')
                return { status: 'failed', reason: prepared.reason }; return submitEditor(contents, publication); }, async reconcilePublication(contents, publication) { return reconcilePage(contents, publication); } };
    drivers.doubao = { accepted: false, readIdentity: contents => readPageIdentity(contents, 'doubao'), runVisibility: queryDoubao };
    return drivers;
}
async function readPageIdentity(contents, platform) {
    // Only own-account state containers and account-menu links count. Arbitrary
    // article-author links and the mere presence of a session cookie do not.
    return contents.executeJavaScript(`(()=>{const platform=${JSON.stringify(platform)},pattern=${JSON.stringify(PROFILE_PATTERNS[platform] || '')};
    const roots=[window.__INITIAL_STATE__,window.__NEXT_DATA__?.props?.pageProps,window.__NUXT__,window.__INITIAL_DATA__,window.__APP_DATA__].filter(Boolean);
    const pick=(v)=>{if(!v||typeof v!=='object')return null;const id=v.user_id??v.userId??v.uid??v.account_id??v.accountId??v.id;const name=v.nickname??v.nickName??v.nick_name??v.user_name??v.userName??v.display_name??v.name;if((typeof id==='string'||typeof id==='number')&&String(id)&&typeof name==='string'&&name.trim())return {id:String(id),displayName:name.trim().slice(0,200),source:'own-account-state'};return null;};
    for(const root of roots){for(const key of ['currentUser','current_user','loginUser','login_user','me']){const candidate=pick(root[key])||pick(root[key]?.user);if(candidate)return candidate;}if(root.loggedIn===true||root.isLogin===true||root.authenticated===true){for(const key of ['userInfo','user_info','accountInfo','account_info','passport']){const candidate=pick(root[key])||pick(root[key]?.user);if(candidate)return candidate;}}}
    if(pattern){const re=new RegExp('^https?://'+pattern,'i');for(const menu of document.querySelectorAll('[data-testid="account-menu"],[data-testid="user-menu"],[aria-label="账号"],[aria-label="个人中心"],header .user-info,header .userInfo,header .account-info,header .user-profile,nav .user-info')){for(const a of menu.querySelectorAll('a[href]')){const match=a.href.match(re);const name=(a.innerText||a.querySelector('img')?.alt||menu.querySelector('[class*="nickname"]')?.textContent||'').trim();if(match&&name&&!/登录|注册|login/i.test(name))return {id:match[1],displayName:name.slice(0,200),source:'own-account-profile-link'};}}}
    return null;})()`, true);
}
async function prepareEditor(contents, article) {
    return contents.executeJavaScript(`(()=>{const article=${JSON.stringify(article)};const visible=e=>e.getClientRects().length>0;
    const titles=[...document.querySelectorAll('input[placeholder],textarea[placeholder]')].filter(e=>visible(e)&&/标题|title/i.test(e.placeholder));
    const editors=[...document.querySelectorAll('[contenteditable="true"],[role="textbox"][contenteditable],textarea')].filter(e=>visible(e)&&!titles.includes(e));
    if(titles.length!==1||editors.length!==1)return {status:'awaiting_user',reason:'尚未识别唯一标题和正文编辑器，请先进入发文页面；未填写或提交'};
    const set=(e,value)=>{if(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement){const proto=e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);}else{e.focus();e.textContent=value;}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));};
    set(titles[0],article.title);set(editors[0],article.body);return {status:'prepared',reason:'已填写文章，请核对平台预览；尚未提交发布'};})()`, true);
}
async function queryDoubao(contents, { question }) {
    const baseline = await contents.executeJavaScript(`(()=>{const visible=e=>e.getClientRects().length>0;if(/验证码|安全验证|异常访问/.test(document.body.innerText))throw Error('需要人工验证');const answers=[...document.querySelectorAll('[data-message-id][data-role="assistant"],[data-message-id][data-message-role="assistant"]')].map(e=>e.getAttribute('data-message-id'));const inputs=[...document.querySelectorAll('textarea,[contenteditable="true"][role="textbox"]')].filter(visible);const buttons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&/^(发送|Send)$/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));if(inputs.length!==1||buttons.length!==1)throw Error('豆包输入区未通过 DOM 预检，未发送问题');const input=inputs[0];if(input instanceof HTMLTextAreaElement)Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(question)});else input.textContent=${JSON.stringify(question)};input.dispatchEvent(new Event('input',{bubbles:true}));return {ids:answers};})()`, true);
    // The send selector is rechecked after React consumes the input event.
    await contents.executeJavaScript(`(()=>{const buttons=[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length&&!e.disabled&&/^(发送|Send)$/i.test((e.getAttribute('aria-label')||e.innerText||'').trim()));if(buttons.length!==1)throw Error('发送入口不明确，未发送问题');buttons[0].click();})()`, true);
    let stable = 0, last = '';
    for (let i = 0; i < 90; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const result = await contents.executeJavaScript(`(()=>{if(/验证码|安全验证|异常访问/.test(document.body.innerText))throw Error('需要人工验证，请核对本次问题是否已发送');const old=new Set(${JSON.stringify(baseline.ids)});const rows=[...document.querySelectorAll('[data-message-id][data-role="assistant"],[data-message-id][data-message-role="assistant"]')].filter(e=>!old.has(e.getAttribute('data-message-id')));const row=rows.at(-1);if(!row)return null;const panel=row.querySelector('[data-testid="references"],[data-role="references"],.references');return {answer:row.innerText,references:panel?[...panel.querySelectorAll('a[href]')].filter(a=>/^https?:/.test(a.href)).map(a=>({title:a.innerText,url:a.href})):null,sessionConditions:{platform:'doubao',mode:'isolated_browser',messageId:row.getAttribute('data-message-id')}};})()`, true);
        if (result?.answer && result.answer === last)
            stable++;
        else
            stable = 0;
        last = result?.answer || '';
        if (stable >= 4 && !await contents.executeJavaScript(`(()=>[...document.querySelectorAll('button,[role="button"]')].some(e=>e.getClientRects().length&&/停止生成|停止回答|Stop generating/i.test(e.getAttribute('aria-label')||e.innerText||'')))()`))
            return result;
    }
    throw Error('豆包回答读取超时，结果待核对，禁止自动重复提问');
}
// Drivers are supplied only by audited main-process code after per-platform
// acceptance. A renderer payload cannot register a driver or unlock publication.
function createGeoBrowserAdapter({ BrowserWindow, session, partitionId, verifiedDrivers = {} }) {
    const candidateDrivers = createCandidateDrivers();
    verifiedDrivers = { ...candidateDrivers, ...verifiedDrivers };
    const windows = new Map(), accounts = new Map();
    const capabilities = Object.fromEntries(Object.entries(TARGETS).map(([id]) => [id, { publish: id !== 'doubao' && verifiedDrivers[id]?.accepted === true && typeof verifiedDrivers[id].publish === 'function', visibility: id === 'doubao' && verifiedDrivers[id]?.accepted === true && typeof verifiedDrivers[id].runVisibility === 'function', reason: '尚未完成真实账号授权、编辑器及结果回执验收' }]));
    function allowed(platform, url) {
        try {
            const u = new URL(url);
            return u.protocol === 'https:' && [...TARGETS[platform].hosts, ...(CONTENT_HOSTS[platform] || [])].includes(u.hostname);
        }
        catch {
            return false;
        }
    }
    async function openAccount(platform) {
        const target = TARGETS[platform];
        if (!target)
            throw Error('不支持的平台');
        let window = windows.get(platform);
        if (!window || window.isDestroyed()) {
            const partition = `persist:geo-workbench-${partitionId ? `${partitionId}-` : ''}${platform}`;
            const isolated = session.fromPartition(partition);
            isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
            isolated.on('will-download', event => event.preventDefault());
            window = new BrowserWindow({ width: 1120, height: 800, title: `${target.name} · GEO 授权`, show: true, backgroundColor: '#f8f4f0', webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
            windows.set(platform, window);
            window.webContents.setWindowOpenHandler(({ url }) => {
                if (allowed(platform, url))
                    window.loadURL(url).catch(() => { });
                return { action: 'deny' };
            });
            window.webContents.on('will-navigate', (event, url) => {
                if (!allowed(platform, url))
                    event.preventDefault();
            });
            window.webContents.on('will-redirect', (event, url) => {
                if (!allowed(platform, url))
                    event.preventDefault();
            });
            window.webContents.on('will-attach-webview', event => event.preventDefault());
            window.webContents.on('will-download', event => event.preventDefault());
            let timeout;
            try {
                await Promise.race([window.loadURL(target.url), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(Error('官方登录页加载超时')), 25000); })]);
            } catch {
                if (!window.isDestroyed()) window.destroy();
                windows.delete(platform);
                throw Error(`${target.name}登录页未能加载，请检查网络后重试；本地登录会话仍保留。`);
            } finally { clearTimeout(timeout); }
        }
        window.show();
        window.focus();
        return refreshAccount(platform);
    }
    async function refreshAccount(platform) {
        const window = windows.get(platform), driver = verifiedDrivers[platform];
        const previous = accounts.get(platform) || { id: randomUUID(), platform };
        let identity = null;
        if (window && !window.isDestroyed() && allowed(platform, window.webContents.getURL()))
            identity = typeof driver?.readIdentity === 'function' ? await driver.readIdentity(window.webContents) : await readPageIdentity(window.webContents, platform);
        const account = { ...previous, authorized: Boolean(identity?.id), displayName: identity?.displayName || `${TARGETS[platform]?.name || platform}账号待核实`, fingerprint: identity?.id ? createHash('sha256').update(`${platform}:${identity.id}`).digest('hex') : null, status: identity?.id ? 'authorized' : window && !window.isDestroyed() ? 'awaiting_verification' : 'closed', reason: identity?.id ? '已从当前页面的账号资料识别身份' : '请扫码或使用官方方式登录；未读取到可靠的当前账号资料时保持待核实', identitySource: identity?.source || null, checkedAt: new Date().toISOString() };
        accounts.set(platform, account);
        return account;
    }
    function context(platform) {
        const window = windows.get(platform);
        if (!window || window.isDestroyed() || !allowed(platform, window.webContents.getURL()))
            throw Error('请打开目标平台的独立授权会话');
        return window.webContents;
    }
    function driverFor(platform, method) {
        const driver = verifiedDrivers[platform];
        if (!driver?.accepted || typeof driver[method] !== 'function')
            throw Error('该平台操作尚未验收，不能执行');
        return driver;
    }
    return {
        capabilities, openAccount, refreshAccount,
        async preparePublication(publication) { const driver = verifiedDrivers[publication.platform]; return driver?.preparePublication ? driver.preparePublication(context(publication.platform), publication.approvedArticle) : prepareEditor(context(publication.platform), publication.approvedArticle); },
        async publish(publication) {
            const driver = driverFor(publication.platform, 'publish');
            const account = await refreshAccount(publication.platform);
            if (!account.authorized || account.fingerprint !== publication.accountFingerprint)
                throw Error('平台账号发生变化，请重新确认');
            return driver.publish(context(publication.platform), publication);
        },
        async reconcilePublication(publication) {
            const driver = verifiedDrivers[publication.platform];
            if (!driver?.accepted || !driver.reconcilePublication)
                return { status: 'outcome_unknown', reason: '此平台的只读结果识别尚未验收，请在平台核对原文章，禁止重复发布' };
            return driver.reconcilePublication(context(publication.platform), publication);
        },
        async runVisibility(input) {
            const driver = verifiedDrivers.doubao;
            const account = await refreshAccount('doubao');
            if (!account.authorized || account.fingerprint !== input.accountFingerprint)
                throw Error('豆包账号已变化或授权失效，请重新核对账号');
            return driver?.runVisibility ? driver.runVisibility(context('doubao'), input) : queryDoubao(context('doubao'), input);
        },
        dispose() {
            for (const window of windows.values())
                if (!window.isDestroyed())
                    window.close();
            windows.clear();
        }
    };
}
module.exports = { createGeoBrowserAdapter, TARGETS, EDITORS, createCandidateDrivers, readPageIdentity, prepareEditor, queryDoubao };
