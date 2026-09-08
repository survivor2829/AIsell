import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { CustomerPanel } from "./CustomerPanel";
import { ROLE_CATALOG, characterAsset, type AgentRoleKey, type RolePreference } from "./role-appearance";

export function RoleAppearancePanel({ role, value, onPreview, onSave, onClose }: {
  role: AgentRoleKey; value: RolePreference; onPreview: (value: RolePreference) => void;
  onSave: (value: RolePreference) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const definition = ROLE_CATALOG[role];
  const update = (next: RolePreference) => {
    setDraft(next); setError("");
    onPreview({ ...next, name: next.name.trim() || value.name });
  };
  const save = async () => {
    setBusy(true); setError("");
    try { await onSave(draft); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，请重试"); }
    finally { setBusy(false); }
  };
  return <CustomerPanel title="形象与名字" description={`为你的${definition.responsibility}伙伴挑选喜欢的样子。`} onClose={onClose}
    footer={<><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="primary-button" onClick={() => void save()} disabled={busy || !draft.name.trim()}>{busy ? "正在保存…" : "保存设置"}</button></>}>
    <label className="role-name-field" htmlFor="role-custom-name">怎么称呼这位伙伴？</label>
    <div className="role-name-input"><input id="role-custom-name" value={draft.name} autoComplete="off" disabled={busy}
      onChange={(event) => update({ ...draft, name: Array.from(event.target.value.replace(/[\r\n]/g, "")).slice(0, 20).join("") })} />
      <span>{Array.from(draft.name).length}/20</span></div>
    <p className="customer-field-hint">名字会同步显示在侧栏和工作台，工作职责保持不变。</p>
    <fieldset className="role-appearance-field"><legend>选择形象</legend><div className="role-appearance-options">
      {definition.appearances.map((appearance) => <label key={appearance.id} className={`role-appearance-option ${draft.appearanceId === appearance.id ? "is-selected" : ""}`}>
        <input type="radio" name={`appearance-${role}`} value={appearance.id} checked={draft.appearanceId === appearance.id} disabled={busy}
          onChange={() => update({ ...draft, appearanceId: appearance.id })} />
        <img src={characterAsset(`${appearance.portraitKey}-idle.png`)} alt={`${appearance.label}形象`} style={{ objectPosition: appearance.position }} />
        <span>{appearance.id === "original" ? "原版形象" : appearance.label}{draft.appearanceId === appearance.id && <Check size={15} aria-hidden="true" />}</span>
      </label>)}
    </div></fieldset>
    <p className="customer-field-hint">切换形象时，页面配色和背景元素也会一起变化。保存后，下次打开仍会保留。</p>
    <button type="button" className="customer-text-button" disabled={busy} onClick={() => update({ name: definition.name, appearanceId: "original" })}><RotateCcw size={15} />恢复默认名字与形象</button>
    {error && <p className="customer-error" role="alert">{error}</p>}
  </CustomerPanel>;
}
