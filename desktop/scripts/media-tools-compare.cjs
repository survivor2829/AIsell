"use strict";
// Before a new FFmpeg replaces the bundled one: run every JS media path the app uses with both
// builds on the same inputs, and compare (success, stream parameters, picture PSNR, decoded audio).
// Also compares everything each build provides (encoders, filters, formats...).
//
//   node scripts/media-tools-compare.cjs --old <old bin dir> --new <new bin dir>
//        [--sample <phone or camera video>]...  [--out <work dir>]
//
// Pass real customer-like footage with --sample (a DJI 10-bit HEVC clip found the 1.2.62 problem
// class). Used for n9.0.2-45 -> n9.0.2-58 on 2026-11-20: every output identical. The content engine
// is covered by its own tests: run them with XIAOXI_FFMPEG_PATH / XIAOXI_FFPROBE_PATH set to each
// build and compare the results test by test. See docs/internal-release.md.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const desktop = path.resolve(__dirname, "..");
function parseArgs(argv) {
  const options = { samples: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value) throw new Error(`${flag} needs a value`);
    if (flag === "--old") options.old = path.resolve(value);
    else if (flag === "--new") options.new = path.resolve(value);
    else if (flag === "--sample") options.samples.push(path.resolve(value));
    else if (flag === "--out") options.out = path.resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!options.old || !options.new) throw new Error("--old and --new are required (folders holding ffmpeg.exe and ffprobe.exe)");
  options.out ||= fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-media-compare-"));
  return options;
}

