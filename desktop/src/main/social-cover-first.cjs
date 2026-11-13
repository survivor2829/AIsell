const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { withH264Encoder } = require("./h264-encoder.cjs");

// 抖音/快手/小红书 show the first frame of an uploaded video as its cover unless the
// user picks another one. A copy of the finished video that opens with its cover
// (a blink, 0.1 s) carries the cover without driving each platform's cover editor;
// 视频号 keeps its own cover upload. The copy is made at publish time, not at render
// time, because the AI cover lands (and can be redone) after the video is finished.
const COVER_SECONDS = 0.1;
// Bump when the output changes, so copies made the old way are not reused.
const FORMAT = 1;
const KEEP = 30;

const ffprobeNextTo = (ffmpegPath) => path.basename(ffmpegPath) === ffmpegPath
  ? (process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
  : path.join(path.dirname(ffmpegPath), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");

function frameRate(value) {
  const [n, d] = String(value || "").split("/").map(Number);
  const rate = d ? n / d : n;
  return Number.isFinite(rate) && rate >= 10 && rate <= 120 ? Math.round(rate * 1000) / 1000 : 30;
}

// The ffmpeg arguments, without encoder and output, for a video that opens with `cover`.
function coverFirstArgs({ video, cover, width, height, fps, audio, seconds = COVER_SECONDS }) {
  const w = width, h = height;
  const graph = [
    // The cover fills the frame without cropping its text: a blurred, enlarged copy behind it.
    `[1:v]split[cb][cf]`,
    `[cb]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=40[bg]`,
    `[cf]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${fps},setsar=1,format=yuv420p[cv]`,
    `[0:v]setsar=1,format=yuv420p[mv]`
  ];
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", video,
    "-loop", "1", "-framerate", String(fps), "-t", String(seconds), "-i", cover];
  if (audio) {
    // Silence under the cover keeps sound and picture in step.
    args.push("-f", "lavfi", "-t", String(seconds), "-i", `anullsrc=r=${audio.sampleRate}:cl=${audio.layout}`);
    graph.push(`[cv][2:a][mv][0:a]concat=n=2:v=1:a=1[v][a]`);
    return [...args, "-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"];
  }
  graph.push(`[cv][mv]concat=n=2:v=1:a=0[v]`);
  return [...args, "-filter_complex", graph.join(";"), "-map", "[v]"];
}

function createCoverFirst({ dir, ffmpegPath = "ffmpeg", run = execFile, encoders = withH264Encoder, timeoutMs = 10 * 60_000, keep = KEEP }) {
  const exec = (file, args) => new Promise((resolve, reject) => {
    run(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout || "")));
  });
  async function probe(video) {
    const info = JSON.parse(await exec(ffprobeNextTo(ffmpegPath), ["-v", "error", "-show_streams", "-of", "json", video]));
    const streams = Array.isArray(info?.streams) ? info.streams : [];
    const v = streams.find((s) => s.codec_type === "video"), a = streams.find((s) => s.codec_type === "audio");
    if (!v || !(v.width > 0) || !(v.height > 0)) throw new Error("no video stream");
    // Even sizes: yuv420p and H.264 need them.
    const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
    const rotated = [90, 270].includes(Math.abs(Number(v.tags?.rotate || v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0)) % 360);
    return {
      width: even(rotated ? v.height : v.width), height: even(rotated ? v.width : v.height), fps: frameRate(v.avg_frame_rate || v.r_frame_rate),
      audio: a ? { sampleRate: Number(a.sample_rate) || 44100, layout: Number(a.channels) === 1 ? "mono" : "stereo" } : null
    };
  }
  // The cover by its content (small, and redone covers can keep size and time); the video by size and time.
  function keyOf(video, cover) {
    const stat = fs.statSync(video, { bigint: true });
    const coverHash = crypto.createHash("sha256").update(fs.readFileSync(cover)).digest("hex");
    return crypto.createHash("sha256").update(JSON.stringify([FORMAT, COVER_SECONDS, path.resolve(video), String(stat.size), String(stat.mtimeNs), coverHash])).digest("hex").slice(0, 32);
  }
  // Oldest copies go first; the one just made or reused always stays.
  function prune(current) {
    let files;
    try { files = fs.readdirSync(dir).filter((name) => /\.mp4$/i.test(name)).map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs })); }
    catch { return; }
    files.sort((x, y) => y.at - x.at);
    for (const file of files.slice(keep)) if (path.join(dir, file.name) !== current) fs.rmSync(path.join(dir, file.name), { force: true });
  }
  const pending = new Map();
  // The path of a copy of `video` that opens with `cover`; made once, reused for every account.
  async function prepare(video, cover) {
    const key = keyOf(video, cover), target = path.join(dir, `${key}.mp4`);
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      if (fs.existsSync(target) && fs.statSync(target).size > 0) {
        const now = new Date(); try { fs.utimesSync(target, now, now); } catch { /* Only affects which copy is pruned first. */ }
        return target;
      }
      fs.mkdirSync(dir, { recursive: true });
      const shape = await probe(video);
      const partial = path.join(dir, `${key}.part.mp4`);
      fs.rmSync(partial, { force: true });
      try {
        await encoders(ffmpegPath, (encoder) => exec(ffmpegPath, [...coverFirstArgs({ video, cover, ...shape }), ...encoder, "-pix_fmt", "yuv420p", "-movflags", "+faststart", partial]));
        if (!fs.existsSync(partial) || !fs.statSync(partial).size) throw new Error("empty output");
        fs.renameSync(partial, target);
      } finally { fs.rmSync(partial, { force: true }); }
      prune(target);
      return target;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  return { prepare };
}

module.exports = { createCoverFirst, coverFirstArgs, COVER_SECONDS };
