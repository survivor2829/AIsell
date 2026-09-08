import {
  Archive,
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  FilePlus2,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Square,
  Video
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  available: boolean;
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
  productions: import("./content-production-types").ProductionsApi;
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
    get: (payload: { taskId: string }) => Promise<ContentResult<ContentTaskItem>>;
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
    download: (payload: { finishedVideoId: string }) => Promise<ContentResult<{ finishedVideoId: string; canceled: boolean; filename?: string }>>;
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
      ? "媒体信息可分析；原文件保留在原位置，不会重复复制。"
      : "未安装媒体分析组件，仍可登记素材和维护使用权。"
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
    <div className={`content-engine-banner is-${state}${ready ? " is-compact" : ""}`} aria-live="polite">
      {state === "starting"
        ? <LoaderCircle className="content-spin" size={21} />
        : ready
          ? <CircleCheck size={21} />
          : <CircleAlert size={21} />}
      <div>
        <strong>{ready ? "素材索引已就绪" : "素材底座未就绪"}</strong>
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
  const [query, setQuery] = useState("");
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

  const importTasks = tasks
    .filter((task) => task.taskType === "asset_import" && task.status !== "completed" && task.status !== "cancelled")
    .slice(0, 5);
  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return items;
    return items.filter((item) => {
      const rightsLabel = ASSET_RIGHTS_OPTIONS.find((option) => option.value === item.rightsStatus)?.label || "";
      const mediaKindLabel = item.mediaKind === "video" ? "视频" : "图片";
      return [item.displayName, item.extension, mediaKindLabel, rightsLabel, formatMediaDetails(item)]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [items, query]);
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
      <details className="content-settings">
        <summary>
          <span><Settings2 size={15} />仓库设置</span>
          <small>缓存：{settings.cacheDirectoryLabel || "默认位置"} · 上限 {settings.cacheLimitGb || cacheLimitDraft} GB</small>
        </summary>
        <div className="content-cache-summary">
          <div className="content-cache-location">
            <span>缓存位置</span>
            <strong title={settings.cacheDirectoryLabel || "尚未选择"}>{settings.cacheDirectoryLabel || "尚未选择"}</strong>
            <button className="secondary-button" onClick={() => void chooseCacheDirectory()} disabled={!ready || Boolean(busy)}>
              <FolderOpen size={15} />
              选择位置
            </button>
          </div>
          <label>
            缓存上限
            <span>
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
            </span>
          </label>
          <button className="secondary-button" onClick={() => void saveCacheLimit()} disabled={!ready || Boolean(busy)}>
            <Save size={14} />
            保存上限
          </button>
        </div>
      </details>
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
        <div className="content-library-summary">
          <strong>全部素材</strong>
          <span>{query.trim() ? `${filteredItems.length} 个匹配结果` : `共 ${items.length} 个`}</span>
        </div>
        <label className="content-library-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、格式或状态"
            aria-label="搜索素材"
          />
        </label>
        <div className="content-toolbar-actions">
          {mediaProbeAvailable && (
            <button className="secondary-button" onClick={() => void analyzePending()} disabled={!ready || Boolean(busy)}>
              <RefreshCw className={busy === "probe-pending" ? "content-spin" : ""} size={15} />
              分析待处理
            </button>
          )}
          <label className="content-archive-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            显示已归档
          </label>
          <button
            className="content-icon-button"
            aria-label="刷新素材列表"
            title="刷新素材列表"
            onClick={() => void refresh()}
            disabled={!ready || Boolean(busy)}
          >
            <RefreshCw className={busy === "refresh" ? "content-spin" : ""} size={16} />
          </button>
        </div>
      </div>

      <div className="content-table-wrap">
        <table className="content-table">
          <colgroup>
            <col />
            <col className="content-col-status" />
            <col className="content-col-rights" />
            <col className="content-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>素材信息</th>
              <th>文件状态</th>
              <th>版权/使用权</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => {
              const mediaDetails = formatMediaDetails(item);
              const MediaIcon = item.mediaKind === "video" ? Video : ImageIcon;
              return (
              <tr key={item.assetId} className={item.archived ? "is-archived" : ""}>
                <td>
                  <div className="content-asset-cell">
                    <span className={`content-asset-icon is-${item.mediaKind}`} aria-hidden="true">
                      <MediaIcon size={19} />
                    </span>
                    <div className="content-asset-copy">
                      <strong title={item.displayName}>{item.displayName}</strong>
                      <div className={`content-asset-metadata is-${item.probeStatus}`} title={mediaDetails}>
                        <span>{item.mediaKind === "video" ? "视频" : "图片"}</span>
                        <span>{mediaDetails}</span>
                        <span>{formatBytes(item.sizeBytes)}</span>
                      </div>
                      <small>{item.extension || "—"} · {item.locationCount} 个位置 · 登记于 {formatDate(item.createdAt)}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`content-file-status ${item.availableLocationCount > 0 ? "is-ok" : "is-missing"}`}>
                    <span className="content-status-dot" />
                    {item.availableLocationCount > 0 ? "可用" : "原文件未找到"}
                  </span>
                  {item.archived && <small className="content-archived-label">已归档</small>}
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
                <td>
                  <div className="content-row-actions">
                    <button
                      title="重新分析媒体信息"
                      aria-label={`重新分析“${item.displayName}”的媒体信息`}
                      onClick={() => void analyzeAsset(item)}
                      disabled={!ready || !mediaProbeAvailable || Boolean(busy) || item.availableLocationCount === 0}
                    >
                      <RefreshCw className={busy === `probe:${item.assetId}` ? "content-spin" : ""} size={16} />
                    </button>
                    <button
                      title="在资源管理器中显示"
                      aria-label={`在资源管理器中显示“${item.displayName}”`}
                      onClick={() => void revealAsset(item)}
                      disabled={!ready}
                    >
                      <ExternalLink size={16} />
                    </button>
                    {!item.archived && (
                      <button
                        title="从素材库归档（不删除原片）"
                        aria-label={`从素材库归档“${item.displayName}”（不删除原片）`}
                        onClick={() => void archiveAsset(item)}
                        disabled={!ready}
                      >
                        <Archive size={16} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {!filteredItems.length && (
          <div className="content-empty">
            {query.trim() ? <Search size={34} /> : <FolderOpen size={34} />}
            <strong>{query.trim() ? `没有找到“${query.trim()}”` : ready ? "还没有登记素材" : "素材底座尚未就绪"}</strong>
            <p>{query.trim() ? "可以换一个名称、格式或状态再搜索。" : ready ? "选择文件或文件夹即可开始，原片仍留在原来的硬盘位置。" : "运行组件就绪后，才能安全建立本地素材索引。"}</p>
            {query.trim() && <button className="secondary-button" onClick={() => setQuery("")}>清除搜索</button>}
          </div>
        )}
      </div>
    </section>
  );
}

const FINISHED_PAGE_SIZE = 12;
const GENERATED_VIDEO_ID = /^generated_video_[a-f0-9]{32}$/i;

function finishedVideoTitle(item: FinishedVideoItem) {
  return item.title || item.displayName || "未命名成片";
}

function finishedVideoAvailable(item: FinishedVideoItem) {
  return item.available !== false;
}

function finishedVideoGeneratedId(item: FinishedVideoItem) {
  const value = item.metadata?.generated_video_id ?? item.metadata?.generatedVideoId;
  return typeof value === "string" && GENERATED_VIDEO_ID.test(value) ? value : "";
}

export function FinishedVideoCenterPage({ onOpenProductions }: { onOpenProductions?: () => void }) {
  const { status, loading } = useContentEngineStatus();
  const [items, setItems] = useState<FinishedVideoItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloadingId, setDownloadingId] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(FINISHED_PAGE_SIZE);
  const [brokenCovers, setBrokenCovers] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async (options?: { silent?: boolean; announce?: boolean }) => {
    const api = window.xiaoxiContent;
    if (!api) return;
    if (!options?.silent) setBusy(true);
    const result = await api.finished.list({ limit: 500 });
    if (result.ok && result.data) {
      setItems(result.data.items);
      setBrokenCovers({});
      if (options?.announce) setNotice("成片列表已刷新，已同步本地文件状态。");
    } else if (!options?.silent) {
      setNotice(result.error || "读取成片列表失败，请重试。");
    }
    if (!options?.silent) setBusy(false);
  }, []);

  useEffect(() => {
    if (status.state === "ready") void refresh();
  }, [refresh, status.state]);

  useEffect(() => {
    if (status.state !== "ready") return undefined;
    const handleFocus = () => void refresh({ silent: true });
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh, status.state]);

  useEffect(() => {
    setVisibleCount(FINISHED_PAGE_SIZE);
  }, [query]);

  const availableCount = useMemo(() => items.filter(finishedVideoAvailable).length, [items]);
  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (!finishedVideoAvailable(item)) return false;
      if (!normalizedQuery) return true;
      return `${finishedVideoTitle(item)} ${item.displayName}`.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [items, query]);
  const visibleItems = filteredItems.slice(0, visibleCount);

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
    if (!result?.ok) {
      setNotice(result?.error || "当前无法打开这条成片，文件可能已被移动或删除。");
      await refresh({ silent: true });
    }
  };

  const revealVideo = async (item: FinishedVideoItem) => {
    const result = await window.xiaoxiContent?.finished.reveal({ finishedVideoId: item.finishedVideoId });
    if (!result?.ok || result.data?.available === false) {
      setNotice(result?.error || "当前无法定位这条成片，文件可能已被移动或删除。");
      await refresh({ silent: true });
    }
  };

  const downloadVideo = async (item: FinishedVideoItem) => {
    const api = window.xiaoxiContent;
    if (!api?.finished.download) {
      setNotice("下载功能尚未加载，请重启软件后再试。");
      return;
    }
    setDownloadingId(item.finishedVideoId);
    const result = await api.finished.download({ finishedVideoId: item.finishedVideoId });
    setDownloadingId("");
    if (result.ok && result.data) {
      if (!result.data.canceled) setNotice(`已保存成片：${result.data.filename || finishedVideoTitle(item)}`);
      return;
    }
    setNotice(result.error || "成片没有保存成功，请确认原文件仍然存在。");
    await refresh({ silent: true });
  };

  const ready = status.state === "ready";
  const showInitialSkeleton = ready && busy && items.length === 0;
  const emptyTitle = query.trim() ? `没有找到“${query.trim()}”` : "还没有可用成片";
  const emptyDescription = query.trim()
    ? "可以换一个标题或文件名再搜索。"
    : "制作完成后，作品会自动出现在这里，也可以登记已有视频。";

  return (
    <section className="page content-foundation-page finished-page">
      <div className="page-head content-page-head">
        <div>
          <h1>成片中心</h1>
          <p>查看和下载可用作品，最新成片排在前面。</p>
        </div>
        <div className="actions content-page-actions">
          {onOpenProductions && <button className="secondary-button" onClick={onOpenProductions}>制作记录</button>}
          <button className="secondary-button" onClick={() => void refresh({ announce: true })} disabled={!ready || busy}>
            <RefreshCw className={busy ? "content-spin" : ""} size={17} />
            刷新
          </button>
          <button className="primary-button" onClick={() => void registerVideo()} disabled={!ready || busy}>
            <Video size={17} />
            登记已有成片
          </button>
        </div>
      </div>

      {!ready && <ContentEngineBanner status={status} loading={loading} />}
      {notice && <div className="touch-notice" role="status">{notice}</div>}

      {ready && (
        <div className="finished-toolbar" aria-label="成片筛选">
          <label className="finished-search">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="搜索成片"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或文件名"
            />
          </label>
          <span className="finished-result-count">{query.trim() ? `找到 ${filteredItems.length} 条作品` : `${availableCount} 条可用作品`}</span>
        </div>
      )}

      <div className="finished-grid">
        {showInitialSkeleton && Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="finished-card finished-card-skeleton" aria-hidden="true">
            <div className="finished-card-cover" />
            <div className="finished-card-body"><i /><i /><i /></div>
          </div>
        ))}
        {!showInitialSkeleton && visibleItems.map((item) => {
          const available = finishedVideoAvailable(item);
          const generatedVideoId = finishedVideoGeneratedId(item);
          const title = finishedVideoTitle(item);
          const coverReady = Boolean(generatedVideoId && !brokenCovers[item.finishedVideoId]);
          return (
            <article key={item.finishedVideoId} className={`finished-card${available ? "" : " is-unavailable"}`}>
              <div className="finished-card-cover">
                {coverReady ? (
                  <img
                    className="finished-card-cover-image"
                    src={`xiaoxi-content://generated/${generatedVideoId}/thumbnail`}
                    alt={`${title}封面`}
                    loading="lazy"
                    decoding="async"
                    onError={() => setBrokenCovers((current) => ({ ...current, [item.finishedVideoId]: true }))}
                  />
                ) : (
                  <div className="finished-card-cover-fallback">
                    <Video size={30} />
                    <span>暂无封面</span>
                  </div>
                )}
                {available && (
                  <button className="finished-card-play" aria-label={`播放${title}`} onClick={() => void openVideo(item)} disabled={!ready}>
                    <Play size={19} fill="currentColor" />
                  </button>
                )}
              </div>
              <div className="finished-card-body">
                <strong title={title}>{title}</strong>
                <span>{formatBytes(item.sizeBytes)} · {formatDate(item.createdAt)}</span>
                {available ? (
                  <div className="finished-card-actions">
                    <button
                      className="primary-button finished-download-button"
                      onClick={() => void downloadVideo(item)}
                      disabled={!ready || Boolean(downloadingId)}
                    >
                      <Download size={15} />
                      {downloadingId === item.finishedVideoId ? "保存中…" : "下载到…"}
                    </button>
                    <button className="secondary-button" onClick={() => void revealVideo(item)} disabled={!ready || Boolean(downloadingId)}>
                      <FolderOpen size={15} />
                      定位文件
                    </button>
                  </div>
                ) : (
                  <p className="finished-card-missing">本地文件已删除或不可访问，已从可用成片中移出。</p>
                )}
              </div>
            </article>
          );
        })}
        {!showInitialSkeleton && !visibleItems.length && (
          <div className="content-empty finished-empty">
            <Video size={36} />
            <strong>{ready ? emptyTitle : "成片底座尚未就绪"}</strong>
            <p>{ready ? emptyDescription : "运行组件就绪后，成片会统一在这里管理。"}</p>
            {ready && query.trim() && <button className="secondary-button" onClick={() => setQuery("")}>清除搜索</button>}

          </div>
        )}
      </div>

      {visibleItems.length > 0 && filteredItems.length > visibleItems.length && (
        <div className="finished-load-more">
          <span>已显示 {visibleItems.length} / {filteredItems.length} 条</span>
          <button className="secondary-button" onClick={() => setVisibleCount((count) => count + FINISHED_PAGE_SIZE)}>加载更多</button>
        </div>
      )}
    </section>
  );
}
