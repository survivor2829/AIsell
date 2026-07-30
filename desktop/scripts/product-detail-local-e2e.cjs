const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopDir, "..");
const pythonPath = path.join(
  desktopDir,
  ".build",
  "product-detail-venv",
  "Scripts",
  "python.exe"
);
const browserPath = path.join(
  desktopDir,
  ".build",
  "product-detail-playwright"
);
const applicationDir = path.join(
  desktopDir,
  "sidecars",
  "product-detail",
  "app"
);
const entryPath = path.join(applicationDir, "desktop_entry.py");
const fixturePath = path.join(
  applicationDir,
  "test_batch_input",
  "upload_ux_sample",
  "sample-product-a",
  "main.png"
);
const tempRoot = "C:\\tmp";
const startupTimeoutMs = 180_000;
const shutdownTimeoutMs = 30_000;

const browserDriver = String.raw`
import json
import os
import sys
import traceback
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from playwright.sync_api import sync_playwright


def clean_url(value):
    parts = urlsplit(value)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def allowed_url(value, origin):
    parts = urlsplit(value)
    if parts.scheme in ("data", "blob"):
        return True
    if parts.scheme not in ("http", "https"):
        return False
    target = urlsplit(origin)
    return (
        parts.scheme == target.scheme
        and (parts.hostname or "").lower() in ("127.0.0.1", "::1", "localhost")
        and parts.port == target.port
    )


def run():
    config = json.loads(os.environ["XIAOXI_PRODUCT_DETAIL_E2E_CONFIG"])
    phase = config["phase"]
    requests = []
    blocked = []
    console_errors = []
    page_errors = []
    dialogs = []
    result = {
        "ok": False,
        "phase": phase,
        "requests": requests,
        "blocked_requests": blocked,
        "console_errors": console_errors,
        "page_errors": page_errors,
        "dialogs": dialogs,
    }

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                accept_downloads=True,
                viewport={"width": 1440, "height": 1000},
            )

            def handle_route(route):
                request_url = route.request.url
                if allowed_url(request_url, config["origin"]):
                    route.continue_()
                    return
                blocked.append(clean_url(request_url))
                route.abort()

            context.route("**/*", handle_route)
            page = context.new_page()
            page.set_default_timeout(30_000)
            page.on("request", lambda request: requests.append(clean_url(request.url)))
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            def handle_dialog(dialog):
                dialogs.append(dialog.message)
                dialog.dismiss()

            page.on("dialog", handle_dialog)
            response = page.goto(
                config["bootstrap_url"],
                wait_until="domcontentloaded",
                timeout=120_000,
            )
            if response is None or response.status >= 400:
                status = "no response" if response is None else response.status
                raise AssertionError(f"bootstrap navigation failed: {status}")
            page.wait_for_selector("#btn_generate", state="visible", timeout=60_000)

            if phase == "produce":
                page.locator("#upload_product input[type=file]").set_input_files(
                    config["fixture_path"]
                )
                page.wait_for_selector(
                    "#upload_product .upload-preview img",
                    state="visible",
                    timeout=60_000,
                )
                page.locator("#product_title_input").fill(
                    "小犀牛 X50 智能洗地机"
                )
                page.locator("#text_input").fill(
                    "\n".join(
                        [
                            "品牌：小犀牛",
                            "产品名称：智能洗地机",
                            "型号：X50",
                            "工作效率：每小时 2600 平方米",
                            "清洗宽度：500 毫米",
                            "续航时间：4 小时",
                            "适用场景：商场、工厂、地下车库",
                        ]
                    )
                )
                page.locator("#btn_generate").click()
                page.wait_for_selector(
                    ".module-wrapper",
                    state="visible",
                    timeout=120_000,
                )
                module_count = page.locator(".module-wrapper").count()
                if module_count < 1:
                    raise AssertionError("generation returned no preview modules")

                download_path = Path(config["download_path"])
                download_path.parent.mkdir(parents=True, exist_ok=True)
                with page.expect_download(timeout=300_000) as download_info:
                    page.locator("#btn_export_png").click()
                download = download_info.value
                download.save_as(str(download_path))
                if download.failure():
                    raise AssertionError(f"PNG download failed: {download.failure()}")
                payload = download_path.read_bytes()
                if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise AssertionError("download does not have a PNG signature")
                if len(payload) <= 1024:
                    raise AssertionError(
                        f"downloaded PNG is unexpectedly small: {len(payload)} bytes"
                    )
                result.update(
                    {
                        "module_count": module_count,
                        "download_path": str(download_path),
                        "download_bytes": len(payload),
                        "download_name": download.suggested_filename,
                    }
                )
            elif phase == "restore":
                page.wait_for_selector(
                    ".module-wrapper",
                    state="visible",
                    timeout=60_000,
                )
                module_count = page.locator(".module-wrapper").count()
                if module_count < 1:
                    raise AssertionError("restart did not restore preview modules")
                if not any("/latest-preview" in value for value in requests):
                    raise AssertionError(
                        "workspace did not request the latest-preview restore endpoint"
                    )
                result["module_count"] = module_count
            else:
                raise AssertionError(f"unsupported phase: {phase}")

            paid_markers = ("generate-ai", "ai-refine", "regenerate-block")
            paid_requests = [
                value
                for value in requests
                if any(marker in value.lower() for marker in paid_markers)
            ]
            if blocked:
                raise AssertionError(
                    "non-loopback browser requests were attempted: "
                    + ", ".join(sorted(set(blocked)))
                )
            if paid_requests:
                raise AssertionError(
                    "paid endpoints were called: "
                    + ", ".join(sorted(set(paid_requests)))
                )

            result["paid_requests"] = paid_requests
            result["request_count"] = len(requests)
            result["requests"] = sorted(set(requests))
            result["ok"] = True
            context.close()
            browser.close()
    except Exception as error:
        result["error"] = str(error)
        result["traceback"] = traceback.format_exc()
        result["requests"] = sorted(set(requests))
        print(json.dumps(result, ensure_ascii=False))
        return 1

    print(json.dumps(result, ensure_ascii=False))
    return 0


raise SystemExit(run())
`;

