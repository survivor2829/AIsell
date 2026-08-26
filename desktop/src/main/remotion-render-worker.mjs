import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  makeCancelSignal,
  openBrowser,
  renderMedia,
  selectComposition
} from "@remotion/renderer";


const require = createRequire(import.meta.url);
const workerFile = fileURLToPath(import.meta.url);
const packagingRoot = path.resolve(path.dirname(workerFile), "../../remotion-packaging");
const {
  EFFECT_REGISTRY_VERSION,
  normalizeMotionManifest
} = require("../../remotion-packaging/contract.cjs");

const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[a-f0-9]{32}$/u;
const SAFE_RUNTIME_HASH = /^[a-f0-9]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".woff2", "font/woff2"],
  [".mp4", "video/mp4"]
]);
const CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  // Remotion's OffthreadVideo uses a loopback-only media proxy while rendering.
  // Keep the allow-list local; do not permit arbitrary network origins.
  "connect-src 'self' http://127.0.0.1:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

let inputBuffer = Buffer.alloc(0);
let activeRender = null;
let browser = null;
let browserExecutable = null;
let closing = false;

function reply(id, value) {
  const payload = JSON.stringify({ version: 1, id, ...value });
  if (Buffer.byteLength(payload, "utf8") <= 64 * 1024) {
    process.stdout.write(`${payload}\n`);
  }
}

function fail(id, failureClass, code) {
  const safeClass = new Set([
    "capability", "transient-local", "contract", "security", "output-quality"
  ]).has(failureClass) ? failureClass : "contract";
  reply(id, {
    ok: false,
    failureClass: safeClass,
    code: SAFE_CODE.test(code || "") ? code : "worker_failed"
  });
}

function isRemoteOrDevice(value) {
  const normalized = String(value || "").replaceAll("/", "\\");
  return normalized.startsWith("\\\\")
    || normalized.startsWith("\\?\\")
    || normalized.startsWith("\\.\\");
}

