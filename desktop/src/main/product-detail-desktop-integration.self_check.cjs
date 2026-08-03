const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "../..");
const { createPreloadApis } = require("./preload-api.cjs");

function read(relativePath) {
  return fs.readFileSync(path.join(desktopDir, relativePath), "utf8");
}

function assertPreloadApiContract() {
  const calls = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: (channel) => {
      calls.push(channel);
      return Promise.resolve({ ok: true });
    },
    on: (channel, handler) => listeners.set(channel, handler),
    removeListener: (channel, handler) => {
      if (listeners.get(channel) === handler) listeners.delete(channel);
    }
  };

  const api = createPreloadApis(ipcRenderer).productDetail;
  assert.deepEqual(Object.keys(api).sort(), [
    "onUpdate",
    "restart",
    "start",
    "status",
    "stop"
  ]);
  api.status();
  api.start();
  api.restart();
  api.stop();
  assert.deepEqual(calls, [
    "product-detail:status",
    "product-detail:start",
    "product-detail:restart",
    "product-detail:stop"
  ]);

  const updates = [];
  const unsubscribe = api.onUpdate((payload) => updates.push(payload));
  listeners.get("product-detail:update")({}, { state: "ready" });
  assert.deepEqual(updates, [{ state: "ready" }]);
  unsubscribe();
  assert.equal(listeners.has("product-detail:update"), false);
}

function assertPreloadExposure() {
  for (const filename of ["src/main/preload.cjs", "src/main/preload.dev.cjs"]) {
    const source = read(filename);
    assert.match(
      source,
      /exposeInMainWorld\("xiaoxiProductDetail", apis\.productDetail\)/,
      `${filename} must expose the same product-detail bridge`
    );
  }
}

