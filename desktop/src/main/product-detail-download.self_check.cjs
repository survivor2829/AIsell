const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  PRODUCT_DETAIL_DOWNLOAD_CHANNEL,
  isAllowedProductDetailUrl,
  registerProductDetailDownloads,
  sanitizeDownloadFilename
} = require("./product-detail-download.cjs");

function createItem({ url, filename }) {
  const item = new EventEmitter();
  item.getURL = () => url;
  item.getFilename = () => filename;
  item.setSavePath = (value) => {
    item.savePath = value;
  };
  return item;
}

function createDownloadEvent() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    }
  };
}

assert.equal(
  isAllowedProductDetailUrl(
    "blob:http://localhost:43123/6aa270d4-f9a7-4ab2-a337-f81238f3e371",
    "http://localhost:43123"
  ),
  true
);
assert.equal(
  isAllowedProductDetailUrl(
    "http://localhost:43123/static/ai_refine_v2/result/assembled.png",
    "http://localhost:43123"
  ),
  true
);
assert.equal(
  isAllowedProductDetailUrl("blob:http://127.0.0.1:43123/id", "http://localhost:43123"),
  false
);
assert.equal(
  isAllowedProductDetailUrl("https://example.com/file.png", "http://localhost:43123"),
  false
);
assert.equal(sanitizeDownloadFilename("设备类:详情图.png"), "设备类_详情图.png");
assert.equal(sanitizeDownloadFilename("../../private.txt"), "");

const session = new EventEmitter();
const sent = [];
const diagnosticEvents = [];
const mainWebContents = {
  send: (channel, payload) => sent.push({ channel, payload })
};
const mainWindow = {
  isDestroyed: () => false,
  webContents: mainWebContents
};
const desktopDir = "C:\\Users\\Tester\\Desktop";
const existing = new Set([
  path.join(desktopDir, "设备类_详情图.png").toLowerCase()
]);

const registration = registerProductDetailDownloads({
  session,
  getMainWindow: () => mainWindow,
  getProductDetailOrigin: () => "http://localhost:43123",
  getDesktopPath: () => desktopDir,
  existsSync: (candidate) => existing.has(candidate.toLowerCase()),
  diagnostics: {
    event: (component, event, payload, options) => {
      diagnosticEvents.push({ component, event, payload, options });
    }
  }
});

const disallowed = createItem({
  url: "https://example.com/not-product-detail.png",
  filename: "not-product-detail.png"
});
const disallowedEvent = createDownloadEvent();
session.emit("will-download", disallowedEvent, disallowed, mainWebContents);
assert.equal(disallowed.savePath, undefined);
assert.equal(disallowedEvent.defaultPrevented, true);

const disallowedType = createItem({
  url: "http://localhost:43123/static/untrusted.exe",
  filename: "untrusted.exe"
});
const disallowedTypeEvent = createDownloadEvent();
session.emit("will-download", disallowedTypeEvent, disallowedType, mainWebContents);
assert.equal(disallowedType.savePath, undefined);
assert.equal(disallowedTypeEvent.defaultPrevented, true);

const wrongWindow = createItem({
  url: "blob:http://localhost:43123/wrong-window",
  filename: "wrong-window.png"
});
const wrongWindowEvent = createDownloadEvent();
session.emit("will-download", wrongWindowEvent, wrongWindow, { send() {} });
assert.equal(wrongWindow.savePath, undefined);
assert.equal(wrongWindowEvent.defaultPrevented, false);

const item = createItem({
  url: "blob:http://localhost:43123/accepted",
  filename: "设备类:详情图.png"
});
session.emit("will-download", {}, item, mainWebContents);
assert.equal(item.savePath, path.join(desktopDir, "设备类_详情图 (1).png"));
assert.deepEqual(sent[0], {
  channel: PRODUCT_DETAIL_DOWNLOAD_CHANNEL,
  payload: { state: "started", filename: "设备类_详情图 (1).png" }
});
item.emit("done", {}, "completed");
assert.deepEqual(sent[1], {
  channel: PRODUCT_DETAIL_DOWNLOAD_CHANNEL,
  payload: { state: "completed", filename: "设备类_详情图 (1).png" }
});

const failed = createItem({
  url: "blob:http://localhost:43123/failed",
  filename: "详情图.jpg"
});
session.emit("will-download", {}, failed, mainWebContents);
failed.emit("done", {}, "interrupted");
assert.deepEqual(sent.at(-1), {
  channel: PRODUCT_DETAIL_DOWNLOAD_CHANNEL,
  payload: {
    state: "failed",
    filename: "详情图.jpg",
    code: "PRODUCT_DETAIL_DOWNLOAD_INTERRUPTED"
  }
});
assert.equal(JSON.stringify(diagnosticEvents).includes(desktopDir), false);
assert.equal(JSON.stringify(diagnosticEvents).includes("设备类_详情图"), false);

const originalSend = mainWebContents.send;
mainWebContents.send = () => {
  throw new Error("window destroyed during download update");
};
const teardownRace = createItem({
  url: "blob:http://localhost:43123/teardown-race",
  filename: "teardown-race.png"
});
assert.doesNotThrow(() => session.emit("will-download", createDownloadEvent(), teardownRace, mainWebContents));
assert.doesNotThrow(() => teardownRace.emit("done", {}, "completed"));
mainWebContents.send = originalSend;

registration.dispose();
assert.equal(session.listenerCount("will-download"), 0);
console.log("product-detail download self-check passed");
