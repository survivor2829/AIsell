const https = require("node:https");

const PREFIX = "/v1/provider-gateway";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const VERSION_PATTERN = /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 20_000;

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sanitizeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (/^[a-z0-9_-]{1,64}$/iu.test(key) && typeof enabled === "boolean") result[key] = enabled;
  }
  return result;
}

function validateOrigin(value) {
  try {
    const origin = new URL(String(value || "").trim());
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return "";
    return origin.origin;
  } catch {
    return "";
  }
}

function normalizeResponse(result) {
  const status = Number(result?.status);
  const body = typeof result?.body === "string" ? result.body : Buffer.from(result?.body || "").toString("utf8");
  return {
    ok: Number.isInteger(status) && status >= 200 && status < 300,
    status: Number.isInteger(status) ? status : 0,
    headers: result?.headers || {},
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    }
  };
}

function withBodyLength(headers, body) {
  const result = { ...(headers || {}) };
  if (body === null || body === undefined || Object.keys(result).some((key) => key.toLowerCase() === "content-length")) {
    return result;
  }
  let length = null;
  if (Buffer.isBuffer(body)) length = body.byteLength;
  else if (typeof body === "string") length = Buffer.byteLength(body);
  else if (ArrayBuffer.isView(body)) length = body.byteLength;
  else if (body instanceof ArrayBuffer) length = body.byteLength;
  if (length !== null) result["Content-Length"] = String(length);
  return result;
}

function defaultRequest({ url, method = "GET", headers = {}, body = null, timeoutMs = SESSION_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, agent, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createError("ABORT_ERR", "request aborted"));
      return;
    }
    const target = new URL(url);
    const requestHeaders = withBodyLength(headers, body);
    const request = https.request(target, {
      agent,
      method,
      headers: requestHeaders,
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(createError("GATEWAY_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.once("error", reject);
    });
    const abort = () => request.destroy(createError("ABORT_ERR", "request aborted"));
    signal?.addEventListener?.("abort", abort, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(createError("GATEWAY_TIMEOUT")));
    request.once("error", reject);
    request.once("close", () => signal?.removeEventListener?.("abort", abort));
    if (body !== null && body !== undefined) request.write(body);
    request.end();
  });
}

