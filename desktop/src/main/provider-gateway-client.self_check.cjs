const assert = require("node:assert/strict");

const { createProviderGatewayClient, withBodyLength } = require("./provider-gateway-client.cjs");

async function main() {
  const calls = [];
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
      if (request.url.endsWith("/session")) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ok: true,
            schema: 1,
            token: "gateway-session-token-abcdefghijklmnopqrstuvwxyz",
            expiresAt: "2026-09-12T00:00:00.000Z",
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(JSON.parse(calls[0].body).licenseCode, "signed-license");
  assert.equal(client.isReady(), true);
  assert.equal(client.isEnabled(), true);
  assert.equal(client.url("/deepseek/chat/completions"), "https://gateway.test/v1/provider-gateway/deepseek/chat/completions");
  assert.deepEqual(client.status(), {
    enabled: true,
    ready: true,
    expiresAt: "2026-09-12T00:00:00.000Z",
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
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, "Bearer gateway-session-token-abcdefghijklmnopqrstuvwxyz");
  assert.equal(calls[1].headers["content-type"], "application/json");

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

  await client.close();
  console.log("provider-gateway-client self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
