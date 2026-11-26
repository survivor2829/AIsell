// What 小玺 says about work in progress (user decision 2026-10-30), or null when nothing runs.
// Every feature shows the same live card as 精准触达 (user 2026-11-26: "cleaning friends still looks like
// before; check the other features too"): a fixed title, step = the broad step now (a new step adds a
// line to the card's log of the last three), detail = one line under it, done/total = the bar.
const NURTURE_PHASE = { opening: "打开 Chrome", searching: "搜索行业关键词", watching: "刷视频" };
const PLATFORM = { douyin: "抖音", kuaishou: "快手", xiaohongshu: "小红书", channels: "视频号" };

function nurtureActivity(state) {
  const plan = (state?.plans || []).find((item) => item.id === state?.running);
  if (!plan) return null;
  const counts = plan.today?.counts || {};
  const detail = plan.phase === "watching"
    ? `已看 ${counts.watched || 0} 个视频，赞 ${counts.likes || 0} · 关注 ${counts.follows || 0} · 评 ${counts.comments || 0}` : "";
  return { title: `正在养号 · ${plan.accountLabel || "抖音号"}`, owner: `nurture:${plan.id}`, step: NURTURE_PHASE[plan.phase] || "", detail };
}

function publishActivity(state) {
  const jobs = state?.jobs || [];
  const active = jobs.filter((job) => ["queued", "running", "needs_user", "clicked"].includes(job.status));
  if (!active.length) return null;
  const job = jobs.find((item) => item.id === state.running) || active.find((item) => item.status === "needs_user") || active[0];
  const done = jobs.filter((item) => item.createdAt >= active[active.length - 1].createdAt && !active.includes(item)).length;
  return {
    title: `正在一键分发 · ${PLATFORM[job.platform] || job.platform || ""}`.replace(/ · $/, ""),
    step: job.status === "needs_user" ? "等你完成验证" : job.step || "排队中",
    detail: job.status === "needs_user" ? job.reason || "请在弹出的 Chrome 窗口里完成验证" : job.title || job.videoName || "",
    attention: job.status === "needs_user",
    done, total: done + active.length
  };
}

// Video work in the content engine: what is being made and how far along, from its task list.
const VIDEO_KINDS = [
  [/analysis/, "正在看你的素材"],
  [/cover/, "正在给视频做封面"],
  [/packaging/, "正在给视频做包装"],
  [/^product_/, "正在做场景效果视频"],
  [/course/, "正在做课程视频"],
  [/./, "正在做视频"]
];
const RUNNING_VIDEO = new Set(["queued", "analyzing", "rendering"]);
const VIDEO_STEP = { queued: "排队中", analyzing: "看素材、安排镜头", rendering: "配音和剪辑" };
// Steps a customer waits on as a finished video (not analysis or covers along the way).
const FINISHED_VIDEO = /mix_generation|regeneration|narrated_batch|product_generation|course_generation|guided_auto_mix_draft/;
const videoTitle = (type) => VIDEO_KINDS.find(([pattern]) => pattern.test(String(type || "")))[1];

function videoActivity(items) {
  const running = (items || []).filter((task) => RUNNING_VIDEO.has(task.status));
  if (!running.length) return null;
  const task = running.find((item) => item.status !== "queued") || running[0];
  const percent = Math.round(Math.max(0, Math.min(1, Number(task.progress) || 0)) * 100);
  // Each video starts its own log, so the next task does not inherit the last one's ticked steps.
  return { title: videoTitle(task.task_type), owner: `video:${task.task_id}`, step: VIDEO_STEP[task.status] || "", detail: running.length > 1 ? `还有 ${running.length - 1} 个在排队` : "", done: percent, total: 100 };
}

// One line when a video finished or failed since the last look.
function videoEvents(before, items) {
  const lines = [];
  for (const task of items || []) {
    const was = before.get(task.task_id);
    if (!was || !RUNNING_VIDEO.has(was) || RUNNING_VIDEO.has(task.status)) continue;
    if (task.status === "completed" && FINISHED_VIDEO.test(String(task.task_type || ""))) lines.push({ text: "视频做好啦～", sub: "去成片中心看看吧", mood: "done" });
    else if (task.status === "failed") lines.push({ text: "这条没做成，别着急～", sub: "原因我已经发给技术支持了", mood: "error" });
  }
  return lines.slice(0, 1);
}

