import {
  Archive,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Square,
  Video
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./ContentFoundationPage.css";

type ContentEngineState = "unavailable" | "stopped" | "starting" | "ready" | "failed";
type AssetProbeStatus = "pending" | "ok" | "unavailable" | "failed";
type AssetRightsStatus = "unknown" | "owned" | "licensed" | "restricted" | "expired";

type ContentEngineStatus = {
  state: ContentEngineState;
  available: boolean;
  version: string;
  capabilities: Record<string, boolean>;
  code: string;
};

type ContentResult<T> = {
  ok: boolean;
  data?: T;
  code?: string;
  error?: string;
};

type AssetItem = {
  assetId: string;
  displayName: string;
  mediaKind: "video" | "image";
  extension: string;
  sizeBytes: number;
  rightsStatus: AssetRightsStatus;
  probeStatus: AssetProbeStatus;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean | null;
  probeErrorCode: string | null;
  probedAt: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  locationCount: number;
  availableLocationCount: number;
};

type FinishedVideoItem = {
  finishedVideoId: string;
  taskId: string | null;
  displayName: string;
  title: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type ContentTaskStatus = "queued" | "analyzing" | "ready_for_review" | "rendering" | "completed" | "failed" | "cancelled" | "paused";

type ContentTaskItem = {
  taskId: string;
  taskType: string;
  status: ContentTaskStatus;
  resumeFromStatus: ContentTaskStatus | null;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type ImportResult = {
  items: AssetItem[];
  createdAssets: number;
  createdLocations: number;
  skippedCount: number;
  taskId?: string | null;
  status?: ContentTaskStatus | null;
  hasMore?: boolean;
  processedEntries?: number;
};

type ContentSettings = {
  cacheDirectoryLabel?: string;
  cacheLimitGb?: number;
};

type ContentApi = {
  status: () => Promise<ContentResult<ContentEngineStatus>>;
  restart: () => Promise<ContentResult<ContentEngineStatus>>;
  library: {
    list: (payload?: { includeArchived?: boolean; limit?: number }) => Promise<ContentResult<{ items: AssetItem[] }>>;
    chooseFiles: () => Promise<ContentResult<ImportResult>>;
    chooseFolder: (payload?: { recursive?: boolean }) => Promise<ContentResult<ImportResult>>;
    probe: (payload: { assetId: string }) => Promise<ContentResult<AssetItem>>;
    probePending: (payload?: { limit?: number }) => Promise<ContentResult<{ items: AssetItem[]; processedCount: number; remainingCount: number }>>;
    updateRights: (payload: { assetId: string; rightsStatus: AssetRightsStatus }) => Promise<ContentResult<AssetItem>>;
    archive: (payload: { assetId: string }) => Promise<ContentResult<AssetItem>>;
    reveal: (payload: { assetId: string }) => Promise<ContentResult<{ available: boolean }>>;
  };
  tasks: {
    list: (payload?: { status?: ContentTaskStatus; limit?: number }) => Promise<ContentResult<{ items: ContentTaskItem[] }>>;
    pause: (payload: { taskId: string }) => Promise<ContentResult<ContentTaskItem>>;
    resume: (payload: { taskId: string }) => Promise<ContentResult<ContentTaskItem>>;
    cancel: (payload: { taskId: string }) => Promise<ContentResult<ContentTaskItem>>;
  };
  finished: {
    list: (payload?: { limit?: number }) => Promise<ContentResult<{ items: FinishedVideoItem[] }>>;
    chooseAndRegister: (payload?: { title?: string; taskId?: string }) => Promise<ContentResult<FinishedVideoItem>>;
    open: (payload: { finishedVideoId: string }) => Promise<ContentResult<{ opened: boolean }>>;
    reveal: (payload: { finishedVideoId: string }) => Promise<ContentResult<{ available: boolean }>>;
  };
  settings: {
    status: () => Promise<ContentResult<ContentSettings>>;
    chooseCacheDirectory: () => Promise<ContentResult<ContentSettings>>;
    updateCacheLimit: (payload: { limitGb: number }) => Promise<ContentResult<ContentSettings>>;
  };
  onUpdate: (callback: (status: ContentEngineStatus) => void) => () => void;
};

declare global {
  interface Window {
    xiaoxiContent?: ContentApi;
  }
}

const EMPTY_STATUS: ContentEngineStatus = {
  state: "unavailable",
  available: false,
  version: "",
  capabilities: {},
  code: "CONTENT_ENGINE_RUNTIME_UNAVAILABLE"
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** unitIndex);
  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

const ASSET_RIGHTS_OPTIONS: Array<{ value: AssetRightsStatus; label: string }> = [
  { value: "unknown", label: "待确认" },
  { value: "owned", label: "自有素材" },
  { value: "licensed", label: "已获版权授权" },
  { value: "restricted", label: "限制使用" },
  { value: "expired", label: "授权已过期" }
];

const PROBE_ERROR_LABELS: Record<string, string> = {
  ffprobe_unavailable: "媒体分析组件不可用",
  ffprobe_timeout: "媒体分析超时",
  ffprobe_error: "媒体文件无法解析",
  ffprobe_execution_error: "媒体分析组件运行失败",
  ffprobe_invalid_output: "媒体分析结果无效",
  unsupported_media_kind: "暂不支持此类素材",
  video_stream_missing: "没有检测到视频画面",
  asset_file_changed: "原文件登记后发生变化",
  asset_file_unavailable: "原文件不可用",
  probe_failed: "媒体分析失败"
};

function formatDuration(durationMs: number | null) {
  if (!Number.isFinite(durationMs) || durationMs === null || durationMs < 0) return "";
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatMediaDetails(item: AssetItem) {
  if (item.probeStatus === "pending") return "等待分析";
  if (item.probeStatus === "unavailable") {
    return PROBE_ERROR_LABELS[item.probeErrorCode || ""] || "媒体信息暂时不可用";
  }
  if (item.probeStatus === "failed") {
    return PROBE_ERROR_LABELS[item.probeErrorCode || ""] || "媒体分析失败";
  }
  const details = [
    formatDuration(item.durationMs),
    item.width && item.height ? `${item.width}×${item.height}` : "",
    Number.isFinite(item.fps) && item.fps !== null ? `${Number(item.fps.toFixed(2))} fps` : "",
    item.hasAudio === true ? "有音轨" : item.hasAudio === false ? "无音轨" : ""
  ].filter(Boolean);
  return details.join(" · ") || "已完成基础分析";
}

const TASK_STATUS_LABELS: Record<ContentTaskStatus, string> = {
  queued: "排队中",
  analyzing: "等待继续索引",
  ready_for_review: "等待审核",
  rendering: "渲染中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停"
};

function isTerminalTask(status: ContentTaskStatus) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
function useContentEngineStatus() {
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const api = window.xiaoxiContent;
    if (!api) {
      setLoading(false);
      return undefined;
    }
    void api.status()
      .then((result) => {
        if (active && result.ok && result.data) setStatus(result.data);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const unsubscribe = api.onUpdate((nextStatus) => {
      if (active) setStatus(nextStatus);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { status, loading };
}

function ContentEngineBanner({ status, loading }: { status: ContentEngineStatus; loading: boolean }) {
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartError, setRestartError] = useState("");
  const state = loading ? "starting" : status.state;
  const ready = state === "ready";
  const canRestart = state === "failed" || state === "stopped";
  const mediaProbeAvailable = status.capabilities.asset_media_probe === true;
  const copy = restartError || (ready
    ? mediaProbeAvailable
      ? "本地素材索引和媒体信息分析已就绪。原始文件保留在现有硬盘位置，不会重复复制。"
      : "本地素材索引已就绪；当前未检测到媒体分析组件，仍可登记素材和版权/使用权状态。"
    : state === "starting"
      ? "正在启动本地素材索引，请稍候。"
      : state === "failed"
        ? "本地素材索引启动失败，可在这里重新启动。"
        : "当前版本尚未找到素材索引运行组件。");

  const restartEngine = async () => {
    const api = window.xiaoxiContent;
    if (!api || restartBusy) return;
    setRestartBusy(true);
    setRestartError("");
    try {
      const result = await api.restart();
      if (!result.ok || result.data?.state !== "ready") {
        setRestartError(result.error || "重新启动没有成功，请导出诊断日志后重试。");
      }
    } catch {
      setRestartError("重新启动没有成功，请导出诊断日志后重试。");
    } finally {
      setRestartBusy(false);
    }
  };

  return (
    <div className={`content-engine-banner is-${state}`} aria-live="polite">
      {state === "starting"
        ? <LoaderCircle className="content-spin" size={21} />
        : ready
          ? <CircleCheck size={21} />
          : <CircleAlert size={21} />}
      <div>
        <strong>{ready ? "素材底座已连接" : "素材底座未就绪"}</strong>
        <p>{copy}</p>
      </div>
      {canRestart && (
        <button className="secondary-button content-restart-button" onClick={() => void restartEngine()} disabled={restartBusy}>
          <RotateCcw className={restartBusy ? "content-spin" : ""} size={15} />
          {restartBusy ? "启动中" : "重新启动"}
        </button>
      )}
    </div>
  );
}

export function MaterialsLibraryPage() {
  const { status, loading } = useContentEngineStatus();
  const [items, setItems] = useState<AssetItem[]>([]);
  const [tasks, setTasks] = useState<ContentTaskItem[]>([]);
  const [busy, setBusy] = useState("");
  const [taskBusy, setTaskBusy] = useState("");
  const [rightsBusy, setRightsBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [settings, setSettings] = useState<ContentSettings>({});
  const [cacheLimitDraft, setCacheLimitDraft] = useState("100");

  const refresh = useCallback(async () => {
    const api = window.xiaoxiContent;
    if (!api) return;
    setBusy("refresh");
    try {
      const [assetsResult, tasksResult, settingsResult] = await Promise.all([
        api.library.list({ includeArchived: showArchived, limit: 500 }),
        api.tasks.list({ limit: 100 }),
        api.settings.status()
      ]);
      if (assetsResult.ok && assetsResult.data) {
        setItems(assetsResult.data.items);
      } else {
        setNotice(assetsResult.error || "读取素材索引失败，请重试。");
      }
      if (tasksResult.ok && tasksResult.data) setTasks(tasksResult.data.items);
      if (settingsResult.ok && settingsResult.data) {
        setSettings(settingsResult.data);
        setCacheLimitDraft(String(settingsResult.data.cacheLimitGb || 100));
      }
    } catch {
      setNotice("读取素材底座失败，请重试。");
    } finally {
      setBusy("");
    }
  }, [showArchived]);

  useEffect(() => {
    if (status.state === "ready") void refresh();
  }, [refresh, status.state]);

  const importMedia = async (kind: "files" | "folder") => {
    const api = window.xiaoxiContent;
    if (!api) return;
    setBusy(kind);
    setNotice("");
    try {
      const result = kind === "files"
        ? await api.library.chooseFiles()
        : await api.library.chooseFolder({ recursive: true });
      if (result.ok && result.data) {
        const continuation = result.data.hasMore
          ? ` 已处理 ${result.data.processedEntries || 0} 项，请在下方继续下一批。`
          : "";
        setNotice(
          `已登记 ${result.data.createdAssets} 个新素材，新增 ${result.data.createdLocations} 个文件位置`
          + (result.data.skippedCount ? `，跳过 ${result.data.skippedCount} 项。` : "。")
          + continuation
        );
        await refresh();
      } else if (result.code !== "CONTENT_DIALOG_CANCELLED") {
        setNotice(result.error || "素材导入没有完成，请重试。");
      }
    } catch {
      setNotice("素材导入没有完成，请重试。");
    } finally {
      setBusy("");
    }
  };

  const archiveAsset = async (item: AssetItem) => {
    if (!window.confirm(`仅从素材仓库归档“${item.displayName}”？原始文件不会被删除。`)) return;
    const result = await window.xiaoxiContent?.library.archive({ assetId: item.assetId });
    if (result?.ok) {
      setNotice("素材已从当前列表归档，硬盘原文件保持不变。");
      await refresh();
    } else {
      setNotice(result?.error || "归档失败，请重试。");
    }
  };

  const revealAsset = async (item: AssetItem) => {
    const result = await window.xiaoxiContent?.library.reveal({ assetId: item.assetId });
    if (!result?.ok) setNotice(result?.error || "无法在资源管理器中定位该素材。");
  };

  const analyzePending = async () => {
    const api = window.xiaoxiContent;
    if (!api) return;
    setBusy("probe-pending");
    setNotice("");
    try {
      const result = await api.library.probePending({ limit: 10 });
      if (result.ok && result.data) {
        const remaining = result.data.remainingCount > 0
          ? `，还有 ${result.data.remainingCount} 个待分析，可继续处理下一批。`
          : "，当前待分析素材已处理完。";
        setNotice(`已分析 ${result.data.processedCount} 个素材${remaining}`);
        await refresh();
      } else {
        setNotice(result.error || "媒体信息分析没有完成，请重试。");
      }
    } catch {
      setNotice("媒体信息分析没有完成，请重试。");
    } finally {
      setBusy("");
    }
  };

  const analyzeAsset = async (item: AssetItem) => {
    const api = window.xiaoxiContent;
    if (!api) return;
    setBusy(`probe:${item.assetId}`);
    const result = await api.library.probe({ assetId: item.assetId });
    if (result.ok && result.data) {
      setItems((current) => current.map((entry) => (
        entry.assetId === item.assetId ? result.data as AssetItem : entry
      )));
      setNotice(`“${item.displayName}”的媒体信息已更新。`);
    } else {
      setNotice(result.error || "媒体信息分析没有完成，请重试。");
    }
    setBusy("");
  };

  const updateAssetRights = async (item: AssetItem, rightsStatus: AssetRightsStatus) => {
    const api = window.xiaoxiContent;
    if (!api || rightsStatus === item.rightsStatus) return;
    setRightsBusy(item.assetId);
    const result = await api.library.updateRights({ assetId: item.assetId, rightsStatus });
    if (result.ok && result.data) {
      setItems((current) => current.map((entry) => (
        entry.assetId === item.assetId ? result.data as AssetItem : entry
      )));
      setNotice(`“${item.displayName}”的版权/使用权状态已更新。`);
    } else {
      setNotice(result.error || "版权/使用权状态没有更新，请重试。");
    }
    setRightsBusy("");
  };

  const chooseCacheDirectory = async () => {
    const result = await window.xiaoxiContent?.settings.chooseCacheDirectory();
    if (result?.ok && result.data) {
      setSettings((current) => ({ ...current, ...result.data }));
      setNotice("缓存目录已更新；原始素材没有移动。");
    } else if (result?.code !== "CONTENT_DIALOG_CANCELLED") {
      setNotice(result?.error || "缓存目录没有更新。");
    }
  };

  const saveCacheLimit = async () => {
    const limitGb = Number(cacheLimitDraft);
    if (!Number.isInteger(limitGb) || limitGb < 1 || limitGb > 2048) {
      setNotice("缓存上限需填写 1–2048 GB 的整数。");
      return;
    }
    setBusy("cache-limit");
    const result = await window.xiaoxiContent?.settings.updateCacheLimit({ limitGb });
    if (result?.ok && result.data) {
      setSettings((current) => ({ ...current, ...result.data }));
      setNotice(`缓存上限已设为 ${limitGb} GB。`);
    } else {
      setNotice(result?.error || "缓存上限没有更新。");
    }
    setBusy("");
  };

  const runTaskAction = async (task: ContentTaskItem, action: "pause" | "resume" | "cancel") => {
    const api = window.xiaoxiContent;
    if (!api) return;
    setTaskBusy(`${action}:${task.taskId}`);
    const result = await api.tasks[action]({ taskId: task.taskId });
    if (result.ok) {
      setNotice(action === "resume" ? "已处理下一批素材。" : action === "pause" ? "任务已暂停。" : "任务已取消。");
      await refresh();
    } else {
      setNotice(result.error || "任务状态没有更新，请重试。");
    }
    setTaskBusy("");
  };

  const importTasks = tasks.filter((task) => task.taskType === "asset_import").slice(0, 5);
  const ready = status.state === "ready";
  const mediaProbeAvailable = status.capabilities.asset_media_probe === true;
  return (
    <section className="page content-foundation-page">
      <div className="page-head content-page-head">
        <div>
          <h1>素材仓库</h1>
          <p>登记视频和图片的位置，建立可恢复索引；不重复复制几十 GB 原片。</p>
        </div>
        <div className="actions content-page-actions">
          <button className="secondary-button" onClick={() => void analyzePending()} disabled={!ready || !mediaProbeAvailable || Boolean(busy)}>
            <RefreshCw className={busy === "probe-pending" ? "content-spin" : ""} size={17} />
            {mediaProbeAvailable ? "分析待处理素材" : "媒体分析组件未安装"}
          </button>
          <button className="secondary-button" onClick={() => void chooseCacheDirectory()} disabled={!ready || Boolean(busy)}>
            <Settings2 size={17} />
            缓存位置
          </button>
          <button className="secondary-button" onClick={() => void importMedia("folder")} disabled={!ready || Boolean(busy)}>
            <FolderOpen size={17} />
            添加文件夹
          </button>
          <button className="primary-button" onClick={() => void importMedia("files")} disabled={!ready || Boolean(busy)}>
            <FilePlus2 size={17} />
            添加素材
          </button>
        </div>
      </div>

      <ContentEngineBanner status={status} loading={loading} />
      <div className="content-cache-summary">
        <span>缓存位置：{settings.cacheDirectoryLabel || "尚未选择"}</span>
        <label>
          上限
          <input
            type="number"
            min="1"
            max="2048"
            step="1"
            value={cacheLimitDraft}
            onChange={(event) => setCacheLimitDraft(event.target.value)}
            disabled={!ready || Boolean(busy)}
          />
          GB
        </label>
        <button className="text-button" onClick={() => void saveCacheLimit()} disabled={!ready || Boolean(busy)}>
          <Save size={14} />
          保存
        </button>
      </div>
      {notice && <div className="touch-notice" role="status">{notice}</div>}

      {importTasks.length > 0 && (
        <div className="content-task-panel">
          <div className="content-task-head">
            <div>
              <strong>素材导入任务</strong>
              <span>大文件夹每批最多登记 200 项，可继续、暂停或取消。</span>
            </div>
            <button className="text-button" onClick={() => void refresh()} disabled={!ready || Boolean(busy)}>
              <RefreshCw size={14} />
              刷新任务
            </button>
          </div>
          {importTasks.map((task) => {
            const taskIsBusy = taskBusy.endsWith(task.taskId);
            const canContinue = task.status === "queued" || task.status === "analyzing" || task.status === "paused";
            const canPause = task.status === "queued" || task.status === "analyzing";
            return (
              <div className="content-task-row" key={task.taskId}>
                <div>
                  <strong>文件夹分批索引</strong>
                  <span>{TASK_STATUS_LABELS[task.status]} · 更新于 {formatDate(task.updatedAt)}</span>
                  {task.errorMessage && <small>{task.errorMessage}</small>}
                </div>
                <div className="content-task-actions">
                  {canContinue && (
                    <button className="secondary-button" onClick={() => void runTaskAction(task, "resume")} disabled={taskIsBusy || !ready}>
                      <RotateCcw size={14} />
                      继续下一批
                    </button>
                  )}
                  {canPause && (
                    <button className="secondary-button" onClick={() => void runTaskAction(task, "pause")} disabled={taskIsBusy || !ready}>
                      <Pause size={14} />
                      暂停
                    </button>
                  )}
                  {!isTerminalTask(task.status) && (
                    <button className="text-button is-danger" onClick={() => void runTaskAction(task, "cancel")} disabled={taskIsBusy || !ready}>
                      <Square size={13} />
                      取消
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="content-list-toolbar">
        <label>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          显示已归档素材
        </label>
        <button className="text-button" onClick={() => void refresh()} disabled={!ready || Boolean(busy)}>
          <RefreshCw size={15} />
          刷新
        </button>
      </div>

      <div className="content-table-wrap">
        <table className="content-table">
          <thead>
            <tr>
              <th>素材</th>
              <th>类型</th>
              <th>媒体信息</th>
              <th>大小</th>
              <th>文件状态</th>
              <th>版权/使用权状态</th>
              <th>登记时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.assetId} className={item.archived ? "is-archived" : ""}>
                <td>
                  <strong>{item.displayName}</strong>
                  <small>{item.extension || "—"} · {item.locationCount} 个位置</small>
                </td>
                <td>{item.mediaKind === "video" ? "视频" : "图片"}</td>
                <td className={`content-media-info is-${item.probeStatus}`}>{formatMediaDetails(item)}</td>
                <td>{formatBytes(item.sizeBytes)}</td>
                <td>
                  <span className={`content-status-dot ${item.availableLocationCount > 0 ? "is-ok" : "is-missing"}`} />
                  {item.availableLocationCount > 0 ? "可用" : "原文件未找到"}
                </td>
                <td>
                  <select
                    className={`content-rights-select is-${item.rightsStatus}`}
                    value={item.rightsStatus}
                    onChange={(event) => void updateAssetRights(item, event.target.value as AssetRightsStatus)}
                    disabled={!ready || rightsBusy === item.assetId}
                    aria-label={`更新“${item.displayName}”的版权/使用权状态`}
                  >
                    {ASSET_RIGHTS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </td>
                <td>{formatDate(item.createdAt)}</td>
                <td>
                  <div className="content-row-actions">
                    <button
                      title="重新分析媒体信息"
                      onClick={() => void analyzeAsset(item)}
                      disabled={!ready || !mediaProbeAvailable || Boolean(busy) || item.availableLocationCount === 0}
                    >
                      <RefreshCw className={busy === `probe:${item.assetId}` ? "content-spin" : ""} size={16} />
                    </button>
                    <button title="在资源管理器中显示" onClick={() => void revealAsset(item)} disabled={!ready}>
                      <ExternalLink size={16} />
                    </button>
                    {!item.archived && (
                      <button title="从素材库归档（不删除原片）" onClick={() => void archiveAsset(item)} disabled={!ready}>
                        <Archive size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <div className="content-empty">
            <FolderOpen size={34} />
            <strong>{ready ? "还没有登记素材" : "素材底座尚未就绪"}</strong>
            <p>{ready ? "选择文件或文件夹即可开始，原片仍留在原来的硬盘位置。" : "运行组件就绪后，才能安全建立本地素材索引。"}</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function FinishedVideoCenterPage() {
  const { status, loading } = useContentEngineStatus();
  const [items, setItems] = useState<FinishedVideoItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const api = window.xiaoxiContent;
    if (!api) return;
    setBusy(true);
    const result = await api.finished.list({ limit: 500 });
    if (result.ok && result.data) {
      setItems(result.data.items);
      setNotice("");
    } else {
      setNotice(result.error || "读取成片列表失败，请重试。");
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    if (status.state === "ready") void refresh();
  }, [refresh, status.state]);

  const registerVideo = async () => {
    const result = await window.xiaoxiContent?.finished.chooseAndRegister();
    if (result?.ok) {
      setNotice("成片已登记。视频文件仍保存在原来的输出位置。");
      await refresh();
    } else if (result?.code !== "CONTENT_DIALOG_CANCELLED") {
      setNotice(result?.error || "成片登记没有完成。");
    }
  };

  const openVideo = async (item: FinishedVideoItem) => {
    const result = await window.xiaoxiContent?.finished.open({ finishedVideoId: item.finishedVideoId });
    if (!result?.ok) setNotice(result?.error || "当前无法打开这条成片。");
  };

  const revealVideo = async (item: FinishedVideoItem) => {
    const result = await window.xiaoxiContent?.finished.reveal({ finishedVideoId: item.finishedVideoId });
    if (!result?.ok) setNotice(result?.error || "当前无法定位这条成片。");
  };

  const ready = status.state === "ready";
  return (
    <section className="page content-foundation-page">
      <div className="page-head content-page-head">
        <div>
          <h1>成片中心</h1>
          <p>课程拆条、智能混剪和后续 AI 生成视频统一进入这里。</p>
        </div>
        <div className="actions content-page-actions">
          <button className="secondary-button" onClick={() => void refresh()} disabled={!ready || busy}>
            <RefreshCw size={17} />
            刷新
          </button>
          <button className="primary-button" onClick={() => void registerVideo()} disabled={!ready || busy}>
            <Video size={17} />
            登记已有成片
          </button>
        </div>
      </div>

      <ContentEngineBanner status={status} loading={loading} />
      {notice && <div className="touch-notice" role="status">{notice}</div>}

      <div className="finished-grid">
        {items.map((item) => (
          <article key={item.finishedVideoId} className="finished-card">
            <div className="finished-card-cover">
              <Video size={34} />
            </div>
            <div className="finished-card-body">
              <strong>{item.title || item.displayName}</strong>
              <span>{formatBytes(item.sizeBytes)} · {formatDate(item.createdAt)}</span>
              <div className="finished-card-actions">
                <button className="primary-button" onClick={() => void openVideo(item)} disabled={!ready}>
                  <Play size={15} />
                  播放
                </button>
                <button className="secondary-button" onClick={() => void revealVideo(item)} disabled={!ready}>
                  <FolderOpen size={15} />
                  定位文件
                </button>
              </div>
            </div>
          </article>
        ))}
        {!items.length && (
          <div className="content-empty finished-empty">
            <Video size={36} />
            <strong>{ready ? "还没有成片" : "成片底座尚未就绪"}</strong>
            <p>{ready ? "后续剪辑任务完成后会自动登记，也可以先登记已有视频。" : "运行组件就绪后，成片会统一在这里管理。"}</p>
          </div>
        )}
      </div>
    </section>
  );
}