function requireFile(target, label) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`${label} is missing: ${target}`);
  }
}

function requireDirectory(target, label) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`${label} is missing: ${target}`);
  }
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      exitCode: child.exitCode,
      signalCode: child.signalCode
    });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.removeListener("close", onClose);
      reject(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = (exitCode, signalCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, signalCode });
    };
    child.once("close", onClose);
  });
}

function request(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(new Error("HTTP response exceeded 1 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`HTTP ${method} request timed out`));
    });
    req.on("error", reject);
    req.end();
  });
}

function parseLastJsonLine(output, label) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Diagnostics from native libraries may precede the final JSON result.
    }
  }
  throw new Error(`${label} did not emit a JSON result`);
}

function startSidecar({ dataDir, bootstrapToken, controlToken }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      XIAOXI_PRODUCT_DETAIL_DATA_DIR: dataDir,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
      DEEPSEEK_API_KEY: "",
      REFINE_API_KEY: "",
      GPT_IMAGE_API_KEY: "",
      REFINE_API_BASE_URL: "",
      ARK_API_KEY: ""
    };
    const child = spawn(
      pythonPath,
      [
        "-u",
        entryPath,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--data-dir",
        dataDir,
        "--bootstrap-token",
        bootstrapToken,
        "--control-token",
        controlToken
      ],
      {
        cwd: applicationDir,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdoutBuffer = "";
    let stderrTail = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `sidecar startup timed out; stderr tail: ${stderrTail.slice(-4000)}`
        )
      );
    }, startupTimeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-50_000);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes("\n")) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.event !== "ready" || settled) continue;
        settled = true;
        clearTimeout(timeout);
        resolve({
          child,
          origin: `http://${message.host}:${message.port}`,
          bootstrapUrl:
            `http://${message.host}:${message.port}/desktop/bootstrap?token=` +
            encodeURIComponent(bootstrapToken),
          controlToken,
          ready: message,
          stderr: () => stderrTail
        });
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`sidecar failed to spawn: ${error.message}`));
    });
    child.once("close", (exitCode, signalCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `sidecar exited before ready (code=${exitCode}, signal=${signalCode}); ` +
          `stderr tail: ${stderrTail.slice(-4000)}`
        )
      );
    });
  });
}

async function stopSidecar(server) {
  const shutdown = await request(`${server.origin}/internal/shutdown`, {
    method: "POST",
    headers: {
      "x-xiaoxi-control-token": server.controlToken,
      "content-length": "0"
    }
  });
  assert.equal(
    shutdown.statusCode,
    202,
    `shutdown returned HTTP ${shutdown.statusCode}: ${shutdown.body}`
  );
  try {
    const exited = await waitForExit(
      server.child,
      shutdownTimeoutMs,
      "product-detail sidecar"
    );
    assert.equal(
      exited.signalCode,
      null,
      `sidecar exited via signal ${exited.signalCode}`
    );
    assert.equal(exited.exitCode, 0, `sidecar exited with ${exited.exitCode}`);
  } catch (error) {
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill();
    }
    throw error;
  }
}