// 精准获客: keyword search in Douyin, comment-section leads, and the map.
function acquisitionActivity(channel, state) {
  if (channel === "keyword-acquisition:update") return state?.busy ? { title: "正在用关键词找客户" } : null;
  if (channel === "social-acquisition:update") return state?.running ? { title: "正在评论区里找意向客户" } : null;
  if (channel === "map-acquisition:update") {
    const task = (state?.tasks || []).find((item) => item.status === "running");
    // The message changes for every shop read (第 1 页 · 正在读取第 N 家): that is the detail line; the
    // log keeps the broad step only.
    if (!task) return null;
    const message = String(task.message || "").slice(0, 40);
    return { title: "正在地图上找客户", step: /[0-9]/.test(message) ? "读取地图上的商家" : message, detail: message };
  }
  return undefined;
}

// 产品详情图: what the sidecar's current task is doing, step by step.
function productDetailActivity(report) {
  const state = report?.state, task = report?.task || {};
  if (state !== "pending" && !String(task.status || "").startsWith("running_")) return null;
  const message = String(task.progress_msg || "");
  const title = "正在做产品详情图";
  const owner = task.task_id ? { owner: `productDetail:${task.task_id}` } : {};
  if (task.status === "running_assembler" || /拼接|拼装/.test(message)) return { title, ...owner, step: "拼成长图", detail: "马上就好" };
  if (task.status === "running_recovery") return { title, ...owner, step: "接着做上次的详情图", detail: "已经做好的不会重画" };
  if (task.status === "running_generator") {
    // Only the message counts this round: the task's totals still describe the whole set during a single redo.
    const counted = message.match(/(\d+)\s*\/\s*(\d+)/);
    if (!counted) return /重做/.test(message) ? { title, ...owner, step: "重画这一张", detail: "其他图片不动" } : { title, ...owner, step: "开始动笔画", detail: "一张一张认真画" };
    const total = Number(counted[2]), finished = Math.min(total, Number(counted[1]));
    return { title, ...owner, step: `画第 ${Math.min(total, finished + 1)}/${total} 张`, detail: "一张一张认真画", done: finished, total };
  }
  return { title, ...owner, step: "琢磨这款产品的卖点", detail: "想清楚客户最在意什么，再动笔" };
}
function productDetailEvent(before, report) {
  if (!before) return null;
  // A result nobody can confirm needs the customer, so it is said once and never shown as work still going on.
  if (report?.state === "outcome_unknown") return { text: "这次详情图的结果还不确定", sub: "打开详情图页面核对一下，不会重复扣费", mood: "error" };
  if (report?.state === "partial_success") return { text: "详情图做好了，有几张没画成", sub: "打开详情图页面看看", mood: "error" };
  if (!["failed", "recovery_required", "pricing_required"].includes(report?.state)) return null;
  return { text: "这次详情图没做完，别着急～", sub: "已完成的部分保留着，打开软件可以接着做", mood: "error" };
}

const VIRAL_STAGE = { collect: "搜索爆款视频", comments: "读评论、核对作者", blocked: "平台拦了一下，换下一个" };
const GEO_BUSY = { writing: ["写 GEO 文章", "大约要一分钟"], publish: ["把文章发到媒体号", "结果以平台页面为准"], visibility: ["在豆包里查有没有提到你", ""] };
// Only statuses where the software is really working: a task waiting for the customer must not look busy.
const WORKING_TASK = new Set(["imaging", "directing", "writing_story", "composing", "uploading", "preparing_frames", "frame_generating", "locking_frames", "preparing_audio", "submitting", "generating", "assembling", "enhancing", "transcribing",
  "audio_preparing", "video_submitting", "video_generating", "packaging"]);
