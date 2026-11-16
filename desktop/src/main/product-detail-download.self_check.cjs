const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  PRODUCT_DETAIL_DOWNLOAD_CHANNEL,
  isAllowedProductDetailUrl,
  registerProductDetailDownloads,
  readProductDetailHistory,
  sanitizeDownloadFilename
} = require("./product-detail-download.cjs");
const historyFile = path.join(require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "pd-history-")), "made-history.json");

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
  historyFile,
  now: () => new Date("2026-10-29T08:00:00.000Z"),
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
// 主页统计“做好几套详情图”：每张保存成功的图只记时间，不记文件名。
assert.deepEqual(readProductDetailHistory(historyFile), [{ at: "2026-10-29T08:00:00.000Z" }]);
assert.equal(require("node:fs").readFileSync(historyFile, "utf8").includes("详情图"), false);

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

// 2026-11-16: every product goes to Pictures\小玺产品详情图\<product>, named by the part of the file
// name before the first "_" (the detail page writes "<product>_<part>"); main-image zips are unpacked.
(async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { productFolderName, extractImageZip, EXPORT_ROOT_NAME } = require("./product-detail-download.cjs");
  assert.equal(EXPORT_ROOT_NAME, "小玺产品详情图");
  assert.equal(productFolderName("CC1_主图.png"), "CC1");
  assert.equal(productFolderName("CC1 PRO_详情图_1.jpg"), "CC1 PRO");
  assert.equal(productFolderName("高仙.zip"), "高仙");
  assert.equal(productFolderName("_x.png"), "未命名产品");
  assert.equal(productFolderName("...png"), "未命名产品");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pd-export-"));
  const exportRoot = path.join(root, "Pictures", EXPORT_ROOT_NAME);
  const exportSession = new EventEmitter();
  const exportSent = [];
  const exportWindow = { isDestroyed: () => false, webContents: { send: (_channel, payload) => exportSent.push(payload) } };
  let failFolder = false;
  const exportRegistration = registerProductDetailDownloads({
    session: exportSession, getMainWindow: () => exportWindow, getProductDetailOrigin: () => "http://localhost:43123",
    getDesktopPath: () => path.join(root, "Desktop"), getExportRoot: () => exportRoot,
    mkdirSync: (dir, options) => { if (failFolder) throw new Error("denied"); return fs.mkdirSync(dir, options); }
  });
  const emit = (filename) => {
    const download = createItem({ url: "blob:http://localhost:43123/x", filename });
    exportSession.emit("will-download", createDownloadEvent(), download, exportWindow.webContents);
    return download;
  };
  const longImage = emit("CC1_AI精修详情图.png");
  assert.equal(longImage.savePath, path.join(exportRoot, "CC1", "CC1_AI精修详情图.png"));
  assert.deepEqual(exportSent.at(-1), { state: "started", filename: "CC1_AI精修详情图.png", location: `图片\\${EXPORT_ROOT_NAME}\\CC1` });
  assert.equal(emit("BG1_详情图_1.jpg").savePath, path.join(exportRoot, "BG1", "BG1_详情图_1.jpg"), "each product has its own folder");

  // Main-image zip: images unpacked flat into the product folder (never outside it), zip removed.
  const JSZip = require("jszip");
  const zip = new JSZip();
  zip.file("主图1_block_a.png", Buffer.from("one"));
  zip.file("../../逃逸.png", Buffer.from("two"));
  const zipItem = emit("CC1_主图.zip");
  assert.equal(zipItem.savePath, path.join(exportRoot, "CC1", "CC1_主图.zip"));
  fs.writeFileSync(zipItem.savePath, await zip.generateAsync({ type: "nodebuffer" }));
  zipItem.emit("done", {}, "completed");
  for (let wait = 0; wait < 50 && exportSent.at(-1)?.state !== "completed"; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exportSent.at(-1), { state: "completed", filename: "CC1_主图.zip", location: `图片\\${EXPORT_ROOT_NAME}\\CC1`, extracted: 2 });
  assert.deepEqual(fs.readdirSync(path.join(exportRoot, "CC1")).sort(), ["主图1_block_a.png", "逃逸.png"].sort());
  assert.equal(fs.existsSync(path.join(root, "Pictures", "逃逸.png")), false, "a zip entry never escapes the product folder");
  // A second zip with the same names keeps both copies.
  fs.writeFileSync(path.join(root, "again.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  assert.deepEqual((await extractImageZip(path.join(root, "again.zip"), path.join(exportRoot, "CC1"))).sort(), ["主图1_block_a (1).png", "逃逸 (1).png"].sort());
  assert.equal(fs.existsSync(path.join(root, "again.zip")), false, "a zip whose every file came out is removed");
  // Anything that is not an image stays in the kept zip: nothing is lost.
  zip.file("说明.txt", "not an image");
  fs.writeFileSync(path.join(root, "mixed.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  fs.mkdirSync(path.join(root, "mixed-out"), { recursive: true });
  assert.equal((await extractImageZip(path.join(root, "mixed.zip"), path.join(root, "mixed-out"))).length, 2);
  assert.equal(fs.existsSync(path.join(root, "mixed.zip")), true, "a zip with other files is kept");
  // A batch zip (per-product folders inside) is saved as it is, never flattened.
  const batchItem = emit("门店批次_b123.zip");
  fs.writeFileSync(batchItem.savePath, await zip.generateAsync({ type: "nodebuffer" }));
  batchItem.emit("done", {}, "completed");
  for (let wait = 0; wait < 50 && exportSent.at(-1)?.filename !== "门店批次_b123.zip"; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exportSent.at(-1).extracted, undefined);
  assert.equal(fs.existsSync(batchItem.savePath), true);

  // The folder cannot be made: the desktop, as before.
  failFolder = true;
  assert.equal(emit("DW100_主图.png").savePath, path.join(root, "Desktop", "DW100_主图.png"));
  assert.equal(exportSent.at(-1).location, undefined);
  exportRegistration.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("product-detail download self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
