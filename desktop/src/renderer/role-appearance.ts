import { useEffect, useState, type CSSProperties } from "react";
import catalog from "../shared/role-appearance.json";

export type WorkspaceRoleKey = "agent" | "production" | "operations";
export type AgentRoleKey = keyof typeof catalog;
export const WORKSPACE_ROLE_ORDER: readonly WorkspaceRoleKey[] = ["production", "agent", "operations"];
export const AGENT_ROLE_ORDER: readonly AgentRoleKey[] = [...WORKSPACE_ROLE_ORDER, "materials", "tutorials"];
export type RolePreference = { name: string; appearanceId: string };
export type RolePreferences = Record<AgentRoleKey, RolePreference>;
export type RoleAppearance = typeof catalog.agent.appearances[number] & { portraitFile?: string };
export const ROLE_CATALOG = catalog;
export const AGENT_ROLE_IDENTITIES = Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, { name: value.name, responsibility: value.responsibility }])) as Record<AgentRoleKey, { name: string; responsibility: string }>;
export const DEFAULT_ROLE_PREFERENCES = Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, { name: value.name, appearanceId: "original" }])) as RolePreferences;
type PreferenceResult = { ok: boolean; data?: RolePreferences; error?: string };
declare global {
  interface Window {
    xiaoxiRolePreferences?: {
      status(): Promise<PreferenceResult>;
      save(payload: RolePreference & { role: AgentRoleKey }): Promise<PreferenceResult>;
      onUpdate(callback: (value: PreferenceResult) => void): () => void;
    };
  }
}

export function characterAsset(file: string) {
  return new URL(`./agent-characters/${file}`, document.baseURI).toString();
}
export function portraitAsset(appearance: RoleAppearance) {
  return characterAsset(appearance.portraitFile || `${appearance.portraitKey}-idle.png`);
}
export function appearanceFor(role: AgentRoleKey, id: string): RoleAppearance {
  return ROLE_CATALOG[role].appearances.find((item) => item.id === id) || ROLE_CATALOG[role].appearances[0];
}
export function appearanceStyle(appearance: RoleAppearance, keepBrand = false): CSSProperties {
  return {
    "--workspace-role-surface": appearance.surface,
    ...(!keepBrand && {
      "--brand-red": appearance.accent,
      "--brand-red-bright": appearance.accent,
      "--brand-red-dark": appearance.strong,
      "--brand-soft": appearance.soft,
      "--brand-ring": `color-mix(in srgb, ${appearance.accent} 22%, transparent)`,
    }),
    "--agent-accent": appearance.accent,
    "--agent-accent-strong": appearance.strong,
    "--agent-surface": appearance.surface,
    "--agent-portrait-position": appearance.position,
    "--role-pattern": appearance.pattern ? `url("${characterAsset(appearance.pattern)}")` : "none"
  } as CSSProperties;
}

export function useRolePreferences() {
  const [preferences, setPreferences] = useState<RolePreferences>(DEFAULT_ROLE_PREFERENCES);
  const [error, setError] = useState("");
  useEffect(() => {
    const api = window.xiaoxiRolePreferences;
    if (!api) return;
    let disposed = false;
    let updated = false;
    const receive = (result: PreferenceResult) => {
      if (disposed) return;
      if (result.ok && result.data) {
        setPreferences({ ...DEFAULT_ROLE_PREFERENCES, ...Object.fromEntries(Object.entries(result.data).filter(([key]) => key in ROLE_CATALOG).map(([key, value]) => [key, {
          ...value,
          name: ROLE_CATALOG[key as AgentRoleKey].legacyNames.includes(value.name) ? ROLE_CATALOG[key as AgentRoleKey].name : value.name
        }])) } as RolePreferences);
        setError("");
      }
      else setError(result.error || "暂时无法读取角色设置");
    };
    const unsubscribe = api.onUpdate((result) => { updated = true; receive(result); });
    void api.status().then((result) => { if (!updated) receive(result); }).catch(() => { if (!disposed) setError("暂时无法读取角色设置"); });
    return () => { disposed = true; unsubscribe(); };
  }, []);
  const save = async (role: AgentRoleKey, value: RolePreference) => {
    const api = window.xiaoxiRolePreferences;
    if (!api) throw new Error("当前版本未连接角色设置服务");
    const result = await api.save({ role, ...value });
    if (!result.ok || !result.data) throw new Error(result.error || "角色设置未保存，请重试");
    setPreferences({ ...DEFAULT_ROLE_PREFERENCES, ...result.data });
    setError("");
  };
  return { preferences, save, error };
}