// Paid video services keep their own task list; this reads the one in progress.
function serviceActivity(title, items) {
  const task = (items || []).find((item) => WORKING_TASK.has(item.status));
  if (!task) return null;
  const percent = Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0)));
  const eta = Number(task.etaSeconds), left = Number.isFinite(eta) && eta > 0 ? `还要约 ${Math.max(1, Math.round(eta / 60))} 分钟` : "";
  const owner = task.id ? { owner: `service:${task.id}` } : {};
  return { title, ...owner, step: String(task.statusLabel || ""), detail: left, ...(percent ? { done: percent, total: 100 } : {}) };
}
function pushedActivity(channel, state) {
  if (channel === "geo:update") {
    const busy = GEO_BUSY[state?.busy];
    return busy ? { title: "正在做 GEO 推广", step: busy[0], detail: busy[1] } : null;
  }
  if (channel === "moments-publish:update") return state?.status === "publishing" ? { title: "正在发朋友圈", detail: "发完我会核对一遍" } : null;
  if (channel === "moments-campaign:update") {
    if (state?.status !== "running") return null;
    return { title: "正在给朋友圈点赞评论", step: state.current_post ? `第 ${state.current_post} 条` : "" };
  }
  if (channel === "digital-human:viral-progress") {
    // Searching and reading comments name the item in their message: the log keeps the stage only.
    return state?.stage && state.stage !== "done"
      ? { title: "正在全网找爆款文案", step: VIRAL_STAGE[state.stage] || "", detail: String(state.message || "").slice(0, 40) } : null;
  }
  if (channel === "digital-human:viral-pipeline") {
    const job = (state?.items || []).find((item) => item.status === "running") || (state?.items || []).find((item) => item.status === "queued");
    if (!job) return null;
    return { title: "正在一键成片", owner: `viral-pipeline:${job.id || ""}`, step: String(job.message || "").replace(/^正在/, "").slice(0, 40), detail: String(job.title || "").slice(0, 40),
      ...(job.progress ? { done: Math.round(job.progress), total: 100 } : {}) };
  }
  return acquisitionActivity(channel, state);
}

// Every long-running feature and where its progress comes from (SOP: a new one must be added here).
const SPRITE_FEATURES = [
  { feature: "微信触达/加好友/朋友圈工作流", source: "wechat-workflow 自身的任务状态" },
  { feature: "清理无效好友（微信里删除）", source: "wechat-workflow setExternalActivity: contactCleanup" },
  { feature: "发朋友圈", channel: "moments-publish:update" },
  { feature: "单独点赞评论", channel: "moments-campaign:update" },
  { feature: "养号", source: "onState: nurtureActivity" },
  { feature: "一键分发", source: "onState: publishActivity" },
  { feature: "手机矩阵", source: "onActivity" },
  { feature: "短视频成片", source: "poll: content engine" },
  { feature: "产品详情图", source: "poll: /internal/refine-activity" },
  { feature: "场景效果视频", source: "poll: product video service" },
  { feature: "本人口播", source: "poll: reference human service" },
  { feature: "GEO推广", channel: "geo:update" },
  { feature: "爆款文案扒取", channel: "digital-human:viral-progress" },
  { feature: "一键成片", channel: "digital-human:viral-pipeline" },
  { feature: "关键词获客", channel: "keyword-acquisition:update" },
  { feature: "评论区获客", channel: "social-acquisition:update" },
  { feature: "地图获客", channel: "map-acquisition:update" }
];
// Messages that exist but are not work a customer is waiting on, or that report through another row above.
const SPRITE_NOT_WORK = new Set(["account:changed", "account:trial-blocked", "cloud:update", "feedback:update", "official-materials:searchUpdate", "role-preferences:update", "social-accounts:update", "tutorials:progress",
  "window-chrome:shown", "wechat-workflow:navigate", "wechat-workflow:update", "wechat-workflow:sprite-cursor", "wechat-workflow:sprite-drag", "wechat-workflow:sprite-say", "wechat-workflow:sprite-dock",
  "touch-task:update", "social-nurture:update", "social-publish:update"]);
// Files that build the channel name at run time, and what they send.
const SPRITE_COMPUTED_SENDERS = new Set([
  "business-workbench-ipc.cjs", // 关键词/评论区/地图获客，见 SPRITE_FEATURES
  "phone-matrix-ipc.cjs", // 手机矩阵，走 onActivity
  "product-detail-download.cjs", // 保存图片的结果，不是耗时任务
  "content-engine-ipc.cjs", // 短视频成片，走 poll
  "product-detail-ipc.cjs" // 详情图窗口状态，进度走 /internal/refine-activity
]);

module.exports = { SPRITE_COMPUTED_SENDERS, nurtureActivity, publishActivity, videoActivity, videoEvents, acquisitionActivity, productDetailActivity, productDetailEvent, serviceActivity, pushedActivity, SPRITE_FEATURES, SPRITE_NOT_WORK };