async function runBrowserPhase(config) {
  const encodedDriver = Buffer.from(browserDriver, "utf8").toString("base64");
  const child = spawn(
    pythonPath,
    [
      "-u",
      "-c",
      "import base64;exec(base64.b64decode('" + encodedDriver + "'))"
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browserPath,
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
        XIAOXI_PRODUCT_DETAIL_E2E_CONFIG: JSON.stringify(config)
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-100_000);
  });
  const exited = await waitForExit(child, 420_000, `Playwright ${config.phase}`);
  const result = parseLastJsonLine(stdout, `Playwright ${config.phase}`);
  if (exited.exitCode !== 0 || !result.ok) {
    const details = JSON.stringify(result, null, 2);
    throw new Error(
      `Playwright ${config.phase} failed (code=${exited.exitCode}):\n` +
      `${details}\nstderr tail:\n${stderr.slice(-8000)}`
    );
  }
  return result;
}

async function verifyHealth(server) {
  const response = await request(`${server.origin}/internal/health`);
  assert.equal(
    response.statusCode,
    200,
    `health returned HTTP ${response.statusCode}: ${response.body}`
  );
  const health = JSON.parse(response.body);
  assert.equal(health.ok, true);
  assert.equal(health.status, "ready");
  assert.equal(health.mode, "desktop");
  assert.equal(health.capabilities.offline_workspace, true);
  assert.equal(health.capabilities.playwright, true);
}

async function main() {
  requireFile(pythonPath, "product-detail Python runtime");
  requireDirectory(browserPath, "product-detail Playwright browsers");
  requireFile(entryPath, "product-detail desktop entry");
  requireFile(fixturePath, "product-detail PNG fixture");
  fs.mkdirSync(tempRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(
    path.join(tempRoot, `xiaoxi-product-detail-local-e2e-${process.pid}-`)
  );
  const downloadPath = path.join(dataDir, "evidence", "generated-detail.png");
  const evidencePath = path.join(dataDir, "e2e-evidence.json");
  const evidence = {
    data_dir: dataDir,
    fixture_path: fixturePath,
    phases: {}
  };

  let server = null;
  try {
    server = await startSidecar({
      dataDir,
      bootstrapToken: createToken(),
      controlToken: createToken()
    });
    await verifyHealth(server);
    evidence.first_ready = {
      version: server.ready.version,
      capabilities: server.ready.capabilities
    };
    evidence.phases.produce = await runBrowserPhase({
      phase: "produce",
      origin: server.origin,
      bootstrap_url: server.bootstrapUrl,
      fixture_path: fixturePath,
      download_path: downloadPath
    });
    await stopSidecar(server);
    server = null;

    server = await startSidecar({
      dataDir,
      bootstrapToken: createToken(),
      controlToken: createToken()
    });
    await verifyHealth(server);
    evidence.second_ready = {
      version: server.ready.version,
      capabilities: server.ready.capabilities
    };
    evidence.phases.restore = await runBrowserPhase({
      phase: "restore",
      origin: server.origin,
      bootstrap_url: server.bootstrapUrl
    });
    await stopSidecar(server);
    server = null;

    evidence.ok = true;
    evidence.png = {
      path: downloadPath,
      bytes: fs.statSync(downloadPath).size,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(downloadPath))
        .digest("hex")
    };
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
    console.log(
      "product-detail local Playwright E2E passed: " +
      `${evidence.phases.produce.module_count} generated modules, ` +
      `${evidence.phases.restore.module_count} restored modules, ` +
      `${evidence.png.bytes} byte PNG`
    );
    console.log(`evidence kept at ${evidencePath}`);
  } catch (error) {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    try {
      fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
    } catch {
      // Preserve the primary diagnostic.
    }
    throw new Error(
      `${evidence.error}\nData and diagnostics kept at ${dataDir}`
    );
  } finally {
    if (server) {
      try {
        await stopSidecar(server);
      } catch (stopError) {
        if (server.child.exitCode === null && server.child.signalCode === null) {
          server.child.kill();
        }
        console.error(
          `best-effort sidecar shutdown failed: ${stopError.message}`
        );
      }
    }
  }
}

main().catch((error) => {
  console.error(`product-detail local Playwright E2E failed: ${error.message}`);
  process.exitCode = 1;
});
