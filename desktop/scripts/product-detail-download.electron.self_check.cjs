const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

if (!process.versions.electron) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const electronPath = require("electron");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-product-download-electron-"));
  let result;
  try {
    result = spawnSync(electronPath, [__filename, "--electron-child"], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, XIAOXI_PRODUCT_DOWNLOAD_TEST_ROOT: root },
      timeout: 30_000,
      killSignal: "SIGKILL",
      windowsHide: true
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
  assert.match(result.stdout, /product-detail Electron download self-check passed/);
  process.stdout.write(result.stdout);
  process.exit(0);
}

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { registerProductDetailDownloads } = require("../src/main/product-detail-download.cjs");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const rootFromParent = process.env.XIAOXI_PRODUCT_DOWNLOAD_TEST_ROOT || "";
assert.ok(rootFromParent, "parent process must provide an isolated test root");
const root = path.resolve(rootFromParent);
const profileDir = path.join(root, "profile");
const downloadDir = path.join(root, "desktop");
fs.mkdirSync(downloadDir, { recursive: true });
app.setPath("userData", profileDir);

let server = null;
let window = null;
let registration = null;

async function closeServer() {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

app.whenReady().then(async () => {
  const requests = [];
  const updates = [];
  const diagnosticEvents = [];
  server = http.createServer((request, response) => {
    if (request.url === "/child") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "probe_session=ok; Path=/; HttpOnly; Secure; SameSite=None; Partitioned"
      });
      response.end(`<!doctype html><meta charset="utf-8">
        <img id="preview" src="/file.png?kind=preview">
        <button id="download">download</button>
        <button id="blocked">blocked</button>
        <script>
          async function download(filename, kind) {
            const response = await fetch("/file.png?kind=" + kind, { credentials: "include" });
            if (!response.ok) throw new Error("download fetch failed");
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
          document.getElementById("download").addEventListener("click", () => {
            download("partitioned.png", "download");
          });
          document.getElementById("blocked").addEventListener("click", () => {
            download("blocked.exe", "blocked");
          });
        </script>`);
      return;
    }
    if (request.url.startsWith("/file.png")) {
      const hasCookie = /(?:^|;\\s*)probe_session=ok(?:;|$)/.test(request.headers.cookie || "");
      requests.push({ url: request.url, hasCookie });
      if (!hasCookie) {
        response.writeHead(401, { "Content-Type": "text/plain" });
        response.end("unauthorized");
        return;
      }
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      response.end(png);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const parentPath = path.join(root, "parent.html");
  fs.writeFileSync(parentPath, `<!doctype html><iframe src="${origin}/child"
    sandbox="allow-scripts allow-same-origin allow-downloads"></iframe>`);
  window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false }
  });
  registration = registerProductDetailDownloads({
    session: window.webContents.session,
    getMainWindow: () => window,
    getProductDetailOrigin: () => origin,
    getDesktopPath: () => downloadDir,
    diagnostics: {
      event: (component, event, payload) => diagnosticEvents.push({ component, event, payload })
    }
  });
  window.webContents.send = (channel, payload) => updates.push({ channel, payload });
  await window.loadFile(parentPath);
  let frame;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    frame = window.webContents.mainFrame.frames.find((candidate) => candidate.url === `${origin}/child`);
    if (frame && requests.some((request) => request.url.includes("kind=preview"))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(frame, "partitioned child frame must load");
  await frame.executeJavaScript("document.getElementById('download').click()", true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (updates.some((update) => update.payload?.state === "completed")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const savedPath = path.join(downloadDir, "partitioned.png");
  assert.equal(requests.find((request) => request.url.includes("kind=preview"))?.hasCookie, true);
  assert.equal(requests.find((request) => request.url.includes("kind=download"))?.hasCookie, true);
  assert.equal(fs.existsSync(savedPath), true, "Electron host must save the product image");
  assert.deepEqual(fs.readFileSync(savedPath), png);
  assert.equal(updates.some((update) => update.payload?.state === "completed"), true);

  await frame.executeJavaScript("document.getElementById('blocked').click()", true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(path.join(downloadDir, "blocked.exe")), false);
  assert.equal(diagnosticEvents.some((entry) => entry.event === "blocked"), true);

  registration.dispose();
  registration = null;
  window.destroy();
  window = null;
  await closeServer();
  console.log("product-detail Electron download self-check passed");
  app.quit();
}).catch(async (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  registration?.dispose();
  if (window && !window.isDestroyed()) window.destroy();
  await closeServer().catch(() => undefined);
  app.exit(1);
});
