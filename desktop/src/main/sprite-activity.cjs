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

module.exports = { nurtureActivity, publishActivity };
