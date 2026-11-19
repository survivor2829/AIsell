// 场景效果视频: how long is left (customers asked, 2026-11-19). Each step's typical time starts from
// a default and is replaced by the median of the last runs on this computer, so the estimate
// follows the real speed of the image and video services. Waiting for the customer has no estimate.
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./atomic-file.cjs');

const KEEP = 20;
// Seconds. Video: a fixed queue time plus time per second of footage (480P with sound).
const DEFAULTS = Object.freeze({ image: 90, story: 40, videoBase: 150, videoPerSecond: 20, finish: 45, upload: 10 });
const timingsFile = (root) => path.join(root, 'timings.json');
const median = (list) => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; };

function readTimings(root) {
  try {
    const data = JSON.parse(fs.readFileSync(timingsFile(root), 'utf8'));
    return { image: Array.isArray(data.image) ? data.image : [], story: Array.isArray(data.story) ? data.story : [],
      video: Array.isArray(data.video) ? data.video : [], finish: Array.isArray(data.finish) ? data.finish : [] };
  } catch { return { image: [], story: [], video: [], finish: [] }; }
}
// A finished step's real time. Nonsense (negative, or more than two hours) is not kept.
function recordTiming(root, kind, sample) {
  if (!['image', 'story', 'video', 'finish'].includes(kind)) return;
  const seconds = Number(kind === 'video' ? sample?.seconds : sample);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7200) return;
  if (kind === 'video' && !(Number(sample.out) > 0)) return;
  try {
    const data = readTimings(root);
    data[kind] = [...data[kind], kind === 'video' ? { out: Number(sample.out), seconds: Math.round(seconds) } : Math.round(seconds)].slice(-KEEP);
    writeJsonAtomic(timingsFile(root), data);
  } catch { /* An estimate is a convenience; never stop the video for it. */ }
}
function rates(timings) {
  const pick = (list, fallback) => Number.isFinite(median(list)) ? median(list) : fallback;
  const perSecond = median((timings.video || []).map((row) => row.seconds / row.out));
  return { image: pick(timings.image, DEFAULTS.image), story: pick(timings.story, DEFAULTS.story), finish: pick(timings.finish, DEFAULTS.finish),
    video: (out) => Number.isFinite(perSecond) ? Math.max(60, perSecond * out) : DEFAULTS.videoBase + DEFAULTS.videoPerSecond * out };
}
const since = (iso, now) => Number.isFinite(Date.parse(iso)) ? Math.max(0, (now - Date.parse(iso)) / 1000) : 0;
// Shots share a few slots: the queue finishes when the last slot does.
function slotFinish(remaining, slots) {
  const ends = Array(Math.max(1, slots)).fill(0);
  for (const value of remaining) { ends.sort((a, b) => a - b); ends[0] += value; }
  return Math.max(0, ...ends);
}
function shotsLeft(task, r, slots, now) {
  const running = [], queued = [];
  task.shots.forEach((shot, index) => {
    if (shot.file) return;
    const out = task.plan.shots[index].seconds, expected = r.video(out);
    if (shot.providerTaskId) running.push(Math.max(15, expected - since(shot.submittedAt || task.operations?.[`shot_${index}`]?.submittedAt, now)));
    else queued.push(expected);
  });
  return slotFinish([...running, ...queued], slots);
}
function imageLeft(task, key, r, now) {
  const image = task.images?.[key];
  if (image?.file) return 0;
  return image?.taskId ? Math.max(10, r.image - since(task.operations?.[`img_${key}`]?.submittedAt, now)) : r.image;
}
const FINISHING = new Set(['assembling', 'transcribing', 'packaging', 'enhancing']);
function finishLeft(task, r, now, extra = 0) {
  return FINISHING.has(task.status) ? Math.max(5, r.finish + extra - since(task.finishStartedAt, now)) : r.finish + extra;
}

// Seconds left for a running task, or null when none can be given (waiting for the customer, stopped, old kinds).
function estimateTask(task, timings, { now = Date.now(), shotSlots = 3, imageSlots = 4 } = {}) {
  if (!task?.plan || ['draft', 'completed', 'needs_attention', 'outcome_unknown', 'awaiting_sheet'].includes(task.status)) return null;
  const r = rates(timings || {});
  if (task.plan.pipelineVersion === 6) {
    const plate = FINISHING.has(task.status) ? 0 : imageLeft(task, 'plate', r, now);
    const shots = FINISHING.has(task.status) ? 0 : shotsLeft(task, r, shotSlots, now);
    return Math.round(plate + shots + finishLeft(task, r, now));
  }
  if (task.plan.pipelineVersion === 5) {
    if (!task.images?.sheet?.file) return Math.round(DEFAULTS.upload + imageLeft(task, 'sheet', r, now));
    const segments = task.plan.segments;
    let left = 0;
    if (!task.story) left += task.status === 'writing_story' ? Math.max(5, r.story - since(task.operations?.story?.submittedAt, now)) : r.story;
    if (!FINISHING.has(task.status) && !['submitting', 'generating'].includes(task.status)) {
      // Place and both people at once, then the floor and the storyboard frames a few at a time.
      const first = Math.max(...['scene', 'person_a', 'person_b'].map((key) => task.story ? imageLeft(task, key, r, now) : r.image));
      const frames = Array.from({ length: segments * 6 }, (_, i) => `frame_${Math.floor(i / 6)}_${i % 6}`)
        .map((key) => task.story ? imageLeft(task, key, r, now) : r.image).filter((value) => value > 0);
      const floor = task.story ? imageLeft(task, 'floor', r, now) : r.image;
      left += first + Math.max(floor, slotFinish(frames, imageSlots));
    }
    if (!FINISHING.has(task.status)) left += shotsLeft(task, r, shotSlots, now);
    return Math.round(left + finishLeft(task, r, now, 15));
  }
  return null;
}
module.exports = { DEFAULTS, readTimings, recordTiming, estimateTask, rates, slotFinish };
