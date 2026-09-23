const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { createDigitalHumanProvider, cleanMessage, fail, remoteUrl } = require("./digital-human-provider.cjs");
const { planVideo, SCENES, SURFACES, DIRT, GOALS, USD_PER_SECOND_480P } = require("./video-directors.cjs");
const { upscaleTo1080Size } = require('./video-upscale.cjs');

const TASK_ID = /^pv_[a-f0-9-]{36}$/u;
const IMAGE_ID = /^pva_[a-f0-9-]{36}$/u;
const RUNNING = new Set(["uploading", "submitting", "generating", "assembling", "enhancing"]);
const LABELS = {
  draft: "待确认分镜", uploading: "上传产品图", submitting: "提交镜头",
  generating: "生成镜头", assembling: "合成视频", enhancing: "本地放大画面", completed: "成片已就绪",
  needs_attention: "需要处理", outcome_unknown: "请求待核对"
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function contained(root, relative) {
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw fail("product_video_path_invalid", "任务文件路径无效。");
  return full;
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw fail("product_video_image_invalid", "请使用 JPG、PNG 或 WebP 产品图片。");
}
function createProductVideoService(options = {}) {
  const root = path.resolve(options.rootDir || "");
  if (!options.rootDir || root === path.parse(root).root) throw fail("product_video_storage_invalid", "视频存储目录无效。");
  const provider = options.provider || createDigitalHumanProvider(options);
  const active = new Map(), timers = new Map();
  let closed = false;
  const file = (id) => {
    if (!TASK_ID.test(String(id || ""))) throw fail("product_video_not_found", "没有找到这条视频任务。");
    return contained(root, `${id}/task.json`);
  };
  function read(id) {
    let task;
    try { task = JSON.parse(fs.readFileSync(file(id), "utf8")); }
    catch { throw fail("product_video_not_found", "视频任务无法读取，原文件已保留。"); }
    if (task.version !== 1 || task.id !== id) throw fail("product_video_data_invalid", "视频任务格式无法识别。");
    return task;
  }
  function save(task) { task.updatedAt = new Date().toISOString(); writeJsonAtomic(file(task.id), task); }
  function publicTask(task) {
    return {
      id: task.id, mode: task.mode, status: task.status, statusLabel: LABELS[task.status] || "需要处理",
      createdAt: task.createdAt, updatedAt: task.updatedAt, durationSeconds: task.durationSeconds,
      sceneId: task.sceneId, surfaceId: task.surfaceId, dirtId: task.dirtId, goalId: task.goalId,
      expression: task.expression, facts: task.facts, imageId: task.imageId,
      plan: task.plan, currentShot: task.currentShot, completedShots: task.shots.filter((shot) => shot.file).length,
      error: cleanMessage(task.error || ""), errorCode: task.errorCode || "", resumeStatus: task.resumeStatus || "",
      canRetry: task.status === "needs_attention", canExport: task.status === "completed",
      canPreview: task.status === "completed" && Boolean(task.finalFile)
    };
  }
  function list() {
    if (!fs.existsSync(root)) return { items: [] };
    return { items: fs.readdirSync(root).filter((name) => TASK_ID.test(name))
      .map((id) => publicTask(read(id))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }
  function asset(id) {
    if (!IMAGE_ID.test(String(id || ""))) throw fail("product_video_image_missing", "请先上传产品图。");
    let entry;
    try { entry = JSON.parse(fs.readFileSync(contained(root, `assets/${id}.json`), "utf8")); }
    catch { throw fail("product_video_image_missing", "产品图片无法读取，请重新选择。"); }
    const bytes = fs.readFileSync(contained(root, entry.relativePath));
    if (digest(bytes) !== entry.sha256) throw fail("product_video_image_changed", "产品图片已变化，请重新选择。");
    return { ...entry, bytes, path: contained(root, entry.relativePath) };
  }
  function importImage(source) {
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw fail("product_video_image_size", "请选择不超过 20MB 的产品图。");
    const bytes = fs.readFileSync(source), mime = imageMime(bytes), id = `pva_${randomUUID()}`;
    const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[mime];
    const relativePath = `assets/${id}${ext}`;
    fs.mkdirSync(contained(root, "assets"), { recursive: true });
    fs.writeFileSync(contained(root, relativePath), bytes, { flag: "wx" });
    writeJsonAtomic(contained(root, `assets/${id}.json`), { id, name: path.basename(source), mime, relativePath, sha256: digest(bytes) });
    return { id, name: path.basename(source), previewDataUrl: options.imageThumbnail
      ? options.imageThumbnail(bytes) : `data:${mime};base64,${bytes.toString("base64")}` };
  }
  function create(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["mode", "durationSeconds", "sceneId", "surfaceId", "dirtId", "goalId", "expression", "facts", "imageId"].includes(key))) {
      throw fail("product_video_invalid_input", "请重新填写视频需求。");
    }
    asset(input.imageId);
    const plan = planVideo(input);
    const id = `pv_${randomUUID()}`, createdAt = new Date().toISOString();
    const task = { ...input, id, createdAt, updatedAt: createdAt, version: 1, status: "draft",
      expression: String(input.expression || "").trim().slice(0, 400),
      facts: String(input.facts || "").trim().slice(0, 400),
      plan, currentShot: 0, shots: plan.shots.map(() => ({})), operations: {} };
    save(task);
    return publicTask(task);
  }
  async function capabilities() {
    const choices = { scenes: SCENES, surfaces: SURFACES, dirt: DIRT, goals: GOALS, videoPricePerSecondUsd: USD_PER_SECOND_480P };
    if (!options.gatewayClient?.isEnabled?.()) return { ...choices, ready: false, message: "视频生成服务暂不可用，仍可先保存分镜。" };
    const state = await options.gatewayClient.initialize({ verify: true });
    return { ...choices, ready: Boolean(state.ready && state.capabilities?.apimart && state.capabilities?.apimart_video),
      message: state.ready && state.capabilities?.apimart_video ? "" : "视频生成接口暂未连接，仍可先保存分镜。",
    };
  }
  async function operation(task, name, route, body, headers = {}) {
    const prior = task.operations[name];
    if (prior?.response) return prior.response;
    if (prior && !prior.rejected) {
      let receipt;
      try { receipt = await provider.request(`/operations/${prior.id}`); }
      catch { throw fail("product_video_submission_unknown", "上次请求尚未核实，不会自动重复付费提交。", { outcomeUnknown: true }); }
      if (receipt?.status === "pending") throw fail("product_video_submission_unknown", "云端请求仍待核实。", { outcomeUnknown: true });
      prior.response = receipt; save(task); return receipt;
    }
    const entry = { id: randomUUID(), submittedAt: new Date().toISOString() };
    task.operations[name] = entry; save(task);
    try {
      entry.response = await provider.request(route, { method: "POST", body, headers, operationId: entry.id });
      save(task); return entry.response;
    } catch (error) {
      if (!error.outcomeUnknown) { entry.rejected = true; save(task); }
      throw error;
    }
  }
  async function requireProvider() {
    const status = await capabilities();
    if (!status.ready) throw fail("product_video_provider_unavailable", status.message);
  }
  async function upload(task) {
    if (task.imageUrl) return;
    const request = provider.imageUploadBody(asset(task.imageId).path);
    const payload = await operation(task, "upload_image", "/apimart/uploads/images", request.body, request.headers);
    task.imageUrl = remoteUrl(provider.nodeOf(payload).url || payload.url);
    save(task);
  }
  async function assemble(task) {
    const ffmpeg = options.ffmpegPath || process.env.XIAOXI_FFMPEG_PATH || "ffmpeg";
    const lines = task.shots.map((shot) => `file '${contained(root, shot.file).replace(/\\/gu, "/").replace(/'/gu, "'\\''")}'`);
    const manifest = contained(root, `${task.id}/clips.txt`);
    fs.writeFileSync(manifest, lines.join("\n") + "\n", "utf8");
    const is480 = task.plan.sourceResolution === '480p';
    const destination = contained(root, `${task.id}/${is480 ? 'source-480p' : 'final'}.mp4`);
    if (options.assembleVideo) await options.assembleVideo({ manifest, destination, shots: task.shots.map((shot) => contained(root, shot.file)) });
    else await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
        "-i", manifest, "-c", "copy", destination], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let errorText = "";
      child.stderr.on("data", (chunk) => { errorText = (errorText + chunk.toString()).slice(-1000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(errorText || `FFmpeg ${code}`)));
    });
    if (fs.statSync(destination).size < 1024) throw fail("product_video_assemble_failed", "合成文件为空。");
    if (is480) { task.sourceFile = `${task.id}/source-480p.mp4`; task.status = 'enhancing'; }
    else { task.finalFile = `${task.id}/final.mp4`; task.status = 'completed'; }
    save(task);
  }
  async function enhance(task) {
    const source = contained(root, task.sourceFile);
    const destination = contained(root, `${task.id}/final.mp4`);
    await (options.enhanceVideo || upscaleTo1080Size)({ source, destination,
      ffmpegPath: options.ffmpegPath || process.env.XIAOXI_FFMPEG_PATH || 'ffmpeg' });
    if (!fs.existsSync(destination) || fs.statSync(destination).size < 1024) throw fail('product_video_enhance_failed', '本地放大未完成，480p 原片已保留，可以继续处理。');
    task.finalFile = `${task.id}/final.mp4`; task.status = 'completed'; save(task);
  }
  async function advance(task) {
    if (task.status === "uploading") {
      await requireProvider(); await upload(task); task.status = "submitting"; save(task);
    }
    if (task.status === "submitting") {
      const index = task.currentShot;
      const shot = task.plan.shots[index];
      const response = await operation(task, `shot_${index}`, "/apimart/videos/generations", {
        model: "seedance-2.5", duration: shot.seconds, resolution: task.plan.sourceResolution || "1080p", size: "9:16",
        output_format: "mp4", generate_audio: true, image_urls: [task.imageUrl], prompt: shot.prompt
      });
      task.shots[index].providerTaskId = provider.taskIdOf(response);
      task.status = "generating"; save(task);
    }
    if (task.status === "generating") {
      const index = task.currentShot, shot = task.shots[index];
      const payload = await provider.request(`/apimart/tasks/${shot.providerTaskId}?language=en`);
      const node = provider.nodeOf(payload), status = String(node.status || "").toLowerCase();
      if (["failed", "rejected", "cancelled", "canceled"].includes(status)) {
        throw fail("product_video_shot_failed", cleanMessage(node.error?.message || node.error || "镜头生成失败，可单独重做。"));
      }
      if (!["completed", "succeeded", "success"].includes(status)) return;
      const relative = `${task.id}/shot-${index}.mp4`;
      await provider.download(provider.resultUrl(payload, "videos"), contained(root, relative));
      const downloaded = fs.readFileSync(contained(root, relative));
      if (downloaded.length < 1024 || downloaded.toString("ascii", 4, 8) !== "ftyp") {
        throw fail("product_video_download_invalid", "镜头文件不是有效的视频，请检查服务端结果后重试。");
      }
      shot.file = relative; shot.providerTaskId = "";
      task.currentShot += 1;
      task.status = task.currentShot < task.shots.length ? "submitting" : "assembling";
      save(task);
    }
    if (task.status === "assembling") await assemble(task);
    if (task.status === 'enhancing') await enhance(task);
  }
  function pause(task, error) {
    task.resumeStatus = task.status;
    task.status = error.outcomeUnknown ? "outcome_unknown" : "needs_attention";
    task.error = cleanMessage(error.message || "视频任务需要处理。");
    task.errorCode = error.code || "product_video_step_failed";
    save(task);
  }
  function schedule(id) {
    if (closed || active.has(id)) return;
    const promise = Promise.resolve().then(async () => {
      const task = read(id);
      if (!RUNNING.has(task.status)) return;
      try { await advance(task); }
      catch (error) { pause(task, error); }
    }).finally(() => {
      active.delete(id);
      if (!closed) {
        const current = read(id);
        if (RUNNING.has(current.status)) timers.set(id, setTimeout(() => { timers.delete(id); schedule(id); }, 8_000));
      }
    });
    active.set(id, promise);
    void promise.catch(() => {});
  }
  function start(id) {
    const task = read(id);
    if (task.status !== "draft") throw fail("product_video_already_started", "这条视频已经开始制作。");
    task.status = "uploading"; save(task); schedule(id); return publicTask(task);
  }
  function retryShot(id) {
    const task = read(id);
    if (task.status !== "needs_attention") throw fail("product_video_retry_unavailable", "当前任务不能重做镜头。");
    if (task.resumeStatus === "generating" && task.errorCode === "product_video_shot_failed") {
      delete task.operations[`shot_${task.currentShot}`];
      task.shots[task.currentShot] = {};
      task.status = "submitting";
    } else task.status = task.resumeStatus;
    task.error = ""; task.errorCode = ""; save(task); schedule(id);
    return publicTask(task);
  }
  function refresh(id) { const task = read(id); if (RUNNING.has(task.status)) schedule(id); return publicTask(task); }
  function media(id) {
    const task = read(id);
    if (task.status !== "completed" || !task.finalFile) throw fail("product_video_not_ready", "成片尚未就绪。");
    const stat = fs.statSync(contained(root, task.finalFile));
    if (stat.size > 70 * 1024 * 1024) throw fail("product_video_preview_too_large", "成片较大，请直接导出观看。");
    return { dataUrl: `data:video/mp4;base64,${fs.readFileSync(contained(root, task.finalFile)).toString("base64")}` };
  }
  async function exportVideo(id, destination) {
    const task = read(id);
    if (task.status !== "completed" || !task.finalFile) throw fail("product_video_not_ready", "成片尚未就绪。");
    await fsp.copyFile(contained(root, task.finalFile), destination);
    const timecode = (seconds) => `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")},000`;
    const subtitles = task.plan.shots.map((shot, index) => `${index + 1}\n${timecode(index * 15)} --> ${timecode((index + 1) * 15)}\n${shot.narration}\n`).join("\n");
    const subtitlePath = destination.replace(/\.mp4$/iu, "") + ".srt";
    await fsp.writeFile(subtitlePath, `\uFEFF${subtitles}`, "utf8");
    return { path: destination, subtitlePath, sendText: task.plan.sendText };
  }
  function close() { closed = true; for (const timer of timers.values()) clearTimeout(timer); }
  return { capabilities, importImage, create, list, get: (id) => publicTask(read(id)),
    start, retryShot, refresh, media, exportVideo, close };
}
module.exports = { createProductVideoService };