function hasReparseComponent(value) {
  let current = path.resolve(value);
  while (true) {
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || (Number(stats.mode || 0) & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function trustedPath(value, { directory, code }) {
  if (typeof value !== "string" || !path.isAbsolute(value) || isRemoteOrDevice(value)) {
    const error = new Error(code);
    error.failureClass = "security";
    error.code = code;
    throw error;
  }
  let resolved;
  try {
    resolved = fs.realpathSync.native(value);
    const stats = fs.statSync(resolved);
    if ((directory && !stats.isDirectory()) || (!directory && !stats.isFile())) {
      throw new Error("wrong type");
    }
    if (hasReparseComponent(value)) {
      const error = new Error("runtime_reparse_rejected");
      error.failureClass = "security";
      error.code = "runtime_reparse_rejected";
      throw error;
    }
  } catch (error) {
    if (error?.code === "runtime_reparse_rejected") throw error;
    const wrapped = new Error(code);
    wrapped.failureClass = "capability";
    wrapped.code = code;
    throw wrapped;
  }
  return resolved;
}

function containedPath(root, relative) {
  if (relative.includes("\\") || relative.includes("\0")) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const candidate = path.resolve(root, ...segments);
  const prefix = `${root}${path.sep}`.toLocaleLowerCase();
  if (candidate.toLocaleLowerCase() !== root.toLocaleLowerCase()
    && !candidate.toLocaleLowerCase().startsWith(prefix)) return null;
  try {
    const real = fs.realpathSync.native(candidate);
    if (real.toLocaleLowerCase() !== root.toLocaleLowerCase()
      && !real.toLocaleLowerCase().startsWith(prefix)) return null;
    if (hasReparseComponent(candidate)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function sendFile(request, response, file, mime) {
  const stats = fs.statSync(file);
  const range = String(request.headers.range || "");
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP,
    "Content-Type": mime || MIME.get(path.extname(file).toLowerCase()) || "application/octet-stream",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff"
  };
  if (!range) {
    response.writeHead(200, { ...commonHeaders, "Content-Length": stats.size });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(file).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match) {
    response.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${stats.size}` });
    response.end();
    return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stats.size) {
    response.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${stats.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...commonHeaders,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stats.size}`
  });
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(file, { start, end }).pipe(response);
}

async function serveTask(bundleRoot, sourcePath, sourceToken) {
  const server = http.createServer((request, response) => {
    if (!new Set(["GET", "HEAD"]).has(request.method || "")) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    // Remotion's staticFile("source.mp4") resolves to /public/source.mp4.
    // Accept only that exact opaque token (and the legacy root form) so the
    // source remains local and no arbitrary file can be fetched.
    if (pathname === `/${sourceToken}` || pathname === `/public/${sourceToken}`) {
      sendFile(request, response, sourcePath, "video/mp4");
      return;
    }
    const file = containedPath(bundleRoot, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!file) {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff"
      });
      response.end();
      return;
    }
    sendFile(request, response, file);
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server_start_failed");
  return { server, serveUrl: `http://127.0.0.1:${address.port}` };
}

async function ensureExplicitBrowser(executable) {
  if (browser && browserExecutable === executable) return browser;
  if (browser) {
    await browser.close({ silent: true });
    browser = null;
  }
  browserExecutable = executable;
  browser = await openBrowser("chrome", {
    browserExecutable: executable,
    // The selected local browser is full Chrome, not the standalone
    // chrome-headless-shell binary. New Chrome releases no longer accept
    // `--headless=old`, so request the mode that makes Remotion use the
    // supported `--headless=new` flag while retaining the explicit path.
    chromeMode: "chrome-for-testing",
    chromiumOptions: {
      disableWebSecurity: false,
      ignoreCertificateErrors: false,
      headless: true
    },
    logLevel: "error"
  });
  return browser;
}

function hashTree(digest, root, relative = "") {
  const directory = path.join(root, relative);
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      const error = new Error("bundle_reparse_rejected");
      error.failureClass = "security";
      error.code = "bundle_reparse_rejected";
      throw error;
    }
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      hashTree(digest, root, childRelative);
    } else if (entry.isFile()) {
      digest.update(`bundle:${childRelative}\0`);
      digest.update(fs.readFileSync(path.join(root, childRelative)));
    }
  }
}

function runtimeHash(bundleRoot) {
  const digest = crypto.createHash("sha256");
  digest.update("xiaoxi-remotion-worker-v1\n");
  digest.update(String(EFFECT_REGISTRY_VERSION));
  hashTree(digest, bundleRoot);
  for (const name of [
    "contract.cjs",
    "effect-registry.json",
    "layout-grid.json",
    "style-packs.json"
  ]) {
    digest.update(`contract:${name}\0`);
    digest.update(fs.readFileSync(path.join(packagingRoot, name)));
  }
  digest.update("worker:remotion-render-worker.mjs\0");
  digest.update(fs.readFileSync(workerFile));
  return digest.digest("hex");
}

function capabilityRequest(envelope) {
  const id = envelope.id;
  if (activeRender) {
    fail(id, "transient-local", "worker_busy");
    return;
  }
  const privateData = envelope.private;
  if (!privateData || typeof privateData !== "object" || Array.isArray(privateData)) {
    fail(id, "contract", "private_envelope_invalid");
    return;
  }
  try {
    const bundleRoot = trustedPath(privateData.bundlePath, {
      directory: true,
      code: "bundle_unavailable"
    });
    trustedPath(privateData.browserPath, {
      directory: false,
      code: "browser_unavailable"
    });
    reply(id, {
      ok: true,
      result: { runtime_hash: runtimeHash(bundleRoot) }
    });
  } catch (error) {
    fail(
      id,
      error?.failureClass || "capability",
      error?.code || "runtime_hash_unavailable"
    );
  }
}

async function renderRequest(envelope) {
  const id = envelope.id;
  if (activeRender) {
    fail(id, "transient-local", "worker_busy");
    return;
  }
  const privateData = envelope.private;
  if (!privateData || typeof privateData !== "object" || Array.isArray(privateData)) {
    fail(id, "contract", "private_envelope_invalid");
    return;
  }
  let bundleRoot;
  let executable;
  let sourcePath;
  let outputPath;
  let publicProps;
  let renderRuntimeHash;
  try {
    bundleRoot = trustedPath(privateData.bundlePath, { directory: true, code: "bundle_unavailable" });
    executable = trustedPath(privateData.browserPath, { directory: false, code: "browser_unavailable" });
    sourcePath = trustedPath(privateData.sourcePath, { directory: false, code: "source_unavailable" });
    outputPath = path.resolve(String(privateData.outputPath || ""));
    if (!path.isAbsolute(privateData.outputPath || "") || isRemoteOrDevice(privateData.outputPath)) {
      throw Object.assign(new Error("task_path_invalid"), { failureClass: "security", code: "task_path_invalid" });
    }
    if (path.dirname(sourcePath).toLocaleLowerCase() !== path.dirname(outputPath).toLocaleLowerCase()) {
      throw Object.assign(new Error("task_path_outside_staging"), { failureClass: "security", code: "task_path_outside_staging" });
    }
    if (fs.existsSync(outputPath)) {
      const outputStats = fs.lstatSync(outputPath);
      if (outputStats.isSymbolicLink() || hasReparseComponent(outputPath)) {
        throw Object.assign(new Error("output_reparse_rejected"), { failureClass: "security", code: "output_reparse_rejected" });
      }
      throw Object.assign(new Error("output_already_exists"), { failureClass: "contract", code: "output_already_exists" });
    }
    if (path.extname(outputPath).toLowerCase() !== ".mp4") {
      throw Object.assign(new Error("output_type_invalid"), { failureClass: "contract", code: "output_type_invalid" });
    }
    const expectedRuntimeHash = String(privateData.expectedRuntimeHash || "");
    if (!SAFE_RUNTIME_HASH.test(expectedRuntimeHash)) {
      throw Object.assign(new Error("runtime_hash_invalid"), {
        failureClass: "contract",
        code: "runtime_hash_invalid"
      });
    }
    renderRuntimeHash = runtimeHash(bundleRoot);
    if (renderRuntimeHash !== expectedRuntimeHash) {
      throw Object.assign(new Error("runtime_hash_mismatch"), {
        failureClass: "contract",
        code: "runtime_hash_mismatch"
      });
    }
    publicProps = normalizeMotionManifest(envelope.publicProps);
  } catch (error) {
    fail(id, error?.failureClass || "contract", error?.code || "manifest_invalid");
    return;
  }

  const cancel = makeCancelSignal();
  const run = {
    cancelled: false,
    cancel: () => {
      run.cancelled = true;
      cancel.cancel();
    },
    promise: null
  };
  activeRender = run;
  run.promise = (async () => {
    let taskServer;
    try {
      const puppeteerInstance = await ensureExplicitBrowser(executable);
      taskServer = await serveTask(bundleRoot, sourcePath, publicProps.sourceFile);
      const composition = await selectComposition({
        serveUrl: taskServer.serveUrl,
        id: "DynamicPackaging",
        inputProps: publicProps,
        puppeteerInstance,
        logLevel: "error",
        timeoutInMilliseconds: 120_000,
        offthreadVideoCacheSizeInBytes: 128 * 1024 * 1024,
        mediaCacheSizeInBytes: 64 * 1024 * 1024
      });
      await renderMedia({
        composition,
        serveUrl: taskServer.serveUrl,
        codec: "h264",
        audioCodec: null,
        muted: true,
        enforceAudioTrack: false,
        pixelFormat: "yuv420p",
        colorSpace: "bt709",
        crf: 18,
        outputLocation: outputPath,
        inputProps: publicProps,
        puppeteerInstance,
        concurrency: 2,
        overwrite: false,
        logLevel: "error",
        isProduction: true,
        timeoutInMilliseconds: 120_000,
        cancelSignal: cancel.cancelSignal,
        offthreadVideoCacheSizeInBytes: 128 * 1024 * 1024,
        mediaCacheSizeInBytes: 64 * 1024 * 1024,
        onBrowserLog: () => undefined,
        onProgress: () => undefined
      });
      if (!fs.statSync(outputPath).isFile() || fs.statSync(outputPath).size < 1) {
        fail(id, "output-quality", "worker_output_invalid");
        return;
      }
      if (runtimeHash(bundleRoot) !== renderRuntimeHash) {
        fail(id, "contract", "runtime_changed_during_render");
        return;
      }
      reply(id, {
        ok: true,
        result: {
          style_version: 1,
          runtime_hash: renderRuntimeHash
        }
      });
    } catch (error) {
      if (run.cancelled) fail(id, "transient-local", "render_cancelled");
      else fail(id, "transient-local", "remotion_render_failed");
    } finally {
      if (taskServer) {
        await new Promise((resolve) => taskServer.server.close(resolve));
      }
      activeRender = null;
    }
  })();
}

async function closeWorker(id) {
  closing = true;
  if (activeRender) {
    activeRender.cancel();
    await Promise.race([
      activeRender.promise,
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
  }
  if (browser) {
    try {
      await browser.close({ silent: true });
    } catch {
      // The parent process still has a bounded terminate/kill fallback.
    }
    browser = null;
  }
  reply(id, { ok: true, result: { closed: true } });
  process.exit(0);
}

function acceptEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1 || !SAFE_ID.test(String(value.id || ""))) {
    return;
  }
  if (closing && value.method !== "close") {
    fail(value.id, "transient-local", "worker_closing");
    return;
  }
  if (value.method === "capability") {
    capabilityRequest(value);
  } else if (value.method === "render") {
    void renderRequest(value);
  } else if (value.method === "cancel") {
    if (activeRender) activeRender.cancel();
    reply(value.id, { ok: true, result: { cancelling: Boolean(activeRender) } });
  } else if (value.method === "close") {
    void closeWorker(value.id);
  } else {
    fail(value.id, "contract", "worker_method_invalid");
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
  if (inputBuffer.length > MAX_ENVELOPE_BYTES && !inputBuffer.includes(0x0a)) {
    inputBuffer = Buffer.alloc(0);
    process.exit(2);
    return;
  }
  while (true) {
    const newline = inputBuffer.indexOf(0x0a);
    if (newline < 0) return;
    const line = inputBuffer.subarray(0, newline);
    inputBuffer = inputBuffer.subarray(newline + 1);
    if (line.length < 2 || line.length > MAX_ENVELOPE_BYTES) continue;
    try {
      acceptEnvelope(JSON.parse(line.toString("utf8")));
    } catch {
      // Invalid input is ignored without echoing any private payload.
    }
  }
});

process.stdin.resume();
