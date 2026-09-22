const crypto = require("node:crypto");

const HOME = "https://www.douyin.com/";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problem = (code, message) => Object.assign(new Error(message), { code });
const compact = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const validPeer = (value) => /^[A-Za-z0-9_-]{8,160}$/.test(String(value || ""));

function allowedUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com")); }
  catch { return false; }
}

// Only consume responses produced by the official page. No private endpoint is
// replayed and no token, cookie or request header is read into application state.
function parsePageResponse(url, body) {
  let pathname;
  try { const parsed = new URL(url); if (!allowedUrl(url)) return {}; pathname = parsed.pathname; } catch { return {}; }
  if (/\/user\/profile\/self\/?$/.test(pathname)) {
    const user = body?.user;
    return { account: user && validPeer(user.sec_uid) ? { id: user.sec_uid, name: compact(user.nickname, 100) } : null };
  }
  if (/\/comment\/list\/?$/.test(pathname) && Array.isArray(body?.comments)) {
    return { comments: body.comments.flatMap((comment) => {
      const user = comment?.user;
      if (!comment?.cid || !/^\d+$/.test(String(comment.aweme_id || "")) || !validPeer(user?.sec_uid) || !compact(comment.text)) return [];
      return [{ id: String(comment.cid), videoId: String(comment.aweme_id), peerId: user.sec_uid,
        name: compact(user.nickname, 100), text: compact(comment.text), createdAt: Number(comment.create_time) > 0 ? new Date(Number(comment.create_time) * 1000).toISOString() : "" }];
    }), hasMore: body.has_more === 1 };
  }
  return {};
}

// Kept in a pure page function so the bounded DOM contract can be exercised
// without loading the platform or borrowing the main application's preload.
function inspectPage() {
  const shown = (node) => !!node && !!node.getClientRects().length;
  const text = (node) => String(node?.innerText || node?.textContent || "").trim();
  const bodyText = text(document.body);
  const challenge = Array.from(document.querySelectorAll('[class*="captcha"], [id*="captcha"], [role="dialog"]')).some((node) => shown(node) && /完成验证|安全验证|拖动滑块|点击验证/.test(text(node)));
  const videos = Array.from(document.querySelectorAll('a[href*="/video/"]')).filter(shown).flatMap((node) => {
    const match = node.href.match(/\/video\/(\d+)/);
    return match ? [{ id: match[1], title: text(node).slice(0, 200) }] : [];
  });
  const comments = Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).filter(shown).flatMap((node) => {
    const author = node.querySelector('a[href*="/user/"]');
    const peerId = author?.href?.match(/\/user\/([A-Za-z0-9_-]+)/)?.[1];
    const content = node.querySelector('[data-e2e="comment-content"], [data-e2e="comment-text"]');
    const videoId = location.href.match(/\/video\/(\d+)/)?.[1];
    const id = node.getAttribute("data-comment-id") || node.getAttribute("data-id");
    return id && peerId && videoId && text(content) ? [{ id, peerId, videoId, name: text(author).slice(0, 100), text: text(content).slice(0, 2000), createdAt: "" }] : [];
  });
  return { challenge, videos, comments, emptySearch: /暂无搜索结果|未找到相关视频/.test(bodyText),
    loginRequired: /扫码登录|登录后查看完整/.test(bodyText), url: location.href };
}

