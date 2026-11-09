// Phone + password accounts. With the provider gateway off (pilot edition) the
// offline license flow stays in charge; the renderer reads `mode` to pick the form.
const MESSAGES = {
  GATEWAY_ACCOUNT_INVALID: "手机号或密码不对，请重新输入。",
  GATEWAY_LOGIN_THROTTLED: "密码输错次数太多，请 15 分钟后再试。",
  GATEWAY_ACCOUNT_DISABLED: "这个账号已被停用，请联系管理员。",
  GATEWAY_ACCOUNT_EXPIRED: "这个账号已到期，请联系管理员续期。",
  GATEWAY_ACCOUNT_SIGNED_IN_ELSEWHERE: "这台电脑已下线：账号可能在另一台电脑登录了，或被管理员设为下线。如需在这里使用，请重新登录。",
  GATEWAY_DEVICE_INVALID: "登录已失效，请重新登录。",
  GATEWAY_ACCOUNT_USE_PASSWORD: "这个账号已设置手机号登录，请用手机号和密码登录。",
  GATEWAY_UNAVAILABLE: "暂时连不上服务器，请检查网络后重试。",
  account_signed_in_elsewhere: "这台电脑已下线：账号可能在另一台电脑登录了，或被管理员设为下线。如需在这里使用，请重新登录。",
  account_disabled: "这个账号已被停用，请联系管理员。",
  account_expired: "这个账号已到期，请联系管理员续期。",
  account_offline_too_long: "已超过 7 天没有联网验证，请联网后重新登录。",
  device_invalid: "登录已失效，请重新登录。"
};
const UPDATE_ERRORS = {
  phone_invalid: "请填写正确的 11 位手机号。",
  phone_taken: "这个手机号已经绑定了其他账号，请换一个或联系管理员。",
  password_length: "密码需要 8 到 64 位。",
  password_too_simple: "密码要同时包含字母和数字。",
  password_wrong: "当前密码不对。",
  password_unchanged: "新密码不能和原来的一样。",
  account_already_set_up: "账号已经设置过了。"
};

const ADMIN_ERRORS = {
  password_wrong: "密码不对，请重新输入。",
  login_throttled: "密码输错次数太多，请 15 分钟后再试。",
  admin_required: "这个账号没有管理权限。",
  admin_ticket_required: "需要重新验证密码",
  session_required: "需要重新验证密码",
  phone_invalid: "手机号格式不对。",
  phone_taken: "这个手机号已经有账号了。",
  password_length: "密码需要 8 到 64 位。",
  password_too_simple: "密码要同时包含字母和数字。",
  account_not_found: "这个账号不存在，请刷新。",
  device_not_found: "这台电脑已经下线了，请刷新。",
  cannot_change_self: "不能在这里修改你自己的账号。",
  admin_protected: "管理员账号不能在这里修改，请到网页后台操作。",
  expires_invalid: "到期日不正确。"
};
const adminFailure = (error) => ({ ok: false, error: ADMIN_ERRORS[error] || "操作没有完成，请稍后重试。" });
const ADMIN_ACTIONS = {
  "multi-device": (payload) => typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : null,
  status: (payload) => ["active", "disabled"].includes(payload.status) ? { status: payload.status } : null,
  "reset-password": (payload) => typeof payload.password === "string" ? { password: payload.password } : null,
  "sign-out": () => ({}),
  "device-sign-out": (payload) => Number.isSafeInteger(payload.deviceId) ? { deviceId: payload.deviceId } : null,
  expires: (payload) => payload.expiresAt === null || Number.isFinite(payload.expiresAt) ? { expiresAt: payload.expiresAt } : null
};