function createProviderGatewayClient(options = {}) {
  const config = options.config || {};
  const enabled = config.enabled === true;
  const origin = validateOrigin(config.origin);
  const requestImpl = options.requestImpl || defaultRequest;
  const agent = options.agent || new https.Agent({
    ca: config.caPem || undefined,
    keepAlive: true,
    maxSockets: 3
  });
  const ownAgent = !options.agent;
  let token = "";
  let expiresAt = "";
  let capabilities = {};
  let code = enabled && !origin ? "GATEWAY_ORIGIN_INVALID" : "";
  let initialization = null;
  let closed = false;

  function status() {
    return {
      enabled,
      ready: Boolean(token && !closed),
      expiresAt,
      capabilities: { ...capabilities },
      code
    };
  }

  function endpoint(pathname) {
    const suffix = String(pathname || "");
    if (!origin || !suffix.startsWith("/") || suffix.includes("://") || suffix.includes("\\") || !/^\/[A-Za-z0-9._/?=&:%-]+$/u.test(suffix)) {
      throw createError("GATEWAY_ROUTE_INVALID");
    }
    return `${origin}${PREFIX}${suffix}`;
  }

  function requestHeaders() {
    if (!token || closed) throw createError("GATEWAY_SESSION_REQUIRED", "统一 AI 服务授权会话不可用。");
    return { Authorization: `Bearer ${token}` };
  }

  async function begin() {
    if (!enabled) return status();
    if (!origin) return status();
    if (closed) return { ...status(), code: "GATEWAY_CLOSED" };
    let licenseCode;
    try {
      licenseCode = String(options.licenseStore?.readCode?.() || "").trim();
    } catch (error) {
      token = "";
      expiresAt = "";
      capabilities = {};
      code = String(error?.code || "license_required") === "license_required"
        ? "GATEWAY_LICENSE_REQUIRED"
        : "GATEWAY_LICENSE_UNAVAILABLE";
      return status();
    }
    if (!licenseCode) {
      token = "";
      expiresAt = "";
      capabilities = {};
      code = "GATEWAY_LICENSE_REQUIRED";
      return status();
    }
    const response = normalizeResponse(await requestImpl({
      url: endpoint("/session"),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseCode,
        appId: String(options.appId || ""),
        channel: String(options.channel || ""),
        version: String(options.version || ""),
        buildId: IDENTIFIER_PATTERN.test(String(options.buildId || "")) ? String(options.buildId) : "",
        installId: UUID_PATTERN.test(String(options.installId || "")) ? String(options.installId) : ""
      }),
      timeoutMs: SESSION_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      agent
    }));
    if (!response.ok) {
      token = "";
      expiresAt = "";
      capabilities = {};
      code = response.status === 401 ? "GATEWAY_LICENSE_REJECTED" : `GATEWAY_HTTP_${response.status || "UNKNOWN"}`;
      return status();
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      token = "";
      expiresAt = "";
      capabilities = {};
      code = "GATEWAY_RESPONSE_INVALID";
      return status();
    }
    if (!payload?.ok || typeof payload.token !== "string" || !TOKEN_PATTERN.test(payload.token)
      || typeof payload.expiresAt !== "string" || !Number.isFinite(Date.parse(payload.expiresAt))) {
      token = "";
      expiresAt = "";
      capabilities = {};
      code = "GATEWAY_RESPONSE_INVALID";
      return status();
    }
    token = payload.token;
    expiresAt = payload.expiresAt;
    capabilities = sanitizeCapabilities(payload.capabilities);
    code = "";
    return status();
  }

  function initialize({ force = false } = {}) {
    if (closed) return Promise.resolve(status());
    if (!force && (token || !enabled || !origin)) return Promise.resolve(status());
    if (initialization) return initialization;
    initialization = Promise.resolve().then(begin).catch(() => {
      code = "GATEWAY_UNAVAILABLE";
      return status();
    }).finally(() => {
      initialization = null;
    });
    return initialization;
  }

  async function fetchGateway(url, requestOptions = {}) {
    if (!origin || !String(url || "").startsWith(`${origin}${PREFIX}/`)) {
      throw createError("GATEWAY_ROUTE_INVALID", "统一 AI 服务地址无效。");
    }
    const headers = {};
    const suppliedHeaders = requestOptions.headers || {};
    if (typeof suppliedHeaders.forEach === "function") suppliedHeaders.forEach((value, key) => { headers[key] = value; });
    else Object.assign(headers, suppliedHeaders);
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "authorization") delete headers[key];
    }
    Object.assign(headers, requestHeaders());
    const result = await requestImpl({
      url,
      method: String(requestOptions.method || "GET").toUpperCase(),
      headers,
      body: requestOptions.body ?? null,
      timeoutMs: Number(requestOptions.timeoutMs) || SESSION_TIMEOUT_MS,
      maxBytes: Number(requestOptions.maxBytes) || MAX_RESPONSE_BYTES,
      signal: requestOptions.signal,
      agent
    });
    return normalizeResponse(result);
  }

  async function close() {
    closed = true;
    token = "";
    expiresAt = "";
    capabilities = {};
    if (ownAgent) agent.destroy();
    return status();
  }

  function invalidate() {
    token = "";
    expiresAt = "";
    capabilities = {};
    code = enabled && origin ? "GATEWAY_SESSION_REQUIRED" : code;
    return status();
  }

  return {
    close,
    fetch: fetchGateway,
    invalidate,
    initialize,
    isEnabled: () => enabled,
    isReady: () => Boolean(token && !closed),
    origin: () => origin,
    requestHeaders,
    status,
    token: () => token,
    url: endpoint
  };
}

module.exports = {
  createProviderGatewayClient,
  normalizeResponse,
  sanitizeCapabilities,
  validateOrigin,
  withBodyLength
};
