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
    "onDownloadUpdate",
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

  const downloadUpdates = [];
  const unsubscribeDownload = api.onDownloadUpdate((payload) => downloadUpdates.push(payload));
  listeners.get("product-detail:download-update")({}, { state: "completed", filename: "详情图.png" });
  assert.deepEqual(downloadUpdates, [{ state: "completed", filename: "详情图.png" }]);
  unsubscribeDownload();
  assert.equal(listeners.has("product-detail:download-update"), false);
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
  assert.match(source, /registerProductDetailDownloads/, "main must own product-detail file saving");
  assert.match(source, /app\.getPath\("desktop"\)/, "product-detail downloads must use the Windows desktop path");
  assert.match(source, /XIAOXI_PRODUCT_DETAIL_SIDECAR/, "development runtime must be configured by environment");
  assert.match(
    source,
    /getTrustedRuntimeEnvironment:\s*productDetailRuntimeEnvironment/,
    "main must inject the audited shared Chromium path into the product-detail sidecar"
  );
  assert.match(
    source,
    /content-engine[\s\S]*?browser[\s\S]*?chrome\.exe/,
    "packaged product-detail must consume the shared content-engine Chromium"
  );
  assert.match(
    source,
    /components\.resourcesPath\(\)[\s\S]*?"product-detail"[\s\S]*?"product-detail-server\.exe"/,
    "packaged runtime must resolve below the verified component resources directory"
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
  const moduleKey = app.match(/type ModuleKey = ([^;]+);/)?.[1] || "";
  const homeTargets = read("src/renderer/AgentHome.tsx").match(/export type AgentHomeTarget =([\s\S]*?);/)?.[1] || "";
  assert.match(moduleKey, /\bAgentHomeTarget\b/, "ModuleKey must include the shared navigation targets");
  assert.match(homeTargets, /\| "product-detail"/, "product-detail must have its own navigation target");
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
  assert.match(workspace, /async function downloadAiRefineResult\(/);
  assert.match(workspace, /fetch\(downloadUrl, \{ credentials: ['"]include['"] \}\)/);
  assert.match(workspace, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\)/);
  assert.doesNotMatch(
    workspace,
    /<a href="\$\{escapeHtml\(downloadUrl\)\}" download/,
    "AI result download must not re-request a protected static URL through DownloadManager"
  );
  assert.match(page, /referrerPolicy="no-referrer"/);
  assert.match(
    page,
    /const DEVELOPMENT_EDITION = import\.meta\.env\.VITE_XIAOXI_EDITION === "development"/,
    "product-detail recovery copy must distinguish development from formal builds"
  );
  assert.match(page, /title: "产品详情图组件不可用"/);
  assert.match(page, /完整安装程序重新安装/);
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
    "XIAOXI_PRODUCT_DETAIL_SIDECAR",
    "产品详情图组件不可用"
  ]) {
    assert.equal(page.includes(copy), true, `product-detail page must explain state/action: ${copy}`);
  }
  for (const forbidden of ["stderr", "runtimePath", "controlToken"]) {
    assert.equal(page.includes(forbidden), false, `product-detail page must not expose ${forbidden}`);
  }
}

function assertReleaseDownloadGate() {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(
    packageJson.scripts["check:product-detail-e2e"],
    "node scripts/product-detail-local-e2e.cjs --cleanup-on-success"
  );
  const releaseRunner = read("scripts/run-release.cjs");
  for (const [scriptName, edition] of [["release:test", "test"], ["release:delivery", "delivery"]]) {
    assert.match(
      packageJson.scripts[scriptName],
      new RegExp(`run-release\\.cjs ${edition}`),
      `${scriptName} must exercise the production workspace download button`
    );
  }
  assert.match(releaseRunner, /product-detail-local-e2e\.cjs/);
  assert.match(releaseRunner, /--cleanup-on-success/);
  assert.match(
    packageJson.scripts["release:installer"],
    /npm run check:product-detail-e2e/,
    "release:installer must exercise the production workspace download button"
  );
  const e2e = read("scripts/product-detail-local-e2e.cjs");
  assert.match(e2e, /\[data-ai-refine-download\]/);
  assert.match(e2e, /suggested_filename\)\.suffix\.lower\(\) != "\.png"/);
}

function assertPackagedLifecycleGate() {
  const portableCheck = read("scripts/portable-release.self_check.cjs");
  const releaseRuntime = read("scripts/product-detail-release-runtime.cjs");
  const main = read("src/main/main.cjs");
  const smoke = read("src/main/product-detail-release-smoke.cjs");
  assert.match(
    portableCheck,
    /runPackagedProductDetailReleaseGate\(\{[\s\S]*?electronExecutable: executable,[\s\S]*?dataDir: path\.join\(tempDir, "product-detail-gate"\)/,
    "every portable release must exercise the packaged product-detail lifecycle"
  );
  assert.match(releaseRuntime, /delete environment\.ELECTRON_RUN_AS_NODE/);
  assert.match(releaseRuntime, /XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE = "1"/);
  assert.match(releaseRuntime, /XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE_DATA_DIR = dataDir/);
  assert.match(releaseRuntime, /product-detail-release-smoke\.json/);
  assert.match(releaseRuntime, /function runPackagedProductDetailReleaseGate/);
  assert.match(main, /const productDetailReleaseSmokeMode = app\.isPackaged/);
  assert.match(main, /productDetailReleaseSmokeMode[\s\S]*?app\.setPath\("userData", productDetailReleaseSmokeDataDir\)/);
  assert.match(main, /function productDetailWebPreferences\(\)/);
  assert.match(main, /runProductDetailReleaseSmoke/);
  assert.match(main, /if \(productDetailReleaseSmokeMode\) \{\s*completeProductDetailReleaseSmoke\(\);\s*return;/);
  assert.match(main, /getProviderEnvironment: productDetailReleaseSmokeMode\s*\? \(\) => \(\{\}\)/);
  assert.match(smoke, /window\.xiaoxiProductDetail/);
  assert.match(smoke, /requestProductDetailSmokeHealth/);
  assert.match(smoke, /show: false/);
  assert.match(smoke, /skipTaskbar: true/);
}

assertPreloadApiContract();
assertPreloadExposure();
assertMainLifecycleAndNavigation();
assertEmbeddedSessionContract();
assertRendererContract();
assertReleaseDownloadGate();
assertPackagedLifecycleGate();

console.log("product-detail desktop integration self-check passed");