function registerAccountAuthIpc({ ipcMain, accountStore, licenseStore, gatewayClient, onChanged }) {
  const accountMode = () => gatewayClient?.isEnabled?.() === true;
  function status() {
    if (!accountMode()) return { mode: "license", ...licenseStore.status() };
    const current = accountStore.status();
    return { mode: "account", ...current, ...(current.authorized ? {} : { error: MESSAGES[current.code] || "" }) };
  }
  async function changed(action) {
    try { await onChanged?.({ action, status: status() }); } catch { /* The login itself already completed. */ }
  }
  ipcMain.handle("account:status", () => status());
  // 算力余额 for the top bar; null when it cannot be read (offline, license mode).
  ipcMain.handle("account:billing", async () => {
    if (!accountMode() || typeof gatewayClient?.billingBalance !== "function") return null;
    try { return await gatewayClient.billingBalance(); } catch { return null; }
  });
  ipcMain.handle("account:login", async (_event, payload) => {
    if (!accountMode()) return { ...status(), authorized: false, error: "当前版本使用授权码登录。" };
    const phone = String(payload?.phone || "").trim(), password = String(payload?.password || "");
    if (!/^1[3-9]\d{9}$/u.test(phone)) return { ...status(), authorized: false, error: "请填写正确的 11 位手机号。" };
    if (!password) return { ...status(), authorized: false, error: "请输入密码。" };
    const session = await gatewayClient.login({ phone, password });
    if (!session.ready) return { ...status(), authorized: false, error: MESSAGES[session.code] || "登录没有成功，请稍后重试。" };
    await changed("logged_in");
    return status();
  });
  ipcMain.handle("account:update", async (_event, payload) => {
    const action = payload?.action === "setup" ? "setup" : "password";
    const body = action === "setup"
      ? { phone: String(payload?.phone || "").trim(), password: String(payload?.password || "") }
      : { currentPassword: String(payload?.currentPassword || ""), newPassword: String(payload?.newPassword || "") };
    try {
      await gatewayClient.initialize();
      const result = await gatewayClient.updateAccount(action, body);
      if (!result.ok) return { ...status(), updateError: UPDATE_ERRORS[result.error] || "没有保存成功，请稍后重试。" };
    } catch {
      return { ...status(), updateError: "暂时连不上服务器，请检查网络后重试。" };
    }
    return status();
  });
  // Account management: the server decides who may; these handlers only shape the request.
  const adminGuarded = async (run) => {
    if (!accountMode()) return adminFailure("admin_required");
    try {
      const result = await run();
      return result.ok ? result : adminFailure(result.error);
    } catch { return { ok: false, error: "暂时连不上服务器，请检查网络后重试。" }; }
  };
  ipcMain.handle("account:admin-state", () => ({ unlocked: accountMode() && gatewayClient.adminUnlocked() }));
  ipcMain.handle("account:admin-unlock", (_event, payload) => adminGuarded(() => gatewayClient.adminUnlock(String(payload?.password || ""))));
  ipcMain.handle("account:admin-list", () => adminGuarded(() => gatewayClient.adminRequest("GET", "/accounts")));
  ipcMain.handle("account:admin-create", (_event, payload) => adminGuarded(() => {
    const expiresAt = Number.isFinite(payload?.expiresAt) ? payload.expiresAt : undefined;
    return gatewayClient.adminRequest("POST", "/accounts", { phone: String(payload?.phone || ""), password: String(payload?.password || ""),
      displayName: String(payload?.displayName || ""), note: String(payload?.note || ""), ...(expiresAt ? { expiresAt } : {}) });
  }));
  ipcMain.handle("account:admin-action", (_event, payload) => adminGuarded(async () => {
    const shape = Object.prototype.hasOwnProperty.call(ADMIN_ACTIONS, payload?.action) ? ADMIN_ACTIONS[payload.action] : null;
    const body = shape ? shape(payload) : null;
    if (!body || !Number.isSafeInteger(payload?.id) || payload.id <= 0) return { ok: false, error: "invalid_admin_request" };
    return gatewayClient.adminRequest("POST", `/accounts/${payload.id}/${payload.action}`, body);
  }));
  ipcMain.handle("account:logout", async () => {
    if (accountMode()) { accountStore.clear(); gatewayClient.invalidate(); }
    else licenseStore.logout();
    await changed("logged_out");
    return status();
  });
  return { status };
}

module.exports = { registerAccountAuthIpc, ACCOUNT_MESSAGES: MESSAGES };
