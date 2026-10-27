// Phone + password accounts. With the provider gateway off (pilot edition) the
// offline license flow stays in charge; the renderer reads `mode` to pick the form.
const MESSAGES = {
  GATEWAY_ACCOUNT_INVALID: "手机号或密码不对，请重新输入。",
  GATEWAY_LOGIN_THROTTLED: "密码输错次数太多，请 15 分钟后再试。",
  GATEWAY_ACCOUNT_DISABLED: "这个账号已被停用，请联系管理员。",
  GATEWAY_ACCOUNT_EXPIRED: "这个账号已到期，请联系管理员续期。",
  GATEWAY_ACCOUNT_SIGNED_IN_ELSEWHERE: "账号已在另一台电脑登录，这台电脑已下线。如需在这里使用，请重新登录。",
  GATEWAY_DEVICE_INVALID: "登录已失效，请重新登录。",
  GATEWAY_ACCOUNT_USE_PASSWORD: "这个账号已设置手机号登录，请用手机号和密码登录。",
  GATEWAY_UNAVAILABLE: "暂时连不上服务器，请检查网络后重试。",
  account_signed_in_elsewhere: "账号已在另一台电脑登录，这台电脑已下线。如需在这里使用，请重新登录。",
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
  ipcMain.handle("account:logout", async () => {
    if (accountMode()) { accountStore.clear(); gatewayClient.invalidate(); }
    else licenseStore.logout();
    await changed("logged_out");
    return status();
  });
  return { status };
}

module.exports = { registerAccountAuthIpc, ACCOUNT_MESSAGES: MESSAGES };
