import { CircleAlert, CircleCheck, Copy, LoaderCircle, PlayCircle, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./ProductDetailPage.css";
import { appearanceFor, portraitAsset, type RolePreference } from "./role-appearance";
import { ProductDetailExamples } from "./ProductDetailExamples";

type ProductDetailState = "unavailable" | "stopped" | "starting" | "failed" | "ready";

type ProductDetailStatus = {
  state: ProductDetailState;
  available: boolean;
  origin: string;
  bootstrapUrl: string;
  version: string;
  capabilities: Record<string, boolean>;
  code: string;
  diagnostics?: { phase: string; elapsedMs: number; exitCode: number | null; signal: string; stderrType: string };
};

type ProductDetailResult = {
  ok: boolean;
  data?: ProductDetailStatus;
  code?: string;
  error?: string;
};

type ProductDetailDownloadUpdate = {
  state: "started" | "completed" | "failed";
  filename: string;
  code?: string;
};

type ProductDetailApi = {
  status: () => Promise<ProductDetailResult>;
  start: () => Promise<ProductDetailResult>;
  restart: () => Promise<ProductDetailResult>;
  stop: () => Promise<ProductDetailResult>;
  onUpdate: (callback: (status: ProductDetailStatus) => void) => () => void;
  onDownloadUpdate: (callback: (update: ProductDetailDownloadUpdate) => void) => () => void;
};

declare global {
  interface Window {
    xiaoxiProductDetail?: ProductDetailApi;
  }
}

const EMPTY_STATUS: ProductDetailStatus = {
  state: "unavailable",
  available: false,
  origin: "",
  bootstrapUrl: "",
  version: "",
  capabilities: {},
  code: "PRODUCT_DETAIL_RUNTIME_UNAVAILABLE"
};

const STATE_COPY: Record<ProductDetailState, { title: string; description: string }> = {
  unavailable: { title: "工作台暂不可用", description: "请重试打开工作台。如果仍无法打开，可复制下方故障信息联系支持。" },
  stopped: {
    title: "正在准备工作台",
    description: "正在打开产品详情图工作台，请稍候。"
  },
  starting: {
    title: "正在准备工作台",
    description: "正在准备工作台，请稍候。"
  },
  failed: {
    title: "启动失败",
    description: "本地工作台没有成功就绪。可以重试；如果持续失败，请导出日志交给技术人员检查。"
  },
  ready: {
    title: "服务已就绪",
    description: "下方工作台仅连接本机回环服务，关闭软件时服务会一并停止。"
  }
};

const FAILURE_COPY: Record<string, string> = {
  PRODUCT_DETAIL_START_TIMEOUT: "本地组件准备超时。可点击重试；若仍失败，请导出日志，日志会保留卡住的阶段。",
  PRODUCT_DETAIL_EXITED: "本地组件启动时意外退出。请重试；若仍失败，请将下方故障信息和诊断日志交给技术人员。",
  PRODUCT_DETAIL_SPAWN_FAILED: "未能运行本地组件。请检查安全软件是否拦截，以及安装目录是否允许访问。",
  PRODUCT_DETAIL_RUNTIME_LINK_FAILED: "无法准备本地运行目录。请检查软件数据目录是否可写，然后重试。",
  PRODUCT_DETAIL_STOP_TIMEOUT: "上一次本地组件尚未退出。请稍后重试，软件会等待旧组件关闭后再启动。"
};

export function ProductDetailPage({ preference, onPersonalize }: { preference: RolePreference; onPersonalize: () => void }) {
  const appearance = appearanceFor("operations", preference.appearanceId);
  const [status, setStatus] = useState<ProductDetailStatus>(EMPTY_STATUS);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [showExample, setShowExample] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!status.origin) return;
    const receive = (event: MessageEvent) => {
      const element = frame.current;
      if (!element || event.source !== element.contentWindow || event.origin !== status.origin
          || element.closest("[hidden]") || event.data?.type !== "xiaoxi:product-detail-scroll") return;
      const delta = event.data.deltaY;
      if (typeof delta === "number" && Number.isFinite(delta)) {
        element.closest(".content-card")?.scrollBy({ top: Math.max(-800, Math.min(800, delta)), behavior: "instant" });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [status.origin]);

  const applyResult = (result: ProductDetailResult) => {
    if (result.ok && result.data) {
      setStatus(result.data);
      setNotice("");
      return;
    }
    setStatus((current) => ({
      ...current,
      state: result.code === "PRODUCT_DETAIL_RUNTIME_UNAVAILABLE" ? "unavailable" : "failed",
      origin: "",
      bootstrapUrl: "",
      code: result.code || "PRODUCT_DETAIL_FAILED"
    }));
    setNotice(result.error || "产品详情图桌面连接暂时不可用，请重试。");
  };

  const run = (action: "status" | "start" | "restart" | "stop") => {
    const api = window.xiaoxiProductDetail;
    if (!api) {
      setStatus(EMPTY_STATUS);
      setNotice("当前版本未连接产品详情图桌面服务。");
      return;
    }
    setBusy(true);
    setNotice("");
    void api[action]()
      .then(applyResult)
      .catch(() => {
        setStatus((current) => ({
          ...current,
          state: "failed",
          origin: "",
          bootstrapUrl: "",
          code: "PRODUCT_DETAIL_FAILED"
        }));
        setNotice("产品详情图桌面连接暂时不可用，请重试。");
      })
      .finally(() => {
        setBusy(false);
        setLoadingStatus(false);
      });
  };

  useEffect(() => {
    let active = true;
    const api = window.xiaoxiProductDetail;
    if (!api) {
      setLoadingStatus(false);
      setNotice("当前版本未连接产品详情图桌面服务。");
      return undefined;
    }
    void api.start()
      .then((result) => {
        if (active) applyResult(result);
      })
      .catch(() => {
        if (active) setNotice("读取产品详情图服务状态失败，请重试。");
      })
      .finally(() => {
        if (active) setLoadingStatus(false);
      });
    const unsubscribe = api.onUpdate((nextStatus) => {
      if (active) {
        setStatus(nextStatus);
        setNotice("");
      }
    });
    const unsubscribeDownload = api.onDownloadUpdate((update) => {
      if (!active) return;
      if (update.state === "started") {
        setNotice(`正在保存到桌面：${update.filename}`);
      } else if (update.state === "completed") {
        setNotice(`已保存到桌面：${update.filename}`);
      } else {
        setNotice(`下载失败，请重试：${update.filename}`);
      }
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeDownload();
    };
  }, []);

  const displayState = loadingStatus ? "starting" : status.state;
  const copy = STATE_COPY[displayState];
  const canShowWorkspace = status.state === "ready" && Boolean(status.bootstrapUrl);
  const diagnosticText = [
    "产品详情图启动诊断", `状态：${status.state}`, `故障码：${status.code || "无"}`,
    `阶段：${status.diagnostics?.phase || "未知"}`, `组件版本：${status.version || "未就绪"}`,
    ...(status.diagnostics ? [
      `耗时：${status.diagnostics.elapsedMs}ms`, `退出码：${status.diagnostics.exitCode ?? "未知"}`,
      `信号：${status.diagnostics.signal || "无"}`, `异常类型：${status.diagnostics.stderrType || "无"}`
    ] : [])
  ].join("\n");
  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticText);
      setNotice("已复制故障信息，可发送给技术人员。");
    } catch {
      setNotice("无法自动复制，请选中下方故障信息手动复制。");
    }
  };

  return (
    <section className={`page product-detail-page${canShowWorkspace ? " has-workspace" : ""}`}>
      <div className="product-detail-intro">
      <header className="product-detail-guide">
        <button type="button" className="product-detail-persona" onClick={onPersonalize} aria-label="设置产品详情图伙伴的形象与名字"><img src={portraitAsset(appearance)} alt="" /></button>
        <div className="product-detail-guide-copy">
          <h1>产品详情图</h1>
          <p className="product-detail-promise">把产品卖点讲清楚，详情图、参数图一起准备。</p>
          <p><strong>{preference.name}</strong>，陪您把产品介绍清楚。</p>
          <div className="product-detail-guide-actions">
            <button type="button" className="secondary-button" onClick={() => setShowExample(true)}><PlayCircle size={18} />查看生成示例</button>
            {!loadingStatus && ["failed", "unavailable", "stopped"].includes(status.state) && <button type="button" className="primary-button" onClick={() => run(status.state === "failed" ? "restart" : "start")} disabled={busy}><RefreshCw size={16} />重试</button>}
          </div>
        </div>
        <button type="button" className="product-detail-personalize" onClick={onPersonalize}><Settings2 size={16} />形象与名字</button>
      </header>

      <ProductDetailExamples requested={showExample} onOpened={() => setShowExample(false)} />
      </div>

      {!canShowWorkspace && <div className={`product-detail-state is-${displayState}`} aria-live="polite">
        <div className="product-detail-state-icon">
          {displayState === "starting"
            ? <LoaderCircle className="product-detail-spinner" size={22} />
            : displayState === "ready"
              ? <CircleCheck size={22} />
              : <CircleAlert size={22} />}
        </div>
        <div>
          <strong>{copy.title}</strong>
          <p>{displayState === "failed" ? FAILURE_COPY[status.code] || copy.description
            : copy.description}</p>

          {(displayState === "failed" || displayState === "unavailable") && <details className="product-detail-diagnostics">
            <summary>故障信息</summary>
            <pre>{diagnosticText}</pre>
            <button className="secondary-button" type="button" onClick={() => void copyDiagnostics()}>
              <Copy size={15} />复制故障信息
            </button>
          </details>}
        </div>
      </div>}

      {notice && <div className="touch-notice" role="alert">{notice}</div>}

      {canShowWorkspace && (
        <div className="product-detail-workspace">
          <iframe
            ref={frame}
            key={status.bootstrapUrl}
            title="产品详情图工作台"
            src={status.bootstrapUrl}
            sandbox="allow-forms allow-scripts allow-same-origin allow-downloads"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </section>
  );
}
