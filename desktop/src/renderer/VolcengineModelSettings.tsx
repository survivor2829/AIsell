import { useEffect, useState } from "react";

type Result = { ok: boolean; data?: { configured: boolean }; error?: string };
export function VolcengineModelSettings({ locked }: { locked: boolean }) {
  const api = (window.xiaoxiContent as unknown as { settings: {
    volcengineArkStatus: () => Promise<Result>;
    saveVolcengineArkKey: (payload: { apiKey: string }) => Promise<Result>;
  } })?.settings;
  const [configured, setConfigured] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { void api?.volcengineArkStatus?.().then(r => {
    if (r.ok) setConfigured(!!r.data?.configured);
    else setNotice(r.error || "无法读取方舟配置。");
  }).catch(() => setNotice("配置入口尚未连接，请重新启动应用。")); }, []);
  return <details className="batch-music-settings" open={!configured}>
    <summary>火山引擎 · 画面与文案 · {configured ? "密钥已保存" : "待填写方舟 API Key"}</summary>
    <p className="batch-hint">豆包负责看素材、写文案和安排镜头。请填写火山方舟 API Key；小何配音使用下方已有语音配置。密钥加密保存在当前 Windows 账户下，保存不代表接口权限已验证。</p>
    <div className="batch-sound-row"><label>火山方舟 API Key<input aria-label="火山方舟 API Key" type="password" autoComplete="off" maxLength={180} disabled={locked || saving} value={key} onChange={e => setKey(e.target.value)} placeholder={configured ? "已保存；填写可更新" : "粘贴方舟 API Key"} /></label>
      <button disabled={locked || saving || !key.trim()} onClick={async () => {
        setSaving(true); setNotice("");
        try {
          const result = await api.saveVolcengineArkKey({ apiKey: key });
          if (!result.ok) throw new Error(result.error || "保存失败。");
          setKey(""); setConfigured(true); setNotice("方舟密钥已加密保存，可以继续验证模型调用。");
        } catch (error) { setNotice((error as Error).message); }
        finally { setSaving(false); }
      }}>{saving ? "保存中…" : "保存方舟配置"}</button>
    </div>
    {notice && <p role="status" className="batch-notice">{notice}</p>}
  </details>;
}