function assertMainLifecycleAndNavigation() {
  const source = read("src/main/main.cjs");
  assert.match(source, /createProductDetailSidecar/, "main must create the sidecar in every edition");
  assert.match(source, /registerProductDetailIpc/, "main must register product-detail IPC in every edition");
  assert.match(source, /XIAOXI_PRODUCT_DETAIL_SIDECAR/, "development runtime must be configured by environment");
  assert.match(
    source,
    /process\.resourcesPath[\s\S]*?"product-detail"[\s\S]*?"product-detail-server\.exe"/,
    "packaged runtime must resolve below process.resourcesPath"
  );
  assert.match(
    source,
    /app\.getPath\("userData"\)[\s\S]*?"product-detail"/,
    "sidecar data must live below the edition userData directory"
  );
  assert.match(source, /setWindowOpenHandler\(/, "the desktop window must block sidecar popups");
  assert.match(source, /will-frame-navigate/, "the desktop window must police iframe navigation");
  assert.match(
    source,
    /event\.isMainFrame[\s\S]*?isAllowedProductDetailFrameNavigation\(event\.url\)/,
    "Electron 32 frame navigation details must be read from the event object"
  );
  assert.match(source, /event\.preventDefault\(\)/, "untrusted navigations must be cancelled");
  assert.match(source, /nodeIntegration:\s*false/, "renderer must not receive Node integration");
  assert.match(source, /before-quit/, "sidecar cleanup must run before Electron quits");
  assert.match(source, /productDetailController\?\.dispose\(\)/, "quit cleanup must dispose the sidecar");
  assert.match(source, /quitCleanupComplete/, "quit cleanup must guard the recursive app.quit call");
}

function assertEmbeddedSessionContract() {
  const source = read("sidecars/product-detail/app/desktop_entry.py");
  const requirements = read("sidecars/product-detail/app/requirements.txt");
  assert.match(
    requirements,
    /^flask>=3\.1,<4$/m,
    "partitioned session cookies require Flask 3.1 or newer"
  );
  assert.match(source, /SESSION_COOKIE_NAME="xiaoxi_product_detail_session"/);
  assert.match(source, /SESSION_COOKIE_HTTPONLY=True/);
  assert.match(source, /SESSION_COOKIE_SAMESITE="None"/);
  assert.match(source, /SESSION_COOKIE_SECURE=True/);
  assert.match(source, /SESSION_COOKIE_PARTITIONED=True/);
  assert.doesNotMatch(
    source,
    /csrf\.exempt\(desktop_bootstrap\)/,
    "desktop bootstrap must not weaken CSRF protection"
  );
}

function assertRendererContract() {
  const app = read("src/renderer/App.tsx");
  const page = read("src/renderer/ProductDetailPage.tsx");
  const styles = read("src/renderer/ProductDetailPage.css");
  const workspace = read("sidecars/product-detail/app/templates/workspace.html");
  assert.match(app, /\| "product-detail"/, "product-detail must have its own ModuleKey");
  assert.match(
    app,
    /\{ key: "product-detail", label: "产品详情图", icon: [A-Za-z]+ \}/,
    "product-detail must be the first-class content-production entry"
  );
  assert.match(
    app,
    /active === "product-detail" && <ProductDetailPage \/>/,
    "product-detail navigation must render a real page"
  );
  const moduleAvailability = app.match(/function moduleIsAvailable\(key: ModuleKey\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(moduleAvailability, /"product-detail"/, "product-detail must not render the placeholder");

  assert.match(page, /const api = window\.xiaoxiProductDetail[\s\S]*?api\.status\(\)/, "mounting may inspect status only");
  assert.equal(
    /useEffect\([\s\S]{0,800}window\.xiaoxiProductDetail\.(?:start|restart)\(\)/.test(page),
    false,
    "mounting the page must never start or restart the sidecar"
  );
  assert.match(
    page,
    /sandbox="allow-forms allow-scripts allow-same-origin allow-downloads"/,
    "the embedded workspace must retain its least-privilege sandbox"
  );
  assert.doesNotMatch(
    page,
    /sandbox="[^"]*\b(?:allow-modals|allow-popups|allow-top-navigation|allow-popups-to-escape-sandbox)\b[^"]*"/,
    "AI confirmation must not broaden the iframe sandbox"
  );
  assert.match(
    workspace,
    /id="ai_refine_confirm_dialog"/,
    "AI refine must provide an in-workspace cost confirmation"
  );
  assert.match(workspace, /async function confirmInWorkspace\(/);
  assert.doesNotMatch(workspace, /window\.confirm\(/);
  assert.match(workspace, /let aiRefineBusy = false;/);
  assert.match(workspace, /if \(aiRefineBusy\) return;/);
  assert.match(workspace, /aiRefineButton\.disabled = true;/);
  assert.match(workspace, /finally \{/);
  assert.match(workspace, /aiRefineButton\.disabled = false;/);
  assert.match(page, /referrerPolicy="no-referrer"/);
  assert.match(
    styles,
    /\.product-detail-page\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    "product-detail page must fill the content card without creating a second scroll surface"
  );
  assert.match(
    styles,
    /\.product-detail-workspace\s*\{[^}]*position:\s*relative;[^}]*flex:\s*1;[^}]*overflow:\s*hidden;/s,
    "product-detail workspace must consume the remaining page height"
  );
  assert.match(
    styles,
    /\.product-detail-workspace iframe\s*\{[^}]*height:\s*100%;[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
    "embedded workspace must fill its bounded host"
  );
  for (const copy of [
    "运行组件未配置",
    "服务未启动",
    "正在启动",
    "启动失败",
    "服务已就绪",
    "重新启动",
    "停止服务",
    "XIAOXI_PRODUCT_DETAIL_SIDECAR"
  ]) {
    assert.equal(page.includes(copy), true, `product-detail page must explain state/action: ${copy}`);
  }
  for (const forbidden of ["stderr", "runtimePath", "controlToken"]) {
    assert.equal(page.includes(forbidden), false, `product-detail page must not expose ${forbidden}`);
  }
}

assertPreloadApiContract();
assertPreloadExposure();
assertMainLifecycleAndNavigation();
assertEmbeddedSessionContract();
assertRendererContract();

console.log("product-detail desktop integration self-check passed");
