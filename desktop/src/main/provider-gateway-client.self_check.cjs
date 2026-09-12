const assert = require("node:assert/strict");

const { createProviderGatewayClient, withBodyLength } = require("./provider-gateway-client.cjs");

async function main() {
  const calls = [];
  const futureExpiry = new Date(Date.now() + 86400000).toISOString();
  const client = createProviderGatewayClient({
    config: {
      enabled: true,
      origin: "https://gateway.test",
      caPem: "test-ca"
    },
    licenseStore: { readCode: () => "signed-license" },
    appId: "com.aihuoke.desktop.test",
    channel: "test",
    version: "1.1.19",
    buildId: "build-test",
    installId: "12345678-1234-1234-1234-123456789012",
    requestImpl: async (request) => {
      calls.push(request);
      if (request.url.endsWith("/health")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ok: true,
            service: "provider-gateway",
            schema: 1,
            runtime_revision: "gateway-test-r1",
            upstream_timeout_seconds: 180
          })
        };
      }
      if (request.url.endsWith("/session")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ok: true,
            schema: 1,
            token: "gateway-session-token-abcdefghijklmnopqrstuvwxyz",
            expiresAt: futureExpiry,
            capabilities: { deepseek: true, apimart: false }
          })
        };
      }
      return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    }
  });
  const first = client.initialize();
  const second = client.initialize();
  assert.equal(first, second, "concurrent initialization must share one request");
  assert.equal((await first).ready, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.equal(JSON.parse(calls[1].body).licenseCode, "signed-license");
  assert.equal(client.isReady(), true);
  assert.equal(client.isEnabled(), true);
  assert.equal(client.url("/deepseek/chat/completions"), "https://gateway.test/v1/provider-gateway/deepseek/chat/completions");
  assert.deepEqual(client.status(), {
    enabled: true,
    ready: true,
    expiresAt: futureExpiry,
    capabilities: { deepseek: true, apimart: false },
    code: ""
  });
  assert.equal(JSON.stringify(client.status()).includes("gateway-session-token"), false);
  assert.deepEqual(client.requestHeaders(), {
    Authorization: "Bearer gateway-session-token-abcdefghijklmnopqrstuvwxyz"
  });
  assert.equal(withBodyLength({ "Content-Type": "application/json" }, "{}")['Content-Length'], "2");
  assert.equal(withBodyLength({ "content-length": "9" }, "{}")['content-length'], "9");

  const response = await client.fetch(client.url("/deepseek/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), {});
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers.Authorization, "Bearer gateway-session-token-abcdefghijklmnopqrstuvwxyz");
  assert.equal(calls[2].headers["content-type"], "application/json");

  const missing = createProviderGatewayClient({
    config: { enabled: true, origin: "https://gateway.test" },
    licenseStore: { readCode: () => { throw Object.assign(new Error("required"), { code: "license_required" }); } },
    appId: "com.aihuoke.desktop.test",
    channel: "test",
    version: "1.1.19",
    buildId: "build-test",
    installId: "12345678-1234-1234-1234-123456789012",
    requestImpl: async () => { throw new Error("must not request without a license"); }
  });
  assert.equal((await missing.initialize()).code, "GATEWAY_LICENSE_REQUIRED");
  assert.equal(missing.isReady(), false);

  const staleCalls = [];
  let rejectCapabilities = true;
  const stale = createProviderGatewayClient({
    config: { enabled: true, origin: "https://gateway.test" },
    licenseStore: { readCode: () => "signed-license" },
    appId: "com.aihuoke.desktop.test",
    channel: "test",
    version: "1.1.19",
    buildId: "build-test",
    installId: "12345678-1234-1234-1234-123456789012",
    requestImpl: async (request) => {
      staleCalls.push(request);
      if (request.url.endsWith('/capabilities')) return rejectCapabilities
        ? {status: 401, body: JSON.stringify({error: 'session_required'})}
        : {status: 200, body: JSON.stringify({ok: true, capabilities: {volcengine_ark: true, volcengine_tts: false, volcengine_asr: true}})};
      if (request.url.endsWith('/session')) return {status: 200, body: JSON.stringify({ok: true,
        token: 'gateway-session-token-abcdefghijklmnopqrstuvwxyz', expiresAt: futureExpiry,
        capabilities: {volcengine_ark: true, volcengine_asr: false}})};
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          service: "provider-gateway",
          schema: 1,
          runtime_revision: "old-gateway-r1",
          upstream_timeout_seconds: 60
        })
      };
    }
  });
  assert.equal((await stale.initialize()).ready, true);
  assert.equal(staleCalls.length, 2, '兼容网关按能力使用，超时元数据不阻断授权');
  assert.equal(stale.status().capabilities.volcengine_asr, false);
  assert.equal((await stale.initialize({verify: true})).ready, true, '服务重启清除会话后，付费请求前通过元数据接口续期');
  assert.equal(staleCalls.filter(call => call.url.endsWith('/session')).length, 2);
  rejectCapabilities = false;
  await stale.initialize({verify: true});
  assert.equal(stale.status().capabilities.volcengine_tts, false);
  assert.equal(stale.status().capabilities.volcengine_asr, true);
  assert.equal(staleCalls.filter(call => call.url.endsWith('/session')).length, 2, '有效会话不应每次重建');
  await stale.close();

  await client.close();
  console.log("provider-gateway-client self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
