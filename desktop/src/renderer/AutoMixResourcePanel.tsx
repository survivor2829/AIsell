import {
  BadgeCheck,
  CircleAlert,
  Headphones,
  LoaderCircle,
  Music2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  Volume2,
  X
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";
import "./AutoMixResourcePanel.css";

export type AutoMixVoiceApprovalStatus = "approved" | "pending" | "retired";
export type AutoMixVoicePreviewStatus =
  | "not_ready"
  | "submitted"
  | "completed"
  | "failed"
  | "outcome_unknown";
export type AutoMixVoiceProvisioningStatus =
  | "not_created"
  | "submitted"
  | "ready"
  | "failed"
  | "outcome_unknown";

export type AutoMixVoicePersona = {
  voicePersonaId: string;
  displayName: string;
  category: string;
  catalogVersion: string;
  approvalStatus: AutoMixVoiceApprovalStatus;
  previewStatus: AutoMixVoicePreviewStatus;
  provisioningStatus: AutoMixVoiceProvisioningStatus;
};

export type AutoMixVoicePreview = {
  voicePersona: AutoMixVoicePersona;
  previewStatus: AutoMixVoicePreviewStatus;
  audioDataUrl: string | null;
  cacheHit: boolean;
};

export type MusicCatalogTrack = {
  trackId: string;
  displayName: string;
  source: string;
  licenseSummary: {
    status: string;
    commercialScope: string;
    commercialUseAllowed: boolean;
    expiresAt: string | null;
    evidencePresent: boolean;
  } | null;
  durationMs: number | null;
  bpm: number | null;
  moods: string[];
  energy: number | null;
  integratedLufs?: number | null;
  truePeakDbtp?: number | null;
  loop: { startMs: number | null; endMs: number | null } | null;
  analysisStatus: "pending" | "ready" | "failed";
  analysisErrorCode?: string | null;
};

export type ImportMusicCatalogTrackPayload = {
  displayName: string;
  source: string;
  commercialScope: string;
  commercialUseAllowed: true;
  licenseStatus: "valid";
  expiresAt: string | null;
  credentialReference: string;
  bpm: number | null;
  moods: string[];
  energy: number;
  loopStartMs: number | null;
  loopEndMs: number | null;
};

export type AutoMixResourcePanelProps = {
  open: boolean;
  onClose: () => void;
  initialSection?: "voice" | "music";
  listMusicCatalogTracks: () => Promise<{ items: MusicCatalogTrack[] }>;
  importMusicCatalogTrack: (
    payload: ImportMusicCatalogTrackPayload
  ) => Promise<MusicCatalogTrack>;
  listAutoMixVoicePersonas: () => Promise<{ items: AutoMixVoicePersona[] }>;
  designAutoMixVoicePersona: (payload: {
    voicePersonaId: string;
  }) => Promise<AutoMixVoicePersona>;
  previewAutoMixVoicePersona: (payload: {
    voicePersonaId: string;
  }) => Promise<AutoMixVoicePreview>;
  approveAutoMixVoicePersona: (payload: {
    voicePersonaId: string;
  }) => Promise<AutoMixVoicePersona>;
};

type Notice = { tone: "success" | "error" | "info"; text: string } | null;

type MusicFormState = {
  displayName: string;
  source: string;
  commercialScope: string;
  credentialReference: string;
  expiresAt: string;
  bpm: string;
  moods: string;
  energy: number;
  loopStartSeconds: string;
  loopEndSeconds: string;
};

const EMPTY_MUSIC_FORM: MusicFormState = {
  displayName: "",
  source: "",
  commercialScope: "",
  credentialReference: "",
  expiresAt: "",
  bpm: "",
  moods: "",
  energy: 0.5,
  loopStartSeconds: "",
  loopEndSeconds: ""
};

const CATEGORY_LABELS: Record<string, string> = {
  natural_life: "自然生活",
  reliable_business: "可靠商务",
  steady_narration: "沉稳叙事",
  playful_abstract: "轻松抽象"
};

const APPROVAL_LABELS: Record<AutoMixVoiceApprovalStatus, string> = {
  approved: "已批准",
  pending: "待批准",
  retired: "已停用"
};

const PROVISIONING_LABELS: Record<AutoMixVoiceProvisioningStatus, string> = {
  not_created: "声音未生成",
  submitted: "结果确认中",
  ready: "声音已就绪",
  failed: "生成失败",
  outcome_unknown: "结果待确认"
};

function errorText(error: unknown, fallback: string) {
  if (error && typeof error === "object") {
    const value = error as { error?: unknown; message?: unknown; code?: unknown };
    for (const candidate of [value.error, value.message, value.code]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const value = error as { code?: unknown };
  return typeof value.code === "string" ? value.code : "";
}

function replacePersona(items: AutoMixVoicePersona[], next: AutoMixVoicePersona) {
  const index = items.findIndex((item) => item.voicePersonaId === next.voicePersonaId);
  if (index < 0) return [next, ...items];
  return items.map((item, itemIndex) => (itemIndex === index ? next : item));
}

function resolvedProvisioningStatus(persona: AutoMixVoicePersona) {
  const status = persona.provisioningStatus;
  if (status && status in PROVISIONING_LABELS) return status;
  return persona.previewStatus === "completed" ? "ready" : "not_created";
}

function formatDuration(durationMs: number | null | undefined) {
  if (!Number.isFinite(durationMs) || Number(durationMs) <= 0) return "时长待分析";
  const totalSeconds = Math.round(Number(durationMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒` : `${seconds} 秒`;
}

function formatLoop(loop: MusicCatalogTrack["loop"]) {
  if (!loop || !Number.isFinite(loop.startMs) || !Number.isFinite(loop.endMs)) return null;
  return `循环 ${(Number(loop.startMs) / 1000).toFixed(1)}–${(Number(loop.endMs) / 1000).toFixed(1)} 秒`;
}

function inclusiveExpiryIso(value: string) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new Error("授权到期日无效");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localDate = new Date(year, month - 1, day);
  if (
    localDate.getFullYear() !== year
    || localDate.getMonth() !== month - 1
    || localDate.getDate() !== day
  ) {
    throw new Error("授权到期日无效");
  }
  const exclusiveCutoff = new Date(year, month - 1, day + 1);
  return exclusiveCutoff.toISOString();
}

function isLicenseExpired(expiresAt: string | null | undefined, now = Date.now()) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now;
}

function isMusicTrackSelectable(track: MusicCatalogTrack, now = Date.now()) {
  const license = track.licenseSummary;
  return track.analysisStatus === "ready"
    && license?.status === "valid"
    && license.commercialUseAllowed === true
    && license.evidencePresent === true
    && !isLicenseExpired(license.expiresAt, now);
}

function formatLicenseExpiry(expiresAt: string | null | undefined) {
  if (!expiresAt) return "长期有效 / 未设置";
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return "截止时间无效";
  return new Date(expiresAtMs).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function parseOptionalInteger(value: string, label: string, min: number, max: number) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/u.test(trimmed)) throw new Error(`${label}需要填写整数`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}需在 ${min}–${max} 之间`);
  }
  return parsed;
}

function parseLoopPoint(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}需填写不小于 0 的秒数`);
  const milliseconds = Math.round(parsed * 1000);
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${label}超出支持范围`);
  return milliseconds;
}

function musicPayload(form: MusicFormState): ImportMusicCatalogTrackPayload {
  const displayName = form.displayName.trim();
  const source = form.source.trim();
  const commercialScope = form.commercialScope.trim();
  const credentialReference = form.credentialReference.trim();
  if (!displayName) throw new Error("请填写曲目名称");
  if (!source) throw new Error("请填写曲目来源");
  if (!commercialScope) throw new Error("请填写商用授权范围");
  if (!credentialReference) throw new Error("请填写授权凭证编号或引用");

  const expiresAt = inclusiveExpiryIso(form.expiresAt);
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("授权到期日不能早于今天");
    }
  }

  const moods = [...new Set(
    form.moods
      .split(/[,，、\n]+/u)
      .map((item) => item.trim())
      .filter(Boolean)
  )];
  if (moods.length > 12 || moods.some((item) => item.length > 40)) {
    throw new Error("情绪标签最多 12 个，每个不超过 40 个字符");
  }

  const loopStartMs = parseLoopPoint(form.loopStartSeconds, "循环起点");
  const loopEndMs = parseLoopPoint(form.loopEndSeconds, "循环终点");
  if ((loopStartMs === null) !== (loopEndMs === null)) {
    throw new Error("循环起点和终点需要同时填写");
  }
  if (loopStartMs !== null && loopEndMs !== null && loopEndMs <= loopStartMs) {
    throw new Error("循环终点必须晚于循环起点");
  }

  return {
    displayName,
    source,
    commercialScope,
    commercialUseAllowed: true,
    licenseStatus: "valid",
    expiresAt,
    credentialReference,
    bpm: parseOptionalInteger(form.bpm, "BPM", 20, 300),
    moods,
    energy: form.energy,
    loopStartMs,
    loopEndMs
  };
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <div
      className={`auto-mix-resource-notice is-${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      {notice.tone === "success" ? <BadgeCheck size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
      <span>{notice.text}</span>
    </div>
  );
}

export function AutoMixResourcePanel({
  open,
  onClose,
  initialSection = "voice",
  listMusicCatalogTracks,
  importMusicCatalogTrack,
  listAutoMixVoicePersonas,
  designAutoMixVoicePersona,
  previewAutoMixVoicePersona,
  approveAutoMixVoicePersona
}: AutoMixResourcePanelProps) {
  const instanceId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const voiceLoadRef = useRef(0);
  const musicLoadRef = useRef(0);
  const [section, setSection] = useState<"voice" | "music">(initialSection);
  const [voiceItems, setVoiceItems] = useState<AutoMixVoicePersona[]>([]);
  const [musicItems, setMusicItems] = useState<MusicCatalogTrack[]>([]);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [musicLoading, setMusicLoading] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<Notice>(null);
  const [musicNotice, setMusicNotice] = useState<Notice>(null);
  const [designingId, setDesigningId] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AutoMixVoicePreview | null>(null);
  const [previewedIds, setPreviewedIds] = useState<Set<string>>(() => new Set());
  const [musicForm, setMusicForm] = useState<MusicFormState>(EMPTY_MUSIC_FORM);
  const [importingMusic, setImportingMusic] = useState(false);

  const approvedVoiceCount = useMemo(
    () => voiceItems.filter((item) => item.approvalStatus === "approved").length,
    [voiceItems]
  );
  const selectableMusicCount = musicItems.filter(
    (item) => isMusicTrackSelectable(item)
  ).length;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  async function loadVoices() {
    const request = ++voiceLoadRef.current;
    setVoiceLoading(true);
    setVoiceNotice(null);
    try {
      const result = await listAutoMixVoicePersonas();
      if (request !== voiceLoadRef.current) return;
      setVoiceItems(Array.isArray(result.items) ? result.items : []);
    } catch (error) {
      if (request !== voiceLoadRef.current) return;
      setVoiceNotice({ tone: "error", text: errorText(error, "声音目录读取失败，请重试") });
    } finally {
      if (request === voiceLoadRef.current) setVoiceLoading(false);
    }
  }

  async function loadMusic() {
    const request = ++musicLoadRef.current;
    setMusicLoading(true);
    setMusicNotice(null);
    try {
      const result = await listMusicCatalogTracks();
      if (request !== musicLoadRef.current) return;
      setMusicItems(Array.isArray(result.items) ? result.items : []);
    } catch (error) {
      if (request !== musicLoadRef.current) return;
      setMusicNotice({ tone: "error", text: errorText(error, "授权音乐目录读取失败，请重试") });
    } finally {
      if (request === musicLoadRef.current) setMusicLoading(false);
    }
  }

  useEffect(() => {
    if (!open) {
      voiceLoadRef.current += 1;
      musicLoadRef.current += 1;
      return;
    }
    setSection(initialSection);
    void loadVoices();
    void loadMusic();
    // API methods are bridge functions and are intentionally sampled when the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const controls = [...panelRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), audio[controls], [tabindex]:not([tabindex='-1'])"
      )].filter((item) => !item.closest("[hidden]"));
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  async function designVoice(persona: AutoMixVoicePersona) {
    setDesigningId(persona.voicePersonaId);
    setVoiceNotice({ tone: "info", text: `正在生成“${persona.displayName}”，请不要关闭页面…` });
    try {
      const designed = await designAutoMixVoicePersona({
        voicePersonaId: persona.voicePersonaId
      });
      setVoiceItems((items) => replacePersona(items, designed));
      setPreview((current) => (
        current?.voicePersona.voicePersonaId === persona.voicePersonaId ? null : current
      ));
      setPreviewedIds((current) => {
        const next = new Set(current);
        next.delete(persona.voicePersonaId);
        return next;
      });
      setVoiceNotice({
        tone: "success",
        text: `“${designed.displayName}”已生成。请先试听当前声音，再决定是否批准。`
      });
    } catch (error) {
      const code = errorCode(error);
      const outcomeUnknown = code === "auto_mix_voice_design_outcome_unknown";
      setVoiceItems((items) => items.map((item) => (
        item.voicePersonaId === persona.voicePersonaId
          ? {
            ...item,
            provisioningStatus: outcomeUnknown ? "outcome_unknown" : "failed"
          }
          : item
      )));
      setVoiceNotice(outcomeUnknown
        ? {
          tone: "error",
          text: "声音生成结果暂时无法确认。为避免重复创建，不会自动重试，也不能再次提交；请稍后刷新状态。"
        }
        : {
          tone: "error",
          text: `${errorText(error, "声音生成失败")} 检查百炼配置后可以手动重新生成。`
        });
    } finally {
      setDesigningId(null);
    }
  }

  async function previewVoice(persona: AutoMixVoicePersona) {
    setPreviewingId(persona.voicePersonaId);
    setVoiceNotice(null);
    try {
      const result = await previewAutoMixVoicePersona({ voicePersonaId: persona.voicePersonaId });
      if (!result.audioDataUrl) {
        throw new Error("试听音频尚未生成，请稍后重试");
      }
      setPreview(result);
      setPreviewedIds((current) => new Set(current).add(persona.voicePersonaId));
      setVoiceItems((items) => replacePersona(items, result.voicePersona));
      setVoiceNotice({
        tone: "success",
        text: result.cacheHit ? "试听已就绪（复用本地缓存）" : "试听已生成并开始播放"
      });
    } catch (error) {
      setVoiceNotice({ tone: "error", text: errorText(error, "声音试听失败，请重试") });
    } finally {
      setPreviewingId(null);
    }
  }

  async function approveVoice(persona: AutoMixVoicePersona) {
    setApprovingId(persona.voicePersonaId);
    setVoiceNotice(null);
    try {
      const approved = await approveAutoMixVoicePersona({ voicePersonaId: persona.voicePersonaId });
      setVoiceItems((items) => replacePersona(items, approved));
      setVoiceNotice({ tone: "success", text: `“${approved.displayName}”已加入可自动选择的声音库` });
    } catch (error) {
      setVoiceNotice({ tone: "error", text: errorText(error, "批准声音失败，请重试") });
    } finally {
      setApprovingId(null);
    }
  }

  async function importMusic() {
    let payload: ImportMusicCatalogTrackPayload;
    try {
      payload = musicPayload(musicForm);
    } catch (error) {
      setMusicNotice({ tone: "error", text: errorText(error, "请检查音乐信息") });
      return;
    }

    setImportingMusic(true);
    setMusicNotice({ tone: "info", text: "接下来将依次选择音乐文件和授权凭证" });
    try {
      const imported = await importMusicCatalogTrack(payload);
      setMusicItems((items) => {
        const withoutDuplicate = items.filter((item) => item.trackId !== imported.trackId);
        return [imported, ...withoutDuplicate];
      });
      setMusicForm(EMPTY_MUSIC_FORM);
      setMusicNotice({ tone: "success", text: `“${imported.displayName}”已导入授权曲库` });
    } catch (error) {
      if (errorCode(error) === "CONTENT_DIALOG_CANCELLED") {
        setMusicNotice({ tone: "info", text: "已取消选择，没有导入曲目" });
      } else {
        setMusicNotice({ tone: "error", text: errorText(error, "音乐导入失败，请检查授权信息") });
      }
    } finally {
      setImportingMusic(false);
    }
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!(["ArrowLeft", "ArrowRight"] as string[]).includes(event.key)) return;
    event.preventDefault();
    setSection((current) => (current === "voice" ? "music" : "voice"));
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    tabs?.forEach((tab) => {
      if (tab !== event.currentTarget) tab.focus();
    });
  }

  function updateMusicForm<Key extends keyof MusicFormState>(key: Key, value: MusicFormState[Key]) {
    setMusicForm((current) => ({ ...current, [key]: value }));
  }

  if (!open) return null;

  const titleId = `${instanceId}-title`;
  const voiceTabId = `${instanceId}-voice-tab`;
  const musicTabId = `${instanceId}-music-tab`;
  const voicePanelId = `${instanceId}-voice-panel`;
  const musicPanelId = `${instanceId}-music-panel`;

  return (
    <div
      className="auto-mix-resource-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        className="auto-mix-resource-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="auto-mix-resource-head">
          <div>
            <h2 id={titleId}>声音与授权音乐</h2>
            <p>管理生成资源，不增加主输入项。成片仍只需要素材、标题和文案框架。</p>
          </div>
          <button ref={closeButtonRef} type="button" className="auto-mix-resource-close" onClick={onClose} aria-label="关闭声音与授权音乐设置">
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="auto-mix-resource-tabs" role="tablist" aria-label="资源类型">
          <button
            id={voiceTabId}
            type="button"
            role="tab"
            aria-selected={section === "voice"}
            aria-controls={voicePanelId}
            tabIndex={section === "voice" ? 0 : -1}
            className={section === "voice" ? "is-active" : ""}
            onClick={() => setSection("voice")}
            onKeyDown={onTabKeyDown}
          >
            <Volume2 size={17} aria-hidden="true" />
            声音
            <span>{approvedVoiceCount} 个已批准</span>
          </button>
          <button
            id={musicTabId}
            type="button"
            role="tab"
            aria-selected={section === "music"}
            aria-controls={musicPanelId}
            tabIndex={section === "music" ? 0 : -1}
            className={section === "music" ? "is-active" : ""}
            onClick={() => setSection("music")}
            onKeyDown={onTabKeyDown}
          >
            <Music2 size={17} aria-hidden="true" />
            授权音乐
            <span>{selectableMusicCount} 首可用</span>
          </button>
        </div>

        <div className="auto-mix-resource-body">
          <section
            id={voicePanelId}
            role="tabpanel"
            aria-labelledby={voiceTabId}
            hidden={section !== "voice"}
            tabIndex={0}
          >
            <div className="auto-mix-resource-section-head">
              <div>
                <h3>先生成，再试听，再批准</h3>
                <p>首次生成由你明确发起；只有试听当前版本并批准后，声音才会进入自动选择库。</p>
              </div>
              <button type="button" onClick={() => void loadVoices()} disabled={voiceLoading}>
                <RefreshCw className={voiceLoading ? "is-spinning" : ""} size={15} aria-hidden="true" />
                刷新
              </button>
            </div>
            <NoticeLine notice={voiceNotice} />

            {preview?.audioDataUrl ? (
              <div className="auto-mix-resource-player">
                <div>
                  <Headphones size={18} aria-hidden="true" />
                  <span>
                    正在试听
                    <strong>{preview.voicePersona.displayName}</strong>
                  </span>
                </div>
                <audio controls autoPlay preload="metadata" src={preview.audioDataUrl} aria-label={`${preview.voicePersona.displayName}声音试听`}>
                  当前环境不支持音频试听。
                </audio>
              </div>
            ) : null}

            {voiceLoading && !voiceItems.length ? (
              <div className="auto-mix-resource-empty" role="status">
                <LoaderCircle className="is-spinning" size={20} aria-hidden="true" />
                正在读取声音目录…
              </div>
            ) : null}
            {!voiceLoading && !voiceItems.length ? (
              <div className="auto-mix-resource-empty">
                <Volume2 size={20} aria-hidden="true" />
                <strong>声音目录还没有可展示的人格</strong>
                <span>目录更新后点击刷新即可看到。</span>
              </div>
            ) : null}

            <div className="auto-mix-resource-list" aria-label="声音人格列表">
              {voiceItems.map((persona) => {
                const provisioning = resolvedProvisioningStatus(persona);
                const isDesigning = designingId === persona.voicePersonaId;
                const isPreviewing = previewingId === persona.voicePersonaId;
                const isApproving = approvingId === persona.voicePersonaId;
                const hasPreviewed = previewedIds.has(persona.voicePersonaId);
                const canDesign = (provisioning === "not_created" || provisioning === "failed")
                  && persona.approvalStatus !== "retired";
                const canPreview = provisioning === "ready"
                  && persona.approvalStatus !== "retired";
                const designOutcomeUnknown = provisioning === "outcome_unknown"
                  || provisioning === "submitted";
                const voiceBusy = isDesigning || isPreviewing || isApproving;
                let designButtonLabel = "生成声音";
                if (isDesigning) designButtonLabel = "生成中";
                else if (designOutcomeUnknown) designButtonLabel = "结果待确认";
                else if (provisioning === "failed") designButtonLabel = "重新生成";
                let approvalButtonLabel = "请先试听";
                if (persona.approvalStatus === "approved") approvalButtonLabel = "已批准";
                else if (isApproving) approvalButtonLabel = "批准中";
                else if (hasPreviewed) approvalButtonLabel = "批准使用";
                return (
                  <article className="auto-mix-resource-row" key={persona.voicePersonaId}>
                    <div className="auto-mix-resource-row-main">
                      <div className="auto-mix-resource-row-title">
                        <strong>{persona.displayName || "未命名声音"}</strong>
                        <span className={`auto-mix-resource-status is-${persona.approvalStatus}`}>
                          {APPROVAL_LABELS[persona.approvalStatus]}
                        </span>
                        <span className={`auto-mix-resource-status is-${provisioning.replace("_", "-")}`}>
                          {PROVISIONING_LABELS[provisioning]}
                        </span>
                      </div>
                      <dl className="auto-mix-resource-meta">
                        <div><dt>类型</dt><dd>{CATEGORY_LABELS[persona.category] || persona.category || "未分类"}</dd></div>
                        <div><dt>目录</dt><dd>{persona.catalogVersion || "未标注"}</dd></div>
                        <div><dt>人格 ID</dt><dd><code>{persona.voicePersonaId}</code></dd></div>
                      </dl>
                      {designOutcomeUnknown ? (
                        <p
                          id={`${instanceId}-${persona.voicePersonaId}-design-state`}
                          className="auto-mix-resource-voice-guidance is-blocked"
                          role="alert"
                        >
                          <CircleAlert size={14} aria-hidden="true" />
                          外部生成结果暂时无法确认。为避免重复创建，不会自动重试，也不能再次提交。
                        </p>
                      ) : provisioning === "not_created" ? (
                        <p className="auto-mix-resource-voice-guidance">
                          先生成这个声音，生成完成后才能试听。
                        </p>
                      ) : provisioning === "failed" ? (
                        <p className="auto-mix-resource-voice-guidance is-blocked">
                          上次生成未完成。检查百炼配置后，可由你手动重新生成。
                        </p>
                      ) : null}
                    </div>
                    <div className="auto-mix-resource-row-actions">
                      {canDesign || designOutcomeUnknown ? (
                        <button
                          type="button"
                          data-xiaoxi-auto-mix-voice-design
                          onClick={() => void designVoice(persona)}
                          disabled={!canDesign || voiceBusy}
                          aria-describedby={designOutcomeUnknown ? `${instanceId}-${persona.voicePersonaId}-design-state` : undefined}
                        >
                          {isDesigning
                            ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" />
                            : <Sparkles size={15} aria-hidden="true" />}
                          {designButtonLabel}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-xiaoxi-auto-mix-voice-preview
                        onClick={() => void previewVoice(persona)}
                        disabled={!canPreview || voiceBusy}
                      >
                        {isPreviewing ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                        {isPreviewing ? "读取中" : "试听"}
                      </button>
                      <button
                        type="button"
                        className="is-primary"
                        data-xiaoxi-auto-mix-voice-approve
                        onClick={() => void approveVoice(persona)}
                        disabled={voiceBusy || !canPreview || persona.approvalStatus !== "pending" || !hasPreviewed}
                      >
                        {isApproving ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <BadgeCheck size={15} aria-hidden="true" />}
                        {approvalButtonLabel}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section
            id={musicPanelId}
            role="tabpanel"
            aria-labelledby={musicTabId}
            hidden={section !== "music"}
            tabIndex={0}
          >
            <div className="auto-mix-resource-section-head">
              <div>
                <h3>导入有证据的商用音乐</h3>
                <p>提交信息后，主进程会依次打开音乐文件和授权凭证选择器；页面不会接触文件路径。</p>
              </div>
              <button type="button" onClick={() => void loadMusic()} disabled={musicLoading}>
                <RefreshCw className={musicLoading ? "is-spinning" : ""} size={15} aria-hidden="true" />
                刷新
              </button>
            </div>
            <NoticeLine notice={musicNotice} />

            <form className="auto-mix-resource-form" onSubmit={(event: FormEvent) => event.preventDefault()}>
              <div className="auto-mix-resource-policy">
                <ShieldCheck size={19} aria-hidden="true" />
                <div>
                  <strong>首版只接收有效且明确允许商用的音乐</strong>
                  <span>授权状态固定为 valid，商用许可固定为允许；缺少凭证文件不会完成导入。</span>
                </div>
              </div>

              <div className="auto-mix-resource-form-grid">
                <label>
                  <span>曲目名称</span>
                  <input required maxLength={160} value={musicForm.displayName} onChange={(event) => updateMusicForm("displayName", event.target.value)} placeholder="例如：晨间轻节奏" />
                </label>
                <label>
                  <span>曲目来源</span>
                  <input required maxLength={160} value={musicForm.source} onChange={(event) => updateMusicForm("source", event.target.value)} placeholder="供应商或自有曲库名称" />
                </label>
                <label className="is-wide">
                  <span>商用授权范围</span>
                  <textarea required maxLength={240} rows={2} value={musicForm.commercialScope} onChange={(event) => updateMusicForm("commercialScope", event.target.value)} placeholder="说明可使用的平台、账号、地区或项目范围" />
                </label>
                <label>
                  <span>授权凭证引用</span>
                  <input required maxLength={240} value={musicForm.credentialReference} onChange={(event) => updateMusicForm("credentialReference", event.target.value)} placeholder="订单号、合同编号或授权条目" />
                  <small>实际凭证文件会在点击导入后单独选择。</small>
                </label>
                <label>
                  <span>授权到期日（可选）</span>
                  <input type="date" value={musicForm.expiresAt} onChange={(event) => updateMusicForm("expiresAt", event.target.value)} />
                  <small>有效至所选日期当天结束；长期有效可留空。</small>
                </label>
                <label>
                  <span>BPM（可选）</span>
                  <input inputMode="numeric" min={20} max={300} step={1} value={musicForm.bpm} onChange={(event) => updateMusicForm("bpm", event.target.value)} placeholder="20–300" />
                </label>
                <label>
                  <span>情绪标签（可选）</span>
                  <input maxLength={320} value={musicForm.moods} onChange={(event) => updateMusicForm("moods", event.target.value)} placeholder="舒缓、明亮、可靠" />
                  <small>使用逗号分隔，最多 12 个。</small>
                </label>
                <label className="is-wide auto-mix-resource-energy">
                  <span>能量强度 <output>{Math.round(musicForm.energy * 100)}%</output></span>
                  <input type="range" min={0} max={1} step={0.05} value={musicForm.energy} onChange={(event) => updateMusicForm("energy", Number(event.target.value))} />
                  <span className="auto-mix-resource-range-labels"><small>舒缓</small><small>激情</small></span>
                </label>
                <fieldset className="auto-mix-resource-loop">
                  <legend>可循环区间（可选）</legend>
                  <label>
                    <span>起点（秒）</span>
                    <input inputMode="decimal" min={0} step={0.1} value={musicForm.loopStartSeconds} onChange={(event) => updateMusicForm("loopStartSeconds", event.target.value)} placeholder="例如 8.0" />
                  </label>
                  <label>
                    <span>终点（秒）</span>
                    <input inputMode="decimal" min={0} step={0.1} value={musicForm.loopEndSeconds} onChange={(event) => updateMusicForm("loopEndSeconds", event.target.value)} placeholder="例如 38.0" />
                  </label>
                  <small>需要同时填写，终点必须晚于起点。</small>
                </fieldset>
              </div>

              <button
                type="button"
                className="auto-mix-resource-import"
                data-xiaoxi-auto-mix-music-import
                disabled={importingMusic}
                onClick={() => void importMusic()}
              >
                {importingMusic ? <LoaderCircle className="is-spinning" size={17} aria-hidden="true" /> : <Upload size={17} aria-hidden="true" />}
                {importingMusic ? "正在导入…" : "选择音乐与授权凭证并导入"}
              </button>
            </form>

            <div className="auto-mix-resource-library-head">
              <div>
                <h3>已导入曲库</h3>
                <p>只有分析完成、授权有效且存在凭证的曲目会参与自动配乐。</p>
              </div>
              <span>{musicItems.length} 首</span>
            </div>

            {musicLoading && !musicItems.length ? (
              <div className="auto-mix-resource-empty" role="status">
                <LoaderCircle className="is-spinning" size={20} aria-hidden="true" />
                正在读取授权曲库…
              </div>
            ) : null}
            {!musicLoading && !musicItems.length ? (
              <div className="auto-mix-resource-empty">
                <Music2 size={20} aria-hidden="true" />
                <strong>授权曲库还是空的</strong>
                <span>填写上方信息，点击导入后依次选择音乐和授权凭证。</span>
              </div>
            ) : null}

            <div className="auto-mix-resource-list" aria-label="授权音乐列表">
              {musicItems.map((track) => {
                const license = track.licenseSummary;
                const expired = isLicenseExpired(license?.expiresAt);
                const selectable = isMusicTrackSelectable(track);
                const loopText = formatLoop(track.loop);
                return (
                  <article className="auto-mix-resource-row is-music" key={track.trackId}>
                    <div className="auto-mix-resource-row-main">
                      <div className="auto-mix-resource-row-title">
                        <strong>{track.displayName || "未命名曲目"}</strong>
                        <span className={`auto-mix-resource-status ${selectable ? "is-approved" : "is-pending"}`}>
                          {selectable ? "可用于成片" : expired ? "授权已过期" : track.analysisStatus === "failed" ? "分析失败" : "暂不可用"}
                        </span>
                      </div>
                      <p className="auto-mix-resource-track-source">{track.source || "来源未标注"}</p>
                      <div className="auto-mix-resource-track-facts">
                        <span>{formatDuration(track.durationMs)}</span>
                        {track.bpm ? <span>{track.bpm} BPM</span> : null}
                        <span>能量 {Math.round(Number(track.energy || 0) * 100)}%</span>
                        {loopText ? <span>{loopText}</span> : null}
                        {track.moods.map((mood) => <span key={mood}>{mood}</span>)}
                      </div>
                      <dl className="auto-mix-resource-license">
                        <div><dt>授权状态</dt><dd>{expired ? "已过期" : license?.status === "valid" ? "有效" : license?.status || "未知"}</dd></div>
                        <div><dt>允许商用</dt><dd>{license?.commercialUseAllowed ? "是" : "否"}</dd></div>
                        <div><dt>授权凭证</dt><dd>{license?.evidencePresent ? "已保存" : "缺失"}</dd></div>
                        <div><dt>授权截止</dt><dd>{formatLicenseExpiry(license?.expiresAt)}</dd></div>
                        <div className="is-wide"><dt>使用范围</dt><dd>{license?.commercialScope || "未标注"}</dd></div>
                      </dl>
                      {track.analysisStatus === "failed" ? (
                        <p className="auto-mix-resource-inline-error">
                          <CircleAlert size={14} aria-hidden="true" />
                          曲目分析失败：{track.analysisErrorCode || "请检查音频后重新导入"}
                        </p>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

export default AutoMixResourcePanel;
