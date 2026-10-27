const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountStore } = require("./account-store.cjs");
const { createProviderGatewayClient } = require("./provider-gateway-client.cjs");

// Reversible stand-in for Windows safeStorage.
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`enc:${text}`), decryptString: (buffer) => String(buffer).replace(/^enc:/u, "") };
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-account-"));
  try {
    let clock = Date.parse("2026-10-27T08:00:00Z"), changes = 0;
    const store = createAccountStore({ rootDir: root, safeStorage, now: () => clock, onChange: () => { changes += 1; } });
    assert.equal(store.status().authorized, false);
    assert.equal(store.status().code, "account_login_required");

    // 1. A session remembers the device token and the profile; the password is never stored.
    store.remember({ deviceToken: "d".repeat(64), account: { id: "lic-1", phone: "13800138000", displayName: "张总", setupRequired: false, mustChangePassword: true } });
    const raw = fs.readFileSync(path.join(root, "account", "device.bin"), "utf8");
    assert.ok(!/password["']?\s*:/u.test(raw.replace(/mustChangePassword/gu, "")), "no password is written");
    assert.deepEqual([store.status().authorized, store.status().licenseId, store.status().mustChangePassword], [true, "lic-1", true]);
    assert.deepEqual(store.credentials(), { deviceToken: "d".repeat(64) });
    assert.ok(changes >= 1, "the renderer is told about the change");

    // 2. Offline use lasts 7 days after the last verification.
    clock += 7 * DAY - 1000;
    assert.equal(store.status().authorized, true);
    clock += 2000;
    assert.deepEqual([store.status().authorized, store.status().code], [false, "account_offline_too_long"]);
    store.remember({ account: { id: "lic-1", phone: "13800138000", setupRequired: false, mustChangePassword: false } });
    assert.equal(store.status().authorized, true, "a fresh verification keeps the device token");

    // 3. Signed in elsewhere: the token is dropped, the phone stays for the login form.
    store.reject("account_signed_in_elsewhere");
    assert.deepEqual([store.status().authorized, store.status().code, store.status().phone], [false, "account_signed_in_elsewhere", "13800138000"]);
    assert.equal(store.credentials(), null);
    store.reject("network_glitch");
    assert.equal(store.status().code, "account_signed_in_elsewhere", "unknown reasons never touch the record");

    // 4. Logging out keeps nothing but the phone.
    store.remember({ deviceToken: "e".repeat(64), account: { id: "lic-1", phone: "13800138000" } });
    store.clear();
    assert.deepEqual([store.status().authorized, store.status().phone, store.credentials()], [false, "13800138000", null]);

    // 5. The gateway client prefers the device token, stores the token a password login returns,
    //    and drops it when the server says another computer signed in.
    const sessions = [];
    let reply = { status: 200, body: { ok: true, token: "t".repeat(43), expiresAt: new Date(Date.now() + DAY).toISOString(), capabilities: {},
      deviceToken: "f".repeat(64), account: { id: "acct_1", phone: "13900139000", setupRequired: false, mustChangePassword: false } } };
    const client = createProviderGatewayClient({
      config: { enabled: true, origin: "https://gateway.test" }, accountStore: store, licenseStore: { readCode: () => "legacy-license-code" },
      appId: "com.aihuoke.desktop.test", channel: "test", version: "1.2.15", installId: "12345678-1234-1234-1234-123456789012",
      requestImpl: async (request) => {
        if (request.url.endsWith("/health")) return { status: 200, headers: {}, body: JSON.stringify({ ok: true, service: "provider-gateway", schema: 1, runtime_revision: "r1", upstream_timeout_seconds: 180 }) };
        sessions.push(JSON.parse(request.body));
        return { status: reply.status, headers: { "content-type": "application/json" }, body: JSON.stringify(reply.body) };
      }
    });
    await client.initialize({ force: true });
    assert.equal(sessions.at(-1).licenseCode, "legacy-license-code", "no device token yet: the license signs in once");
    assert.equal(store.credentials().deviceToken, "f".repeat(64));
    await client.initialize({ force: true });
    assert.deepEqual([sessions.at(-1).deviceToken, sessions.at(-1).licenseCode], ["f".repeat(64), undefined], "the device token takes over");
    const login = await client.login({ phone: "13900139000", password: "start2026" });
    assert.equal(login.ready, true);
    assert.deepEqual([sessions.at(-1).phone, sessions.at(-1).password], ["13900139000", "start2026"]);
    reply = { status: 401, body: { error: "account_signed_in_elsewhere" } };
    const kicked = await client.initialize({ force: true });
    assert.deepEqual([kicked.ready, kicked.code], [false, "GATEWAY_ACCOUNT_SIGNED_IN_ELSEWHERE"]);
    assert.equal(store.credentials(), null, "the other computer's sign-in clears this one");
    assert.equal(store.status().code, "account_signed_in_elsewhere");
    console.log("account store self-check passed: device token only, 7-day offline grace, signed out elsewhere, logout, client credential order");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