function inspectConversation(expectedPeer) {
  const visible = (node) => !!node && !!node.getClientRects().length;
  const root = Array.from(document.querySelectorAll('[data-e2e="chat-conversation"][data-peer-id]')).filter(visible);
  if (root.length !== 1 || root[0].getAttribute("data-peer-id") !== expectedPeer) return { supported: false };
  const messages = Array.from(root[0].querySelectorAll('[data-message-id][data-sender-id]')).flatMap((node) => {
    const content = node.querySelector('[data-e2e="message-text"]');
    const text = String(content?.textContent || "").trim();
    const status = node.getAttribute("data-send-status");
    return text ? [{ id: node.getAttribute("data-message-id"), senderId: node.getAttribute("data-sender-id"), text: text.slice(0, 2000), status, createdAt: node.getAttribute("data-timestamp") || "" }] : [];
  });
  const editors = Array.from(root[0].querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(visible);
  const buttons = Array.from(root[0].querySelectorAll('button, [role="button"]')).filter((node) => visible(node) && String(node.textContent || "").trim() === "发送");
  const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  return { supported: true, messages, editor: editors.length === 1 ? rect(editors[0]) : null,
    editorText: editors.length === 1 ? String(editors[0].textContent || "").trim() : "",
    sendButton: buttons.length === 1 && !buttons[0].disabled ? rect(buttons[0]) : null };
}

function createDouyinBrowserAdapter({ BrowserWindow, session, partitionId, onStatus = () => {}, onClose = () => {} }) {
  let window = null;
  let account = null;
  let state = "closed";
  let pendingResponses = new Map();
  let responseComments = new Map();
  let captureFailure = "";
  const partition = `persist:keyword-acquisition-${partitionId || crypto.randomUUID()}`;
  const capabilities = { discover: true, send: false, inbox: false };
  const status = () => ({ state, account, capabilities: { ...capabilities } });
  function notify() { onStatus(status()); }
  function requireWindow() { if (!window || window.isDestroyed()) throw problem("DOUYIN_WINDOW_CLOSED", "请先连接抖音。"); return window; }
  async function evaluate(fn, ...args) {
    const target = requireWindow();
    if (!allowedUrl(target.webContents.getURL())) throw problem("DOUYIN_PAGE_UNSUPPORTED", "请在抖音页面继续操作。");
    return target.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  }
  async function navigate(url) {
    if (!allowedUrl(url)) throw problem("DOUYIN_URL_INVALID", "无法打开这条抖音链接。");
    const target = requireWindow();
    let timeout;
    try { await Promise.race([target.loadURL(url), new Promise((_resolve, reject) => { timeout = setTimeout(() => { if (!target.isDestroyed()) target.webContents.stop(); reject(problem("DOUYIN_PAGE_TIMEOUT", "抖音页面加载超时，请检查网络后重试。")); }, 25_000); })]); }
    finally { clearTimeout(timeout); }
  }
  async function open() {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return status(); }
    if (!BrowserWindow || !session) throw problem("DOUYIN_BROWSER_UNAVAILABLE", "当前环境未连接抖音浏览器，请重新打开桌面应用。");
    const browserSession = session.fromPartition(partition);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 650, title: "关键词获客 · 抖音", autoHideMenuBar: true,
      webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const wc = window.webContents;
    wc.setWindowOpenHandler(({ url }) => { if (allowedUrl(url)) void navigate(url).catch(() => {}); return { action: "deny" }; });
    for (const eventName of ["will-navigate", "will-redirect"]) wc.on(eventName, (event, url) => { if (!allowedUrl(url)) event.preventDefault(); });
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.on("render-process-gone", () => { state = "interrupted"; capabilities.send = false; capabilities.inbox = false; notify(); onClose(); });
    window.on("closed", () => { window = null; account = null; state = "closed"; capabilities.send = false; capabilities.inbox = false; pendingResponses.clear(); responseComments.clear(); notify(); onClose(); });
    try { wc.debugger.attach("1.3"); await wc.debugger.sendCommand("Network.enable", { maxResourceBufferSize: 4 * 1024 * 1024, maxTotalBufferSize: 8 * 1024 * 1024 }); }
    catch { window.destroy(); throw problem("DOUYIN_BROWSER_UNAVAILABLE", "抖音浏览器连接失败，请重新打开。"); }
    wc.debugger.on("message", async (_event, method, params) => {
      if (method === "Network.responseReceived") {
        const url = params.response?.url || "";
        if (allowedUrl(url) && /\/user\/profile\/self\/?(?:\?|$)|\/comment\/list\/?(?:\?|$)/.test(url) && params.response?.status === 200) {
          if (pendingResponses.size >= 100) pendingResponses.delete(pendingResponses.keys().next().value);
          pendingResponses.set(params.requestId, url);
        }
      } else if (method === "Network.loadingFailed") pendingResponses.delete(params.requestId);
      else if (method === "Network.loadingFinished" && pendingResponses.has(params.requestId)) {
        const url = pendingResponses.get(params.requestId); pendingResponses.delete(params.requestId);
        try {
          if (params.encodedDataLength > 4 * 1024 * 1024) return;
          const result = await wc.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId });
          const raw = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
          if (raw.length > 4 * 1024 * 1024) return;
          const observed = parsePageResponse(url, JSON.parse(raw));
          if (Object.hasOwn(observed, "account")) { account = observed.account; state = account ? "connected" : "login_required"; notify(); }
          for (const comment of observed.comments || []) {
            if (responseComments.size >= 5000) responseComments.delete(responseComments.keys().next().value);
            responseComments.set(`${comment.videoId}:${comment.id}`, comment);
          }
        } catch { captureFailure = "抖音页面数据暂时无法读取，可在浏览器完成加载后重试。"; }
      }
    });
    wc.debugger.on("detach", () => { if (window && !window.isDestroyed()) { state = "interrupted"; capabilities.send = false; capabilities.inbox = false; notify(); onClose(); } });
    state = "login_required"; notify();
    await navigate(HOME);
    return status();
  }
  async function refreshAccount() {
    requireWindow();
    account = null; state = "checking"; notify();
    await navigate(`${HOME}user/self`);
    for (let i = 0; i < 20 && !account; i += 1) { await pause(250); if (!window || window.isDestroyed()) break; }
    if (!account) { const page = await evaluate(inspectPage); state = page.challenge ? "verification_required" : page.loginRequired ? "login_required" : "identity_unavailable"; notify(); }
    return status();
  }
  function assertAccount(expectedId) {
    requireWindow();
    if (!account?.id || state !== "connected") throw problem("DOUYIN_LOGIN_REQUIRED", "请先在抖音窗口完成登录，再点击“刷新账号”。");
    if (expectedId && account.id !== expectedId) throw problem("DOUYIN_ACCOUNT_CHANGED", "抖音账号已切换，请停止任务后使用原账号继续。");
  }
  async function pageState() {
    const page = await evaluate(inspectPage);
    if (page.challenge) throw problem("DOUYIN_VERIFICATION_REQUIRED", "抖音需要安全验证，请在抖音窗口完成后继续。");
    return page;
  }
  async function scrollComments() {
    await evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('[data-e2e*="comment"], [class*="comment"]')).filter((node) => node.scrollHeight > node.clientHeight + 100 && node.clientHeight > 150);
      const scroller = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0];
      if (scroller) scroller.scrollBy(0, Math.max(400, scroller.clientHeight * 0.8)); else window.scrollBy(0, 600);
    });
  }
  async function discover({ keywords, limit, accountId, shouldContinue = () => true, onComment, onProgress = () => {} }) {
    assertAccount(accountId);
    const seenVideos = new Set(); const seenComments = new Set();
    let observed = 0;
    for (const keyword of keywords) {
      if (!shouldContinue()) return;
      onProgress(`正在搜索：${keyword}`);
      await navigate(`${HOME}search/${encodeURIComponent(keyword)}?type=video`);
      let page;
      for (let i = 0; i < 20 && shouldContinue(); i += 1) { await pause(300); page = await pageState(); if (page.videos.length || page.emptySearch) break; }
      if (!shouldContinue()) return;
      if (!page?.videos.length && !page?.emptySearch) throw problem("DOUYIN_SEARCH_UNRECOGNIZED", "暂时无法读取搜索结果。请在抖音窗口确认页面已加载，再继续任务。");
      const foundVideos = new Map((page?.videos || []).map((video) => [video.id, video]));
      for (let pageIndex = 0; pageIndex < 2 && foundVideos.size < limit && shouldContinue(); pageIndex += 1) {
        await evaluate(() => window.scrollBy(0, Math.max(700, innerHeight * 0.85)));
        await pause(600);
        const next = await pageState(); const count = foundVideos.size;
        for (const video of next.videos) foundVideos.set(video.id, video);
        if (foundVideos.size === count) break;
      }
      for (const video of foundVideos.values()) {
        if (seenVideos.has(video.id) || !shouldContinue()) continue;
        seenVideos.add(video.id); responseComments.clear();
        assertAccount(accountId); onProgress(`正在读取评论：${keyword}`);
        await navigate(`${HOME}video/${video.id}`);
        let unchanged = 0; let previousCount = 0;
        for (let pass = 0; pass < 8 && shouldContinue(); pass += 1) {
          await pause(pass === 0 ? 1200 : 600);
          const current = await pageState();
          const comments = [...responseComments.values(), ...current.comments].filter((item) => item.videoId === video.id);
          for (const comment of comments) {
            const key = `${comment.videoId}:${comment.id}`;
            if (seenComments.has(key) || !shouldContinue()) continue;
            assertAccount(accountId); seenComments.add(key); observed += 1;
            await onComment({ ...comment, keyword, videoTitle: video.title, sourceUrl: `${HOME}video/${video.id}` });
            if (observed >= limit) return;
          }
          unchanged = seenComments.size === previousCount ? unchanged + 1 : 0; previousCount = seenComments.size;
          if (unchanged >= 3) break;
          await scrollComments();
        }
      }
    }
    if (!observed && seenVideos.size) throw problem("DOUYIN_COMMENTS_UNAVAILABLE", captureFailure || "已找到视频，但尚未读取到可确认来源的评论。请在抖音窗口展开评论后重试。");
  }
  async function openPeer(peerId) {
    if (!validPeer(peerId)) throw problem("DOUYIN_PEER_INVALID", "这条线索缺少可确认的抖音用户标识。");
    assertAccount(); await navigate(`${HOME}user/${peerId}`); requireWindow().show(); requireWindow().focus();
  }
  async function openConversation(peerId) {
    await openPeer(peerId);
    for (let i = 0; i < 12; i += 1) {
      await pause(300);
      const point = await evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((node) => node.getClientRects().length && /^(私信|发私信)$/.test(String(node.textContent || "").trim()));
        if (buttons.length !== 1) return null;
        const r = buttons[0].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!point) continue;
      const debug = requireWindow().webContents.debugger;
      await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      return;
    }
    throw problem("DOUYIN_CHAT_ENTRY_UNAVAILABLE", "已打开客户主页，但未找到可确认的私信入口。请在抖音窗口手动打开会话。");
  }
  async function readConversation({ peerId, accountId }) {
    assertAccount(accountId);
    const result = await evaluate(inspectConversation, peerId);
    if (!result.supported) { capabilities.inbox = false; capabilities.send = false; notify(); throw problem("DOUYIN_INBOX_UNVERIFIED", "请在抖音窗口打开对应私信。当前页面结构尚不能确认会话归属，暂未同步或发送。"); }
    capabilities.inbox = true; capabilities.send = Boolean(result.editor && result.sendButton); notify();
    return result.messages.filter((item) => item.senderId === peerId || item.senderId === account.id).map((item) => ({ ...item, direction: item.senderId === peerId ? "incoming" : "outgoing" }));
  }
  async function send({ peerId, accountId, text, expectedIncomingId, shouldContinue, onTransition }) {
    assertAccount(accountId);
    const before = await evaluate(inspectConversation, peerId);
    if (!before.supported || !before.editor || !before.sendButton) throw problem("DOUYIN_SEND_UNVERIFIED", "当前抖音私信页面尚未完成适配，消息没有发送。");
    if (before.editorText) throw problem("DOUYIN_DRAFT_PRESENT", "抖音输入框里已有文字，请先处理已有草稿。");
    const currentIncoming = before.messages.filter((item) => item.senderId === peerId).at(-1)?.id || "";
    if (currentIncoming !== (expectedIncomingId || "")) throw problem("DOUYIN_CONVERSATION_CHANGED", "客户已有新消息，请同步后重新确认回复。");
    if (!shouldContinue()) throw problem("KEYWORD_STOPPED", "任务已停止，消息没有发送。");
    const debuggerApi = requireWindow().webContents.debugger;
    const click = async ({ x, y }) => { await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); };
    await click(before.editor); await debuggerApi.sendCommand("Input.insertText", { text });
    const prepared = await evaluate(inspectConversation, peerId);
    if (!prepared.supported || prepared.editorText !== text || !prepared.sendButton) throw problem("DOUYIN_DRAFT_MISMATCH", "抖音草稿核对未通过，消息没有发送，请检查输入框。");
    if ((prepared.messages.filter((item) => item.senderId === peerId).at(-1)?.id || "") !== currentIncoming) throw problem("DOUYIN_CONVERSATION_CHANGED", "客户已有新消息，草稿尚未发送，请同步后重新确认。");
    assertAccount(accountId);
    if (!shouldContinue()) throw problem("KEYWORD_STOPPED", "任务已停止，抖音输入框里的草稿尚未发送。");
    await onTransition("clicked"); // Durable marker must precede the irreversible click.
    assertAccount(accountId);
    if (!shouldContinue()) throw problem("KEYWORD_STOPPED", "任务已停止，请检查抖音草稿。");
    await click(prepared.sendButton);
    const existing = new Set(before.messages.map((item) => item.id));
    for (let i = 0; i < 12; i += 1) {
      await pause(350);
      assertAccount(accountId);
      const after = await evaluate(inspectConversation, peerId);
      const receipt = after.supported && after.messages.find((item) => !existing.has(item.id) && item.senderId === accountId && item.text === text && item.status === "sent");
      if (receipt) return { status: "sent_verified", messageId: receipt.id };
    }
    return { status: "outcome_unknown", reason: "已点击发送，但抖音尚未提供可核对的发送结果。请在会话中检查，系统不会自动补发。" };
  }
  function dispose() { if (window && !window.isDestroyed()) window.destroy(); }
  return { status, open, refreshAccount, assertAccount, discover, openPeer, openConversation, readConversation, send, dispose,
    stop: () => { if (window && !window.isDestroyed()) window.webContents.stop(); },
    openSource: async (url) => { await open(); await navigate(url); } };
}

module.exports = { createDouyinBrowserAdapter, parsePageResponse, inspectPage, inspectConversation, allowedUrl };
