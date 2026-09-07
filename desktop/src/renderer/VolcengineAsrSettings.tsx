import { useEffect, useState } from "react";

type Result = { ok: boolean; data?: { configured: boolean; appId?: string }; error?: string };
export function VolcengineAsrSettings({ locked }: { locked: boolean }) {
  const api = (window.xiaoxiContent as unknown as { settings: {
    volcengineAsrStatus: () => Promise<Result>;
    saveVolcengineAsrCredentials: (payload: { appId: string; accessToken: string }) => Promise<Result>;
  } })?.settings;
  const [configured, setConfigured] = useState(false);
  const [appId, setAppId] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { void api?.volcengineAsrStatus?.().then(r => {
    if (r.ok) { setConfigured(!!r.data?.configured); setAppId(r.data?.appId || ""); }
    else setNotice(r.error || "无法读取识别配置。");
  }).catch(() => setNotice("请重新启动应用后配置语音识别。")); }, []);
  return <details className="batch-music-settings" open={!configured}>
    <summary>火山引擎 · 语音识别 · {configured ? "认证信息已保存" : "填写 APP ID 与 Access Token"}</summary>
    <p className="batch-hint">从录音文件识别控制台复制以下两项，不需要 Secret Key。请同时开通“极速版”，用于字幕和声音同步；保存凭据不代表服务已开通。</p>
    <div className="batch-sound-row">
      <label>语音识别 APP ID<input aria-label="语音识别 APP ID" value={appId} maxLength={24} inputMode="numeric" autoComplete="off" disabled={locked || saving} onChange={e => setAppId(e.target.value)} /></label>
      <label>语音识别 Access Token<input aria-label="语音识别 Access Token" type="password" autoComplete="off" value={token} maxLength={256} disabled={locked || saving} onChange={e => setToken(e.target.value)} placeholder={configured ? "已保存；填写可更新" : "粘贴 Access Token"} /></label>
      <button disabled={locked || saving || !appId.trim() || !token.trim()} onClick={async () => {
        setSaving(true); setNotice("");
        try {
          const result = await api.saveVolcengineAsrCredentials({ appId, accessToken: token });
          if (!result.ok) throw new Error(result.error || "保存失败。");
          setToken(""); setConfigured(true); setNotice("语音识别认证信息已加密保存，可以验证识别服务。");
        } catch (error) { setNotice((error as Error).message); }
        finally { setSaving(false); }
      }}>{saving ? "保存中…" : "保存识别配置"}</button>
    </div>
    {notice && <p role="status" className="batch-notice">{notice}</p>}
  </details>;
}
