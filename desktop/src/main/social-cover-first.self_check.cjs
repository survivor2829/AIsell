const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createCoverFirst, coverFirstArgs } = require("./social-cover-first.cjs");

(async () => {
  {
    // 有声音的视频：封面下面垫同样长的静音，声画不错位；没有声音的视频不加音轨。
    const withSound = coverFirstArgs({ video: "v.mp4", cover: "c.jpg", width: 1080, height: 1920, fps: 30, audio: { sampleRate: 48000, layout: "stereo" } }).join(" ");
    assert.match(withSound, /anullsrc=r=48000:cl=stereo/); assert.match(withSound, /concat=n=2:v=1:a=1/);
    const silent = coverFirstArgs({ video: "v.mp4", cover: "c.jpg", width: 1080, height: 1920, fps: 30, audio: null }).join(" ");
    assert.doesNotMatch(silent, /anullsrc/); assert.match(silent, /concat=n=2:v=1:a=0/);
    // 原视频也缩到同一个偶数尺寸，奇数尺寸（1081×1921）不会让拼接失败。
    assert.match(silent, /\[0:v\]scale=1080:1920,/);
  }
  {
    // 读视频尺寸：rotate 标签为 "0" 时仍认显示矩阵里的 -90 度；内嵌的封面图不当作视频；奇数尺寸取偶数。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-first-probe-"));
    const video = path.join(root, "v.mp4"), cover = path.join(root, "c.jpg");
    fs.writeFileSync(video, "mp4"); fs.writeFileSync(cover, "jpg");
    let graph = "";
    const run = (file, args, _options, done) => {
      if (/ffprobe/.test(path.basename(file))) return done(null, JSON.stringify({ streams: [
        { codec_type: "video", width: 600, height: 600, disposition: { attached_pic: 1 } },
        { codec_type: "video", width: 1921, height: 1081, avg_frame_rate: "30/1", tags: { rotate: "0" }, side_data_list: [{ rotation: -90 }] }] }));
      graph = args[args.indexOf("-filter_complex") + 1]; fs.writeFileSync(args.at(-1), "copy"); done(null, "");
    };
    const { prepare } = createCoverFirst({ dir: path.join(root, "out"), ffmpegPath: path.join(root, "ffmpeg.exe"), run, encoders: async (_f, attempt) => attempt([]) });
    await prepare(video, cover);
    assert.match(graph, /\[0:v\]scale=1080:1920,/, graph);
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    // 清理旧副本时不碰别人正在写的半截文件。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-first-prune-"));
    const out = path.join(root, "out"); fs.mkdirSync(out);
    const video = path.join(root, "v.mp4"), cover = path.join(root, "c.jpg");
    fs.writeFileSync(video, "mp4"); fs.writeFileSync(cover, "jpg");
    fs.writeFileSync(path.join(out, "other.part.mp4"), "writing"); fs.writeFileSync(path.join(out, "old.mp4"), "old");
    const run = (file, args, _options, done) => /ffprobe/.test(path.basename(file))
      ? done(null, JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1920 }] }))
      : (fs.writeFileSync(args.at(-1), "copy"), done(null, ""));
    const { prepare } = createCoverFirst({ dir: out, ffmpegPath: path.join(root, "ffmpeg.exe"), run, encoders: async (_f, attempt) => attempt([]), keep: 1 });
    const made = await prepare(video, cover);
    assert.deepEqual(fs.readdirSync(out).sort(), [path.basename(made), "other.part.mp4"].sort());
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    // 同一条视频发多个号只做一次；换了封面重新做；编码失败不留半截文件。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-first-"));
    const video = path.join(root, "v.mp4"), cover = path.join(root, "c.jpg");
    fs.writeFileSync(video, "mp4"); fs.writeFileSync(cover, "jpg");
    let encodes = 0, broken = false;
    const run = (file, args, _options, done) => {
      if (/ffprobe/.test(path.basename(file))) return done(null, JSON.stringify({ streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" }] }));
      encodes++;
      if (broken) { fs.writeFileSync(args.at(-1), "half"); return done(new Error("encode failed")); }
      fs.writeFileSync(args.at(-1), "copy"); done(null, "");
    };
    const encoders = async (_ffmpeg, attempt) => attempt(["-c:v", "h264_mf"]);
    const { prepare } = createCoverFirst({ dir: path.join(root, "out"), ffmpegPath: path.join(root, "ffmpeg.exe"), run, encoders });
    const [a, b] = await Promise.all([prepare(video, cover), prepare(video, cover)]);
    assert.equal(a, b); assert.equal(await prepare(video, cover), a); assert.equal(encodes, 1, "同一条视频和封面只编码一次");
    fs.writeFileSync(cover, "新封面");
    assert.notEqual(await prepare(video, cover), a); assert.equal(encodes, 2, "封面换了重新做");
    broken = true; fs.writeFileSync(cover, "又一张");
    await assert.rejects(prepare(video, cover));
    assert.deepEqual(fs.readdirSync(path.join(root, "out")).filter((name) => /part/.test(name)), [], "失败不留半截文件");
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    // 真实 FFmpeg（与客户电脑同款时设 XIAOXI_FFMPEG_PATH）：第一帧是封面，之后是原视频，时长只多 0.1 秒。
    const ffmpeg = process.env.XIAOXI_FFMPEG_PATH || "ffmpeg";
    try { execFileSync(ffmpeg, ["-version"], { stdio: "ignore", windowsHide: true }); }
    catch { console.log("social cover-first: no FFmpeg here, real encode skipped"); console.log("social cover-first self-check passed"); return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-first-real-"));
    const video = path.join(root, "成片.mp4"), cover = path.join(root, "封面.png");
    const quiet = { stdio: "ignore", windowsHide: true };
    // 原视频全蓝带声音；封面是 3:4 的纯红图（AI 封面的比例），放进 9:16 画面。
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", video], quiet);
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=red:s=300x400", "-frames:v", "1", cover], quiet);
    const { prepare } = createCoverFirst({ dir: path.join(root, "out"), ffmpegPath: ffmpeg });
    const out = await prepare(video, cover);
    const pixel = (seconds) => [...execFileSync(ffmpeg, ["-v", "error", "-ss", String(seconds), "-i", out, "-frames:v", "1", "-vf", "crop=8:8:(iw-8)/2:(ih-8)/2,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true })];
    const [r0, g0, b0] = pixel(0), [r1, , b1] = pixel(1);
    assert.ok(r0 > 180 && g0 < 80 && b0 < 80, `第一帧应是红色封面，实际 ${[r0, g0, b0]}`);
    assert.ok(b1 > 180 && r1 < 80, `1 秒处应是原视频，实际 ${[r1, , b1]}`);
    const probe = JSON.parse(execFileSync(path.join(path.dirname(ffmpeg) === "." ? "" : path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", out], { windowsHide: true }));
    const duration = Number(probe.format.duration);
    assert.ok(duration > 2.05 && duration < 2.25, `时长 ${duration}`);
    const v = probe.streams.find((s) => s.codec_type === "video");
    assert.equal(v.codec_name, "h264"); assert.equal(`${v.width}x${v.height}`, "360x640");
    assert.ok(probe.streams.some((s) => s.codec_type === "audio"), "声音保留");
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("social cover-first self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
