// Runtime-ish smoke test for the batch upload page's critical UX path.
//
// It executes templates/batch/upload.html's inline script in a tiny mocked DOM,
// then simulates:
//   1) clicking the picker surface,
//   2) selecting a folder file,
//   3) clicking upload,
//   4) receiving XHR upload progress + success.
//
// No Flask server, browser, network, pytest, or project dependencies required.

const fs = require("fs");
const vm = require("vm");

class Element {
  constructor(id = "", tag = "div") {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.listeners = {};
    this.children = [];
    this.style = {};
    this.className = "";
    this._textContent = "";
    this.textHistory = [];
    this.innerHTML = "";
    this.value = "";
    this.disabled = false;
    this.files = [];
    this.classList = {
      values: new Set(),
      add: (...names) => names.forEach((name) => this.classList.values.add(name)),
      remove: (...names) => names.forEach((name) => this.classList.values.delete(name)),
      contains: (name) => this.classList.values.has(name),
    };
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.textHistory.push(this._textContent);
  }

  addEventListener(type, cb) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(cb);
  }

  async dispatchEvent(evt) {
    evt.target = evt.target || this;
    evt.preventDefault = evt.preventDefault || (() => { evt.defaultPrevented = true; });
    const callbacks = this.listeners[evt.type] || [];
    for (const cb of callbacks) {
      await cb(evt);
    }
  }

  click() {
    this.clickCount = (this.clickCount || 0) + 1;
  }

  querySelector() {
    return new Element("", "span");
  }

  insertAdjacentHTML() {}
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child) { this.children.push(child); return child; }
  remove() {}
  replaceWith() {}
}

const ids = new Map();
for (const id of [
  "folderInput", "picker", "pickerHint", "btnUpload", "btnReset", "status",
  "batchName", "productCategory", "fixedThemeRow", "fixedThemeId", "resultArea",
  "estimateModal", "estimateBody", "btnEstimateCancel", "btnEstimateConfirm",
]) {
  ids.set(id, new Element(id));
}
ids.get("productCategory").value = "耗材类";
ids.get("fixedThemeId").value = "";

const documentStub = {
  readyState: "loading",
  visibilityState: "visible",
  body: new Element("body", "body"),
  listeners: {},
  getElementById: (id) => ids.get(id) || null,
  querySelector: (selector) => {
    if (selector === "meta[name=\"csrf-token\"]" || selector === "meta[name='csrf-token']") {
      return { content: "csrf-test-token" };
    }
    if (selector === "input[name=\"templateStrategy\"]:checked" || selector === "input[name='templateStrategy']:checked") {
      return { value: "auto" };
    }
    return new Element("", "div");
  },
  querySelectorAll: () => [{ addEventListener() {}, checked: true, value: "auto" }],
  createElement: (tag) => new Element("", tag),
  addEventListener(type, cb) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(cb);
  },
};

class MockJSZip {
  file() {}
  async generateAsync() {
    return { size: 5 * 1024 * 1024 };
  }
}

class MockFormData {
  constructor() { this.items = []; }
  append(key, value, filename) { this.items.push({ key, value, filename }); }
}

const xhrCalls = [];
class MockXMLHttpRequest {
  constructor() {
    const response = MockXMLHttpRequest.responses.shift() || {
      status: 200,
      statusText: "OK",
      body: {
        valid_count: 1,
        skipped_count: 0,
        products: [],
        skipped: [],
        batch_id: "batch_smoke",
        batch_name: "smoke",
        template_strategy: "auto",
        product_category: "耗材类",
      },
    };
    this.upload = {};
    this.headers = {};
    this.status = response.status;
    this.statusText = response.statusText;
    this.responseText = JSON.stringify(response.body || {});
    xhrCalls.push(this);
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key] = value; }
  send(body) {
    this.body = body;
    if (this.upload.onprogress) {
      this.upload.onprogress({ loaded: 2 * 1024 * 1024, total: 5 * 1024 * 1024, lengthComputable: true });
      this.upload.onprogress({ loaded: 5 * 1024 * 1024, total: 5 * 1024 * 1024, lengthComputable: true });
    }
    if (this.onload) this.onload();
  }
}
MockXMLHttpRequest.responses = [];

const sandbox = {
  console,
  document: documentStub,
  window: { CSS: null },
  CSS: null,
  location: { hash: "", pathname: "/batch/upload", protocol: "http:", host: "localhost:5000" },
  history: { replaceState() {} },
  localStorage: { getItem: () => "" },
  WebSocket: { OPEN: 1, CONNECTING: 0, CLOSED: 3, CLOSING: 2 },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance: { now: (() => { let t = 0; return () => { t += 500; return t; }; })() },
  fetch: async (url) => {
    if (url === "/api/themes") return { json: async () => ({ themes: [] }) };
    throw new Error(`unexpected fetch: ${url}`);
  },
  JSZip: MockJSZip,
  FormData: MockFormData,
  XMLHttpRequest: MockXMLHttpRequest,
};
sandbox.window.CSS = sandbox.CSS;

const html = fs.readFileSync("templates/batch/upload.html", "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
if (scripts.length !== 1) throw new Error(`expected 1 inline script, got ${scripts.length}`);

vm.createContext(sandbox);
vm.runInContext(scripts[0], sandbox, { filename: "templates/batch/upload.html:inline.js" });

(async () => {
  const picker = ids.get("picker");
  const folderInput = ids.get("folderInput");
  const btnUpload = ids.get("btnUpload");
  const status = ids.get("status");

  await picker.dispatchEvent({ type: "click", target: ids.get("pickerHint") });
  if (folderInput.clickCount !== 1) {
    throw new Error(`expected picker click to trigger folderInput.click once, got ${folderInput.clickCount || 0}`);
  }

  folderInput.files = [{
    name: "product.jpg",
    webkitRelativePath: "smoke/ProductA/product.jpg",
  }];
  await folderInput.dispatchEvent({ type: "change", target: folderInput });
  if (btnUpload.disabled) throw new Error("upload button should be enabled after selecting files");

  await btnUpload.dispatchEvent({ type: "click", target: btnUpload });
  if (xhrCalls.length !== 1) throw new Error(`expected 1 XHR upload, got ${xhrCalls.length}`);
  if (xhrCalls[0].url !== "/api/batch/upload") throw new Error(`unexpected XHR url ${xhrCalls[0].url}`);
  if (xhrCalls[0].headers["X-CSRFToken"] !== "csrf-test-token") throw new Error("missing CSRF header");
  if (!status.textHistory.some((text) => /上传中 \d+%/.test(text) && text.includes("剩余"))) {
    throw new Error(`expected progress status with percent and ETA, got: ${status.textHistory.join(" | ")}`);
  }
  if (!status.textContent.includes("识别完成")) {
    throw new Error(`expected success status, got: ${status.textContent}`);
  }
  if (btnUpload.disabled || ids.get("btnReset").disabled) {
    throw new Error("upload/reset buttons should be re-enabled after successful upload");
  }

  MockXMLHttpRequest.responses.push({
    status: 400,
    statusText: "Bad Request",
    body: { error: "bad zip" },
  });
  await btnUpload.dispatchEvent({ type: "click", target: btnUpload });
  if (xhrCalls.length !== 2) throw new Error(`expected second XHR upload, got ${xhrCalls.length}`);
  if (!status.textContent.includes("上传失败 400: bad zip")) {
    throw new Error(`expected backend error status, got: ${status.textContent}`);
  }
  if (btnUpload.disabled || ids.get("btnReset").disabled) {
    throw new Error("upload/reset buttons should be re-enabled after failed upload");
  }

  console.log("batch upload runtime smoke passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
