import { CircleAlert, CircleCheck, Copy, LoaderCircle, Play, RefreshCw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import "./ProductDetailPage.css";

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

const DEVELOPMENT_EDITION = import.meta.env.VITE_XIAOXI_EDITION === "development";

const UNAVAILABLE_COPY = DEVELOPMENT_EDITION
  ? {
    title: "运行组件未配置",
    description: "当前桌面版没有找到产品详情图运行组件，因此不会启动任何本地服务。"
  }
  : {
    title: "产品详情图组件不可用",
    description: "安装文件可能不完整，或运行组件已被安全软件隔离。请按下方方式恢复。"
  };

const STATE_COPY: Record<ProductDetailState, { title: string; description: string }> = {
  unavailable: UNAVAILABLE_COPY,
  stopped: {
    title: "服务未启动",
    description: "产品详情图已安装。点击启动后才会打开本地工作台，不会在进入页面时自动运行。"
  },
  starting: {
    title: "正在启动",
    description: "正在准备本地隔离工作台，请稍候。"
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

const STARTUP_PHASE: Record<string, string> = {
  provider_config: "读取服务配置", prepare_runtime: "准备本地组件", spawn: "启动本地组件",
  prepare_data: "准备工作目录", browser_check: "检查导出组件", load_app: "加载工作台",
  install_contract: "连接工作台", listen: "等待本地连接", ready: "服务就绪"
};
const FAILURE_COPY: Record<string, string> = {
  PRODUCT_DETAIL_START_TIMEOUT: "本地组件准备超时。可点击重试；若仍失败，请导出日志，日志会保留卡住的阶段。",
  PRODUCT_DETAIL_EXITED: "本地组件启动时意外退出。请重试；若仍失败，请将下方故障信息和诊断日志交给技术人员。",
  PRODUCT_DETAIL_SPAWN_FAILED: "未能运行本地组件。请检查安全软件是否拦截，以及安装目录是否允许访问。",
  PRODUCT_DETAIL_RUNTIME_LINK_FAILED: "无法准备本地运行目录。请检查软件数据目录是否可写，然后重试。",
  PRODUCT_DETAIL_STOP_TIMEOUT: "上一次本地组件尚未退出。请稍后重试，软件会等待旧组件关闭后再启动。"
};

export function ProductDetailPage() {
  const [status, setStatus] = useState<ProductDetailStatus>(EMPTY_STATUS);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

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
    void api.status()
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
  const paidAiReady = status.capabilities.paid_ai_ready === true;
  const copy = displayState === "ready"
    ? paidAiReady
      ? {
        title: "服务已就绪，AI 精修已配置",
        description: "DeepSeek 与 APIMart 配置已经接入下方工作台；实际生图前仍会由工作台显示任务并确认。"
      }
      : {
        title: "服务已就绪，AI 精修尚未配置",
        description: "普通上传、排版和导出可以使用；云端智能服务暂不可用时，AI 精修会保留当前工作并提示稍后重试。"
      }
    : STATE_COPY[displayState];
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
      <div className="page-head product-detail-head">
        <div>
          <h1>产品详情图</h1>
          {!canShowWorkspace && <p>上传产品图片，编辑资料，预览并导出详情图。</p>}
        </div>
        <div className="actions product-detail-actions">
          {status.state === "unavailable" && DEVELOPMENT_EDITION && (
            <button className="secondary-button" onClick={() => run("status")} disabled={busy}>
              <RefreshCw size={17} />
              重新检测
            </button>
          )}
          {status.state === "stopped" && (
            <button className="primary-button" onClick={() => run("start")} disabled={busy}>
              <Play size={17} />
              启动产品详情图
            </button>
          )}
          {status.state === "failed" && (
            <button className="primary-button" onClick={() => run("restart")} disabled={busy}>
              <RefreshCw size={17} />
              重试启动
            </button>
          )}
          {status.state === "ready" && (
            <>
              <button className="secondary-button" onClick={() => run("restart")} disabled={busy}>
                <RefreshCw size={17} />
                重新启动
              </button>
              <button className="danger-button" onClick={() => run("stop")} disabled={busy}>
                <Square size={16} />
                停止服务
              </button>
            </>
          )}
          {status.state === "starting" && (
            <button className="danger-button" onClick={() => run("stop")} disabled={busy}>
              <Square size={16} />
              停止启动
            </button>
          )}
        </div>
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
            : displayState === "starting" && status.diagnostics?.phase ? STARTUP_PHASE[status.diagnostics.phase] || copy.description : copy.description}</p>
          {displayState === "failed" && status.code && <p className="product-detail-failure-code">
            故障码：{status.code}
            {status.diagnostics?.phase && <> · {STARTUP_PHASE[status.diagnostics.phase] || "本地启动"}</>}
            {status.diagnostics?.exitCode != null && <> · 退出码 {status.diagnostics.exitCode}</>}
            {status.diagnostics?.stderrType && <> · {status.diagnostics.stderrType}</>}
          </p>}
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

      {status.state === "unavailable" && !loadingStatus && (
        <div className="product-detail-setup">
          {DEVELOPMENT_EDITION ? (
            <>
              <h2>开发接入说明</h2>
              <p>
                开发调试时，请设置环境变量 <code>XIAOXI_PRODUCT_DETAIL_SIDECAR</code>
                指向已打包的运行程序；正式安装包需要由交付流程内置该组件。
              </p>
              <p>当前状态只代表桌面入口已经接通，不代表原有项目已经完成净机打包或测试恢复。</p>
            </>
          ) : (
            <>
              <h2>恢复方式</h2>
              <p>请关闭软件后使用完整安装程序重新安装；如果使用压缩包，请完整解压后再运行，不要只复制主程序。</p>
              <p>仍无法恢复时，请在“日志诊断”导出报告并联系支持。</p>
            </>
          )}
        </div>
      )}

      {canShowWorkspace && (
        <div className="product-detail-workspace">
          <iframe
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