const tool = (bin, name) => path.join(bin, `${name}.exe`);
const sh = (file, args) => execFileSync(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function capabilityDiff(oldBin, newBin) {
  const lines = [];
  for (const kind of ["encoders", "decoders", "filters", "muxers", "demuxers", "protocols", "bsfs", "pix_fmts", "hwaccels"]) {
    const read = (bin) => new Set(sh(tool(bin, "ffmpeg"), ["-hide_banner", `-${kind}`]).toString().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
    const a = read(oldBin), b = read(newBin);
    const removed = [...a].filter((line) => !b.has(line)), added = [...b].filter((line) => !a.has(line));
    lines.push(`${removed.length || added.length ? "DIFF" : "same"} ${kind}${removed.map((line) => `\n    - ${line}`).join("")}${added.map((line) => `\n    + ${line}`).join("")}`);
  }
  return lines;
}

function makeInputs(oldBin, dir, samples) {
  fs.mkdirSync(dir, { recursive: true });
  const speechy = "sine=frequency=220:sample_rate=48000:duration=12,volume='0.6+0.4*sin(2*PI*3*t)':eval=frame";
  const gen = (name, args) => { const out = path.join(dir, name); if (!fs.existsSync(out)) sh(tool(oldBin, "ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", ...args, out]); return out; };
  const inputs = {
    videos: {
      phone: gen("phone-1080x1920-60fps.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=60:duration=12", "-f", "lavfi", "-i", speechy,
        "-c:v", "h264_mf", "-rate_control", "quality", "-quality", "70", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest"]),
      mov: gen("camera.mov", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12", "-f", "lavfi", "-i", speechy,
        "-c:v", "mpeg4", "-q:v", "4", "-c:a", "pcm_s16le", "-shortest"])
    },
    tts: gen("tts.wav", ["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=24000:duration=6,volume='0.5+0.5*sin(2*PI*2*t)':eval=frame", "-ac", "1"]),
    cover: gen("cover.jpg", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=1:duration=1", "-frames:v", "1"]),
    clip: gen("clip-480p.mp4", ["-f", "lavfi", "-i", "testsrc2=size=480x854:rate=24:duration=5", "-f", "lavfi", "-i", speechy,
      "-c:v", "h264_mf", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-t", "5"])
  };
  samples.forEach((sample, index) => { inputs.videos[`sample${index + 1}`] = sample; });
  return inputs;
}

async function runAll(label, bin, inputs, root) {
  const out = path.join(root, label); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  for (const id of Object.keys(require.cache)) if (id.includes(`${path.sep}src${path.sep}main${path.sep}`)) delete require.cache[id];
  const main = (name) => require(path.join(desktop, "src", "main", name));
  const enc = main("h264-encoder.cjs"), ref = main("reference-human-media.cjs"), dha = main("digital-human-audio.cjs");
  const up = main("video-upscale.cjs"), big = main("bigtype-cover.cjs"), cov = main("social-cover-first.cjs"), media = main("product-video-media.cjs");
  const ffmpeg = tool(bin, "ffmpeg"), results = {};
  const step = async (name, fn) => {
    const started = Date.now();
    try { const value = await fn(); results[name] = { ok: true, ms: Date.now() - started, value }; }
    catch (error) { results[name] = { ok: false, error: String(error.message || error).slice(0, 300) }; }
  };
  await step("encoders.final", async () => (await enc.h264Encoders(ffmpeg)).map((e) => e.name));
  await step("encoders.reference", async () => (await enc.h264Encoders(ffmpeg, { profile: "reference" })).map((e) => e.name));
  for (const [key, video] of Object.entries(inputs.videos)) {
    await step(`digitalHumanUpload.${key}`, async () => { const r = await ref.prepareReference(video, path.join(out, `ref-${key}`), ffmpeg);
      return { seconds: r.seconds, width: r.width, height: r.height, fps: r.fps, codec: r.videoCodec }; });
  }
  const refVideo = path.join(out, "ref-phone", "reference.mp4");
  await step("framePreview", async () => (await ref.framePreview(refVideo, 1, ffmpeg)).length > 1000);
  await step("freezeDrivenVideo", async () => { await ref.freezeDrivenVideo(refVideo, inputs.tts, path.join(out, "driven.mp4"), 5, ffmpeg); return true; });
  await step("dh.cutAudio", async () => (await dha.cutAudio({ source: inputs.tts, destination: path.join(out, "cut.wav"), startSeconds: 1, seconds: 3, ffmpegPath: ffmpeg })).seconds);
  await step("dh.createAsrCopy", async () => (await dha.createAsrCopy({ source: inputs.tts, destination: path.join(out, "asr.wav"), ffmpegPath: ffmpeg })).seconds);
  await step("dh.freezeAudio", async () => (await dha.freezeAudio({ segments: [{ audioPath: inputs.tts }, { audioPath: path.join(out, "cut.wav") }], destination: path.join(out, "frozen.wav"), ffmpegPath: ffmpeg, preserveNativeRate: true })).seconds);
  await step("dh.assemble", async () => { await dha.assemble({ segments: [{ videoPath: refVideo, audioPath: inputs.tts, seconds: 6, allowNaturalPauses: true }, { videoPath: refVideo, audioPath: inputs.tts, seconds: 6, allowNaturalPauses: true }],
    destination: path.join(out, "avatar.mp4"), audioDestination: inputs.tts, ffmpegPath: ffmpeg }); return true; });
  await step("upscale1080", async () => { await up.upscaleTo1080Size({ source: inputs.clip, destination: path.join(out, "upscaled.mp4"), ffmpegPath: ffmpeg }); return true; });
  const font = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"].find((file) => fs.existsSync(file));
  if (font) await step("bigtypeCover", async () => { await big.renderBigtypeCover({ ffmpegPath: ffmpeg, source: refVideo, seconds: 1, sourceSize: { width: 1080, height: 1920 }, face: null,
    title: "洗地机器人一趟洗一大片", subtitle: "工厂仓储实拍", tags: ["自动避障", "洗完即干"], fontFile: font, target: path.join(out, "bigtype.jpg") }); return true; });
  await step("coverFirst", async () => { const { prepare } = cov.createCoverFirst({ dir: path.join(out, "coverfirst"), ffmpegPath: ffmpeg }); const r = await prepare(inputs.clip, inputs.cover); return typeof r === "string" ? path.basename(r) : Boolean(r); });
  await step("sceneVideo.contactSheet", async () => { await media.shotContactSheet({ source: inputs.clip, destination: path.join(out, "contact.jpg"), seconds: 5, ffmpegPath: ffmpeg }); return true; });
  await step("sceneVideo.referenceJpeg", async () => { await media.referenceJpeg({ source: inputs.cover, destination: path.join(out, "ref.jpg"), ffmpegPath: ffmpeg }); return true; });
  await step("sceneVideo.captions", async () => { const captions = media.buildPlannedCaptions({ cues: [{ text: "一趟洗一大片", start: 0.3, end: 2.5 }, { text: "洗完即干", start: 2.6, end: 4.8 }], durationSeconds: 5 });
    await media.renderCaptioned({ source: inputs.clip, destination: path.join(out, "captioned.mp4"), captions, ffmpegPath: ffmpeg }); return true; });
  return { out, results };
}

function streams(probe, file) {
  try {
    const info = JSON.parse(sh(probe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());
    // Only real audio counts as "a:": camera files also carry data tracks (DJI metadata).
    return info.streams.map((s) => s.codec_type === "video" ? `v:${s.codec_name} ${s.width}x${s.height} ${s.avg_frame_rate} ${s.pix_fmt}`
      : s.codec_type === "audio" ? `a:${s.codec_name} ${s.sample_rate} ${s.channels}ch` : `${s.codec_type}:${s.codec_name}`).join(" | ") + ` dur=${Number(info.format.duration).toFixed(2)}`;
  } catch { return "unreadable"; }
}
// "n/a" when the comparison itself failed: counted as a difference, never as "same".
function psnr(ffmpeg, a, b) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v][1:v]scale2ref[x][y];[x][y]psnr", "-f", "null", "-"], { windowsHide: true, encoding: "utf8" });
  if (result.error || result.status !== 0) return "n/a";
  return (String(result.stderr).match(/average:(\S+)/) || [])[1] || "n/a";
}
// A unique marker when decoding fails, so two failed decodes never compare equal; "-" only when the file has no audio.
function audioHash(ffmpeg, probe, file) {
  const described = streams(probe, file);
  if (described === "unreadable") return `decode-failed:${crypto.randomUUID()}`;
  if (!described.split(" | ").some((part) => part.startsWith("a:"))) return "-";
  const result = spawnSync(ffmpeg, ["-v", "error", "-i", file, "-map", "0:a:0?", "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], { windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error || result.status !== 0 || String(result.stderr || "").trim()) return `decode-failed:${crypto.randomUUID()}`;
  return result.stdout?.length ? crypto.createHash("sha256").update(result.stdout).digest("hex") : `decode-failed:${crypto.randomUUID()}`;
}
function files(dir) { const list = []; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else list.push(path.relative(dir, p)); } }; walk(dir); return list.sort(); }

async function main(argv) {
  const options = parseArgs(argv);
  console.log(`work folder: ${options.out}\n\n== what each build provides`);
  for (const line of capabilityDiff(options.old, options.new)) console.log(`  ${line}`);
  const inputs = makeInputs(options.old, path.join(options.out, "in"), options.samples);
  const before = await runAll("old", options.old, inputs, options.out), after = await runAll("new", options.new, inputs, options.out);
  let differences = 0;
  console.log("\n== steps (old | new)");
  for (const name of Object.keys(before.results)) {
    const a = before.results[name], b = after.results[name];
    const same = a.ok === b.ok && JSON.stringify(a.value) === JSON.stringify(b.value);
    if (!same || !a.ok) differences += 1;
    const show = (r) => r.ok ? `ok ${JSON.stringify(r.value)} ${r.ms}ms` : `FAIL ${r.error}`;
    console.log(`  ${same ? (a.ok ? "same" : "SAME-FAIL") : "DIFF"} ${name}${same && a.ok ? "" : `\n      old ${show(a)}\n      new ${show(b)}`}`);
  }
  console.log("\n== outputs");
  const ffmpeg = tool(options.new, "ffmpeg"), probe = tool(options.new, "ffprobe");
  for (const file of [...new Set([...files(before.out), ...files(after.out)])].filter((name) => /\.(mp4|wav|jpg|png)$/iu.test(name))) {
    const a = path.join(before.out, file), b = path.join(after.out, file);
    if (!fs.existsSync(a) || !fs.existsSync(b)) { differences += 1; console.log(`  MISSING ${file}`); continue; }
    const sa = streams(probe, a), sb = streams(probe, b);
    const picture = /\.(mp4|jpg|png)$/iu.test(file) ? psnr(ffmpeg, a, b) : null;
    const sound = /\.(mp4|wav)$/iu.test(file) ? audioHash(ffmpeg, probe, a) === audioHash(ffmpeg, probe, b) : null;
    // Unreadable files or a comparison that could not run are differences to look at, not matches.
    const pictureBad = picture !== null && (picture === "n/a" || (picture !== "inf" && !(Number(picture) >= 40)));
    if (sa !== sb || sa === "unreadable" || pictureBad || sound === false) differences += 1;
    console.log(`  ${sa === sb ? "same-params" : "PARAMS-DIFF"} ${file}${picture === null ? "" : ` psnr=${picture}`}${sound === null ? "" : ` audio ${sound ? "same" : "DIFF"}`}`);
  }
  console.log(`\n${differences ? `${differences} difference(s) to look at before switching` : "no differences: every path gives the same result"}`);
  return differences;
}

if (require.main === module) main(process.argv.slice(2)).then((d) => { process.exitCode = d ? 1 : 0; }, (error) => { console.error(error.message || error); process.exitCode = 2; });
module.exports = { parseArgs, capabilityDiff, psnr, audioHash, streams };
