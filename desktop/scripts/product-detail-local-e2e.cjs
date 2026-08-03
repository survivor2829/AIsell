const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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


def allowed_url(value, origin, host_url):
    parts = urlsplit(value)
    if parts.scheme == "file":
        return value == host_url
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
    failed_responses = []
    validated_execute_requests = []
    route_violations = []
    result = {
        "ok": False,
        "phase": phase,
        "requests": requests,
        "blocked_requests": blocked,
        "console_errors": console_errors,
        "page_errors": page_errors,
        "dialogs": dialogs,
        "failed_responses": failed_responses,
    }

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                accept_downloads=True,
                viewport=config.get("viewport", {"width": 1440, "height": 1000}),
            )

            def handle_route(route):
                request_url = route.request.url
                request_path = urlsplit(request_url).path
                request_is_allowed = allowed_url(
                    request_url, config["origin"], config["host_url"]
                )
                if (
                    phase == "ai_confirmation"
                    and request_is_allowed
                    and request_path == "/api/ai-refine-v2/execute"
                ):
                    try:
                        execute_payload = json.loads(route.request.post_data or "{}")
                    except (TypeError, ValueError):
                        execute_payload = {}
                    confirmation_token = execute_payload.get("confirmation_token")
                    if route.request.method != "POST":
                        route_violations.append("AI execute request was not POST")
                        route.abort()
                        return
                    if not isinstance(confirmation_token, str) or not confirmation_token.strip():
                        route_violations.append(
                            "AI execute request omitted confirmation_token"
                        )
                        route.abort()
                        return
                    validated_execute_requests.append({
                        "method": route.request.method,
                        "confirmation_token_present": True,
                    })
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "ok": True,
                            "task_id": "LOCAL_E2E_INTERCEPTED",
                            "mode": "real",
                        }),
                    )
                    return
                if (
                    phase == "ai_confirmation"
                    and request_is_allowed
                    and request_path
                    == "/api/ai-refine-v2/status/LOCAL_E2E_INTERCEPTED"
                ):
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({
                            "status": "failed",
                            "task_id": "LOCAL_E2E_INTERCEPTED",
                            "progress_pct": 100,
                            "progress_msg": "LOCAL_E2E_INTERCEPTED",
                            "error": "LOCAL_E2E_INTERCEPTED",
                        }),
                    )
                    return
                if request_is_allowed:
                    route.continue_()
                    return
                blocked.append(clean_url(request_url))
                route.abort()

            context.route("**/*", handle_route)
            page = context.new_page()
            page.set_default_timeout(30_000)
            page.on("request", lambda request: requests.append(clean_url(request.url)))

            def handle_response(response):
                if response.status < 400:
                    return
                failed_responses.append(
                    {
                        "status": response.status,
                        "url": clean_url(response.url),
                        "resource_type": response.request.resource_type,
                    }
                )
            page.on("response", handle_response)
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
                config["host_url"],
                wait_until="domcontentloaded",
                timeout=120_000,
            )
            if response is not None and response.status >= 400:
                raise AssertionError(f"embed host navigation failed: {response.status}")
            page.wait_for_selector("#product-detail-frame", state="attached")
            workspace = page.frame_locator("#product-detail-frame")
            workspace.locator("#btn_generate").wait_for(
                state="visible", timeout=60_000
            )
            embedded_frame = page.frame(name="product-detail-frame")
            if embedded_frame is None:
                raise AssertionError("product-detail iframe was not created")
            result["frame_url"] = clean_url(embedded_frame.url)
            host_fit = page.evaluate(
                """() => {
                  const host = document.querySelector('.product-detail-workspace');
                  const frame = document.getElementById('product-detail-frame');
                  const hostRect = host.getBoundingClientRect();
                  const frameRect = frame.getBoundingClientRect();
                  return {
                    hostHeight: hostRect.height,
                    hostClientHeight: host.clientHeight,
                    hostWidth: hostRect.width,
                    hostClientWidth: host.clientWidth,
                    frameHeight: frameRect.height,
                    topDelta: Math.abs(frameRect.top - hostRect.top),
                    bottomDelta: Math.abs(frameRect.bottom - hostRect.bottom),
                    frameWidth: frameRect.width,
                    leftDelta: Math.abs(frameRect.left - hostRect.left),
                    rightDelta: Math.abs(frameRect.right - hostRect.right),
                  };
                }"""
            )
            if (
                host_fit["hostHeight"] < 360
                or abs(host_fit["frameHeight"] - host_fit["hostClientHeight"]) > 1
                or host_fit["topDelta"] > 1
                or host_fit["bottomDelta"] > 1
                or abs(host_fit["frameWidth"] - host_fit["hostClientWidth"]) > 1
                or host_fit["leftDelta"] > 1
                or host_fit["rightDelta"] > 1
            ):
                raise AssertionError(f"iframe does not fill product-detail host: {host_fit}")
            result["host_fit"] = host_fit
            if "/auth/login" in embedded_frame.url:
                raise AssertionError("desktop bootstrap fell back to the login page")
            embedded_frame.wait_for_timeout(300)

            expected_frame_width = config.get("expected_frame_width")
            if (
                expected_frame_width is not None
                and abs(host_fit["frameWidth"] - expected_frame_width) > 2
            ):
                raise AssertionError(
                    "unexpected simulated Electron iframe width: "
                    f"expected {expected_frame_width}, got {host_fit['frameWidth']}"
                )
            layout_state = embedded_frame.evaluate(
                """() => {
                  const workspace = document.querySelector('.workspace');
                  const center = document.querySelector('.panel-center');
                  return {
                    viewportWidth: window.innerWidth,
                    workspaceWidth: workspace?.getBoundingClientRect().width || 0,
                    centerWidth: center?.getBoundingClientRect().width || 0,
                    layout: ['edit', 'balance', 'preview'].find(name =>
                      workspace?.classList.contains('layout-' + name)) || '',
                  };
                }"""
            )
            expected_layout = config.get("expected_layout")
            if expected_layout and layout_state["layout"] != expected_layout:
                raise AssertionError(
                    f"expected {expected_layout} layout, got {layout_state}"
                )
            result["viewport"] = config.get("viewport")
            result["layout_state"] = layout_state
            if phase == "produce":
                workspace.locator("#upload_product input[type=file]").set_input_files(
                    config["fixture_path"]
                )
                workspace.locator("#upload_product .upload-preview img").wait_for(
                    state="visible", timeout=60_000
                )
                workspace.locator("#product_title_input").fill(
                    "小犀牛 X50 智能洗地机"
                )
                workspace.locator("#text_input").fill(
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
                workspace.locator("#btn_generate").click()
                workspace.locator(".module-wrapper").first.wait_for(
                    state="visible", timeout=120_000
                )
                module_count = workspace.locator(".module-wrapper").count()
                if module_count < 1:
                    raise AssertionError("generation returned no preview modules")

                embedded_frame.wait_for_function(
                    "() => Boolean(document.querySelector('#preview_container')?.dataset.previewScale)"
                )
                fit_state = embedded_frame.evaluate(
                    """() => {
                      const wrapper = document.getElementById('preview_wrapper');
                      const container = document.getElementById('preview_container');
                      const wrapperRect = wrapper.getBoundingClientRect();
                      const containerRect = container.getBoundingClientRect();
                      return {
                        scale: Number(container.dataset.previewScale || '0'),
                        wrapperLeft: wrapperRect.left,
                        wrapperRight: wrapperRect.right,
                        containerLeft: containerRect.left,
                        containerRight: containerRect.right,
                      };
                    }"""
                )
                if not (0 < fit_state["scale"] <= 1):
                    raise AssertionError(f"invalid preview scale: {fit_state}")
                if (
                    fit_state["containerLeft"] < fit_state["wrapperLeft"] - 1
                    or fit_state["containerRight"] > fit_state["wrapperRight"] + 1
                ):
                    raise AssertionError(f"preview overflows center panel: {fit_state}")
                minimum_scale = float(config.get("minimum_preview_scale", 0))
                if fit_state["scale"] < minimum_scale:
                    raise AssertionError(
                        f"preview scale is below {minimum_scale}: {fit_state}"
                    )

                ai_button = workspace.locator("#btn_ai_html_v2")
                if not ai_button.is_disabled():
                    raise AssertionError("desktop paid AI control must stay disabled")
                module_paid_state = embedded_frame.evaluate(
                    """() => Array.from(document.querySelectorAll('.module-wrapper [data-desktop-paid-disabled="true"]'))
                      .map(button => ({
                        disabled: button.disabled,
                        hidden: button.hidden,
                        hasOnclick: button.hasAttribute('onclick'),
                      }))"""
                )
                if len(module_paid_state) != module_count:
                    raise AssertionError("desktop module paid controls were not all marked")
                if any(not item["disabled"] or not item["hidden"] or item["hasOnclick"] for item in module_paid_state):
                    raise AssertionError(f"desktop module paid control stayed actionable: {module_paid_state}")
                generation_note = workspace.locator("#module_generation_note")
                if not generation_note.is_visible():
                    raise AssertionError("module generation explanation is not visible")

                first_module = workspace.locator(".module-wrapper").first
                first_module.hover()
                first_toggle = first_module.locator(".mod-toggle")
                first_toggle.click()
                hidden_bar = workspace.locator("#hidden_modules_bar")
                hidden_bar.wait_for(state="visible")
                if workspace.locator("#hidden_modules_count").text_content() != "1":
                    raise AssertionError("single hidden module was not counted")
                workspace.locator(".module-hidden-placeholder button").first.click()
                hidden_bar.wait_for(state="hidden")

                global_recovery_count = 0
                if module_count >= 2:
                    first_module.hover()
                    first_module.locator(".mod-toggle").click()
                    second_module = workspace.locator(".module-wrapper").nth(1)
                    second_module.hover()
                    second_module.locator(".mod-toggle").click()
                    embedded_frame.wait_for_function(
                        "() => document.querySelectorAll('.module-wrapper.module-hidden').length === 2"
                    )
                    hidden_bar.locator("button").click()
                    hidden_bar.wait_for(state="hidden")
                    if workspace.locator(".module-wrapper.module-hidden").count() != 0:
                        raise AssertionError("global hidden-module recovery did not restore all modules")
                    global_recovery_count = 2

                workspace.locator('[data-tab="main_img"]').click()
                workspace.locator(".main-img-large > *").first.wait_for(
                    state="visible", timeout=30_000
                )
                embedded_frame.wait_for_function(
                    "() => Boolean(document.querySelector('.main-img-viewer')?.dataset.previewScale)"
                )
                main_fit = embedded_frame.evaluate(
                    """() => {
                      const wrapper = document.getElementById('main_img_wrapper');
                      const viewer = wrapper.querySelector('.main-img-viewer');
                      const wrapperRect = wrapper.getBoundingClientRect();
                      const viewerRect = viewer.getBoundingClientRect();
                      return {
                        scale: Number(viewer.dataset.previewScale || '0'),
                        wrapperLeft: wrapperRect.left,
                        wrapperRight: wrapperRect.right,
                        viewerLeft: viewerRect.left,
                        viewerRight: viewerRect.right,
                      };
                    }"""
                )
                if not (0 < main_fit["scale"] <= 1):
                    raise AssertionError(f"invalid main-image scale: {main_fit}")
                if (
                    main_fit["viewerLeft"] < main_fit["wrapperLeft"] - 1
                    or main_fit["viewerRight"] > main_fit["wrapperRight"] + 1
                ):
                    raise AssertionError(f"main image overflows center panel: {main_fit}")
                workspace.locator('[data-tab="detail"]').click()
                download_path = Path(config["download_path"])
                download_path.parent.mkdir(parents=True, exist_ok=True)
                with page.expect_download(timeout=300_000) as download_info:
                    workspace.locator("#btn_export_png").click()
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
                        "preview_fit": fit_state,
                        "main_image_fit": main_fit,
                        "module_paid_controls_disabled": len(module_paid_state),
                        "module_generation_note_visible": generation_note.is_visible(),
                        "single_hidden_recovery": True,
                        "global_hidden_recovery_count": global_recovery_count,
                        "desktop_paid_ai_disabled": ai_button.is_disabled(),
                        "download_path": str(download_path),
                        "download_bytes": len(payload),
                        "download_name": download.suggested_filename,
                    }
                )
            elif phase == "restore":
                workspace.locator(".module-wrapper").first.wait_for(
                    state="visible", timeout=60_000
                )
                module_count = workspace.locator(".module-wrapper").count()
                if module_count < 1:
                    raise AssertionError("restart did not restore preview modules")
                if not any("/latest-preview" in value for value in requests):
                    raise AssertionError(
                        "workspace did not request the latest-preview restore endpoint"
                    )
                embedded_frame.wait_for_function(
                    "() => Boolean(document.querySelector('#preview_container')?.dataset.previewScale)"
                )
                restore_scale = embedded_frame.evaluate(
                    "() => Number(document.querySelector('#preview_container').dataset.previewScale || '0')"
                )
                if not (0 < restore_scale <= 1):
                    raise AssertionError(f"restored preview did not fit center panel: {restore_scale}")
                minimum_scale = float(config.get("minimum_preview_scale", 0))
                if restore_scale < minimum_scale:
                    raise AssertionError(
                        f"restored preview scale is below {minimum_scale}: {restore_scale}"
                    )
                result["module_count"] = module_count
                result["restore_scale"] = restore_scale
            elif phase == "ai_confirmation":
                workspace.locator("#upload_product input[type=file]").set_input_files(
                    config["fixture_path"]
                )
                workspace.locator("#upload_product .upload-preview img").wait_for(
                    state="visible", timeout=60_000
                )
                workspace.locator("#product_title_input").fill("LOCAL E2E PRODUCT")
                workspace.locator("#text_input").fill("LOCAL E2E PRODUCT DESCRIPTION")
                ai_button = workspace.locator("#btn_ai_html_v2")
                if ai_button.is_disabled():
                    raise AssertionError("desktop paid AI control must be enabled")

                embedded_frame.evaluate("generateAiHtmlV2(); generateAiHtmlV2();")
                confirmation_dialog = workspace.locator("#ai_refine_confirm_dialog")
                confirmation_dialog.wait_for(state="visible")
                if not ai_button.is_disabled():
                    raise AssertionError("AI refine button was not locked while busy")
                confirmation_dialog.locator('button[value="cancel"]').click()
                confirmation_dialog.wait_for(state="hidden")
                embedded_frame.wait_for_function(
                    "() => !document.querySelector('#btn_ai_html_v2')?.disabled"
                )
                first_estimate_count = sum(
                    "/desktop/ai-refine-v2/estimate" in value
                    for value in requests
                )
                first_execute_count = sum(
                    "/api/ai-refine-v2/execute" in value
                    for value in requests
                )
                if dialogs:
                    raise AssertionError(f"native browser dialogs were used: {dialogs}")
                if first_estimate_count != 1:
                    raise AssertionError(
                        f"cancel path issued {first_estimate_count} estimates"
                    )
                if first_execute_count != 0:
                    raise AssertionError("cancel path submitted a paid AI request")

                ai_button.click()
                confirmation_dialog.wait_for(state="visible")
                confirmation_dialog.locator('button[value="confirm"]').click()
                confirmation_dialog.wait_for(state="hidden")
                embedded_frame.wait_for_function(
                    "() => document.querySelector('#ai_img_results')?.textContent.includes('LOCAL_E2E_INTERCEPTED')",
                    timeout=30_000,
                )
                estimate_count = sum(
                    "/desktop/ai-refine-v2/estimate" in value
                    for value in requests
                )
                execute_count = sum(
                    "/api/ai-refine-v2/execute" in value
                    for value in requests
                )
                if confirmation_dialog.is_visible():
                    raise AssertionError("custom confirmation dialog stayed open")
                if estimate_count != 2:
                    raise AssertionError(
                        f"expected 2 cost estimates, got {estimate_count}"
                    )
                if execute_count != 1:
                    raise AssertionError(
                        f"confirmed path submitted {execute_count} paid AI requests"
                    )
                if route_violations:
                    raise AssertionError(
                        "invalid intercepted request: " + ", ".join(route_violations)
                    )
                if len(validated_execute_requests) != 1:
                    raise AssertionError(
                        "confirmed path did not submit one token-validated request"
                    )
                result.update(
                    {
                        "confirmation_views": 2,
                        "estimate_requests": estimate_count,
                        "execute_requests": execute_count,
                        "validated_execute_requests": len(validated_execute_requests),
                        "paid_ai_enabled": not ai_button.is_disabled(),
                    }
                )
            else:
                raise AssertionError(f"unsupported phase: {phase}")

            paid_markers = (
                "/api/ai-refine-v2/execute",
                "/api/generate-ai-images",
                "/api/generate-ai-detail",
                "/regenerate-block",
                "/ai-refine-start",
            )
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
            result["failed_responses"] = failed_responses
            if console_errors:
                raise AssertionError(
                    f"browser console errors were observed; HTTP failures={failed_responses}: "
                    + ", ".join(console_errors)
                )
            if page_errors:
                raise AssertionError(
                    "browser page errors were observed: "
                    + ", ".join(page_errors)
                )
            if paid_requests and phase != "ai_confirmation":
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
function createEmbedHost({ dataDir, bootstrapUrl, phase }) {
  const hostPath = path.join(
    dataDir,
    `product-detail-${phase}-embed-host.html`
  );
  const escapedBootstrapUrl = bootstrapUrl
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;");
  const productDetailCss = fs.readFileSync(
    path.join(desktopDir, "src", "renderer", "ProductDetailPage.css"),
    "utf8"
  ).replaceAll("</style>", "<\\/style>");
  fs.writeFileSync(
    hostPath,
    [
      "<!doctype html>",
      '<meta charset="utf-8">',
      "<style>",
      "*{box-sizing:border-box}",
      "html,body{width:100%;height:100%;margin:0;overflow:hidden}",
      ".test-app-shell{width:100vw;height:100vh;display:grid;grid-template-columns:236px minmax(0,1fr)}",
      ".test-sidebar{height:100vh}",
      ".test-workspace{height:100vh;min-width:0;padding:42px 36px 26px 0}",
      ".test-content-card{width:100%;height:calc(100vh - 68px);min-width:0}",
      ".test-page{height:100%;padding:22px 38px 34px}",
      productDetailCss,
      "</style>",
      '<div class="test-app-shell">',
      '<aside class="test-sidebar"></aside>',
      '<main class="test-workspace"><div class="test-content-card">',
      '<section class="test-page product-detail-page">',
      '<div class="product-detail-head" style="height:64px;flex:0 0 auto"></div>',
      '<div class="product-detail-state" style="height:68px;box-sizing:border-box;flex:0 0 auto"></div>',
      '<div class="product-detail-workspace">',
      `<iframe id="product-detail-frame" name="product-detail-frame" src="${escapedBootstrapUrl}" sandbox="allow-forms allow-scripts allow-same-origin allow-downloads" referrerpolicy="no-referrer"></iframe>`,
      "</div>",
      "</section>",
      "</div></main>",
      "</div>"
    ].join("\n"),
    "utf8"
  );
  return pathToFileURL(hostPath).href;
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

function startSidecar({ dataDir, bootstrapToken, controlToken, paidAiConfigured = false }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      XIAOXI_PRODUCT_DETAIL_DATA_DIR: dataDir,
      PLAYWRIGHT_BROWSERS_PATH: browserPath,
      PYTHONUTF8: "1",
      PYTHONUNBUFFERED: "1",
      DEEPSEEK_API_KEY: paidAiConfigured ? "local-e2e-deepseek-placeholder" : "",
      REFINE_API_KEY: paidAiConfigured ? "local-e2e-refine-placeholder" : "",
      GPT_IMAGE_API_KEY: "",
      REFINE_API_BASE_URL: paidAiConfigured ? "http://127.0.0.1:9/v1" : "",
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
  const child = spawn(
    pythonPath,
    [
      "-u",
      "-c",
      "import sys;exec(compile(sys.stdin.buffer.read(),'<browserDriver>','exec'))"
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
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  child.stdin.end(browserDriver, "utf8");
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
      host_url: createEmbedHost({ dataDir, bootstrapUrl: server.bootstrapUrl, phase: "produce" }),
      viewport: { width: 1440, height: 900 },
      expected_frame_width: 1090,
      expected_layout: "preview",
      minimum_preview_scale: 0.68,
      fixture_path: fixturePath,
      download_path: downloadPath,
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
      host_url: createEmbedHost({ dataDir, bootstrapUrl: server.bootstrapUrl, phase: "restore" }),
      viewport: { width: 1920, height: 1080 },
      expected_frame_width: 1570,
      expected_layout: "preview",
      minimum_preview_scale: 0.99
    });
    await stopSidecar(server);
    server = null;
    server = await startSidecar({
      dataDir,
      bootstrapToken: createToken(),
      controlToken: createToken(),
      paidAiConfigured: true
    });
    await verifyHealth(server);
    assert.equal(
      server.ready.capabilities.paid_ai_ready,
      true,
      "AI confirmation phase must expose the configured paid control"
    );
    evidence.third_ready = {
      version: server.ready.version,
      capabilities: server.ready.capabilities
    };
    evidence.phases.ai_confirmation = await runBrowserPhase({
      phase: "ai_confirmation",
      origin: server.origin,
      host_url: createEmbedHost({ dataDir, bootstrapUrl: server.bootstrapUrl, phase: "ai-confirmation" }),
      viewport: { width: 1440, height: 900 },
      expected_frame_width: 1090,
      expected_layout: "preview",
      fixture_path: fixturePath
    });
    await stopSidecar(server);
    server = null;
    const ledgerPath = path.join(
      dataDir,
      "database",
      "desktop-ai-refine-ledger.json"
    );
    assert.equal(
      fs.existsSync(ledgerPath),
      false,
      "browser interception must prevent the paid AI ledger from being created"
    );
    evidence.ai_refine_ledger_created = false;

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
