// Operates one platform page in the user's Chrome over the debugging pipe.
// Elements are found through the full DOM tree (closed shadow roots included)
// and clicked with real mouse events at their on-screen centre, so pages that
// hide controls inside web components behave as they do for a person.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attr = (node, key) => { const list = node.attributes || []; const index = list.indexOf(key); return index >= 0 ? list[index + 1] : undefined; };
const ownText = (node) => (node.children || []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join("").trim();
const kids = (node) => [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])];
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : kids(node).map(textOf).join("");
const classes = (node) => String(attr(node, "class") || "").split(/\s+/).filter(Boolean);

// With `open`, the page is a new tab created for this task, so tabs Chrome restored
// from an earlier session are never mistaken for it.
async function attachPage(browser, host, { timeoutMs = 30_000, open = "" } = {}) {
  const deadline = Date.now() + timeoutMs;
  if (open) {
    const { targetId } = await browser.send("Target.createTarget", { url: open });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("DOM.enable", {}, sessionId);
    const page = createPage(browser, sessionId);
    while (Date.now() <= deadline) {
      const [url, ready] = await Promise.all([page.url().catch(() => ""), page.evaluate("document.readyState").catch(() => "")]);
      if (url && url !== "about:blank" && ready === "complete") return page;
      await sleep(500);
    }
    throw Object.assign(new Error("platform page did not open"), { code: "SOCIAL_PAGE_MISSING" });
  }
  for (;;) {
    const { targetInfos = [] } = await browser.send("Target.getTargets");
    const target = targetInfos.find((item) => item.type === "page" && hostMatches(item.url, host));
    if (target) {
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      await browser.send("DOM.enable", {}, sessionId);
      return createPage(browser, sessionId);
    }
    if (Date.now() > deadline) throw Object.assign(new Error("platform page did not open"), { code: "SOCIAL_PAGE_MISSING" });
    await sleep(500);
  }
}
function hostMatches(url, host) {
  try { const name = new URL(url).hostname; return name === host || name.endsWith(`.${host}`); } catch { return false; }
}

function createPage(browser, sessionId) {
  const send = (method, params = {}) => browser.send(method, params, sessionId);
  // alert/confirm/beforeunload dialogs block every other call on the page; accept them so checks and navigation continue.
  browser.onEvent?.((message) => {
    if (message.sessionId === sessionId && message.method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  void send("Page.enable").catch(() => {});
  async function tree() {
    const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
    const nodes = [], parent = new Map();
    (function visit(node) { nodes.push(node); for (const child of kids(node)) { parent.set(child, node); visit(child); } })(root);
    const subtree = (node) => [node, ...kids(node).flatMap(subtree)];
    const ancestors = (node) => { const list = []; for (let current = parent.get(node); current; current = parent.get(current)) list.push(current); return list; };
    return { nodes, parent, subtree, ancestors };
  }
  async function box(node) {
    try {
      const { model } = await send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
      if (!model || model.width < 2 || model.height < 2) return null;
      const q = model.border;
      return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4, width: model.width, height: model.height };
    } catch { return null; }
  }
  async function visible(node) { return Boolean(await box(node)); }
  async function mouse(point, click = true) {
    const types = click ? ["mouseMoved", "mousePressed", "mouseReleased"] : ["mouseMoved"];
    for (const type of types) await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: click ? "left" : "none", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
  async function scrollTo(node) { await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }).catch(() => {}); }
  // A missing node is "not clicked", never an error: callers rely on that to know nothing was pressed.
  async function click(node) {
    if (!node) return false;
    await scrollTo(node);
    const point = await box(node);
    if (!point) return false;
    await mouse(point);
    return true;
  }
  async function hover(node) { if (!node) return false; await scrollTo(node); const point = await box(node); if (point) await mouse(point, false); return Boolean(point); }
  // First visible element matching the predicate, or null.
  async function find(predicate) {
    const view = await tree();
    for (const node of view.nodes) if (node.nodeType === 1 && predicate(node, view) && await visible(node)) return node;
    return null;
  }
  const byText = (text) => (node) => ownText(node) === text;
  const byClass = (name) => (node) => classes(node).includes(name);
  const byAttr = (key, value) => (node) => value instanceof RegExp ? value.test(attr(node, key) || "") : attr(node, key) === value;
  async function call(node, functionDeclaration) {
    const { object } = await send("DOM.resolveNode", { backendNodeId: node.backendNodeId });
    const { result } = await send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration, returnByValue: true });
    return result.value;
  }
  // Selects the field's whole content and types over it like a keyboard would, so leftover or restored text is replaced.
  async function type(node, text) {
    await scrollTo(node);
    await click(node);
    await call(node, `function () {
      this.focus();
      if (typeof this.select === "function" && (this.tagName === "INPUT" || this.tagName === "TEXTAREA")) { this.select(); return; }
      const range = document.createRange(); range.selectNodeContents(this);
      const selection = (this.getRootNode().getSelection ? this.getRootNode() : document).getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }`);
    await send("Input.insertText", { text });
    await sleep(400);
  }
  async function valueOf(node) { return call(node, "function () { return String(this.value ?? this.innerText ?? this.textContent ?? '').trim(); }"); }
  async function evaluate(expression) { const { result } = await send("Runtime.evaluate", { expression, returnByValue: true }); return result.value; }
  async function url() { return evaluate("location.href"); }
  // Text of the whole page including shadow roots, for status words such as 上传中 or 验证码.
  async function text() { const view = await tree(); return textOf(view.nodes[0]); }
  // Rendered text including open shadow roots, without script or style text. 视频号 draws its
  // form inside a shadow root, so its upload progress is missing from document.body.innerText (2026-10-29).
  async function shownText() {
    return String(await evaluate(`(() => { const out = [document.body ? document.body.innerText : ""];
      const walk = (root) => { for (const element of root.querySelectorAll("*")) if (element.shadowRoot) { for (const child of element.shadowRoot.children) out.push(child.innerText || ""); walk(element.shadowRoot); } };
      walk(document); return out.join("\\n"); })()`) || "");
  }
  async function setFile(node, file) { await send("DOM.setFileInputFiles", { files: [file], backendNodeId: node.backendNodeId }); }
  async function navigate(target) {
    const result = await send("Page.navigate", { url: target });
    if (result?.errorText) throw Object.assign(new Error(result.errorText), { code: "SOCIAL_NAVIGATION_FAILED" });
  }
  async function front() { await send("Page.bringToFront").catch(() => {}); }
  async function reload() { await send("Page.reload").catch(() => {}); }
  // Protocol events of this tab only (e.g. network failures kept as evidence); returns the unsubscribe.
  const onEvent = (listener) => browser.onEvent?.((message) => { if (message.sessionId === sessionId) listener(message); }) || (() => {});
  return { send, onEvent, tree, box, visible, mouse, click, hover, find, byText, byClass, byAttr, call, type, valueOf, evaluate, url, text, shownText, setFile, navigate, front, reload };
}

// pageFor: a page on a tab the caller created and attached itself (e.g. to start network capture before navigating).
module.exports = { attachPage, pageFor: createPage, hostMatches, attr, ownText, textOf, classes, sleep };
