// What 小玺 says about automation running in Chrome (user decision 2026-10-30): one line on what is
// running and one detail, or null when nothing runs.
const NURTURE_PHASE = { opening: "正在打开 Chrome", searching: "正在搜索行业关键词", watching: "正在刷视频" };
const PLATFORM = { douyin: "抖音", kuaishou: "快手", xiaohongshu: "小红书", channels: "视频号" };

function nurtureActivity(state) {
  const plan = (state?.plans || []).find((item) => item.id === state?.running);
  if (!plan) return null;
  const counts = plan.today?.counts || {};
  const detail = plan.phase === "watching"
    ? `已看 ${counts.watched || 0} 个视频，赞 ${counts.likes || 0} · 关注 ${counts.follows || 0} · 评 ${counts.comments || 0}`
    : NURTURE_PHASE[plan.phase] || "";
  return { title: `正在养号 · ${plan.accountLabel || "抖音号"}`, detail };
}

function publishActivity(state) {
  const jobs = state?.jobs || [];
  const active = jobs.filter((job) => ["queued", "running", "needs_user", "clicked"].includes(job.status));
  if (!active.length) return null;
  const job = jobs.find((item) => item.id === state.running) || active.find((item) => item.status === "needs_user") || active[0];
  const done = jobs.filter((item) => item.createdAt >= active[active.length - 1].createdAt && !active.includes(item)).length;
  return {
    title: `正在一键分发 · ${PLATFORM[job.platform] || job.platform || ""}`.replace(/ · $/, ""),
    detail: job.status === "needs_user" ? job.reason || "请在弹出的 Chrome 窗口里完成验证" : `${job.step || "排队中"} · ${job.title || job.videoName || ""}`.replace(/ · $/, ""),
    attention: job.status === "needs_user",
    done, total: done + active.length
  };
}

// Video work in the content engine: what is being made and how far along, from its task list.
const VIDEO_KINDS = [
  [/analysis/, "正在看你的素材"],
  [/cover/, "正在给视频做封面"],
  [/packaging/, "正在给视频做包装"],
  [/^product_/, "正在做产品效果视频"],
  [/course/, "正在做课程视频"],
  [/./, "正在做视频"]
];
const RUNNING_VIDEO = new Set(["queued", "analyzing", "rendering"]);
// Steps a customer waits on as a finished video (not analysis or covers along the way).
const FINISHED_VIDEO = /mix_generation|regeneration|narrated_batch|product_generation|course_generation|guided_auto_mix_draft/;
const videoTitle = (type) => VIDEO_KINDS.find(([pattern]) => pattern.test(String(type || "")))[1];

function videoActivity(items) {
  const running = (items || []).filter((task) => RUNNING_VIDEO.has(task.status));
  if (!running.length) return null;
  const task = running.find((item) => item.status !== "queued") || running[0];
  const percent = Math.round(Math.max(0, Math.min(1, Number(task.progress) || 0)) * 100);
  return { title: videoTitle(task.task_type), detail: running.length > 1 ? `还有 ${running.length - 1} 个在排队` : "", done: percent, total: 100 };
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
    return task ? { title: "正在地图上找客户", detail: String(task.message || "").slice(0, 40) } : null;
  }
  return undefined;
}

module.exports = { nurtureActivity, publishActivity, videoActivity, videoEvents, acquisitionActivity };
