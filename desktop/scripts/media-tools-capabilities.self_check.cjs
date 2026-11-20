"use strict";
// The release preflight refuses an FFmpeg that lacks something the app uses (the 1.2.46–1.2.62
// libx264 lesson), and the lists stay in step with the code.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REQUIRED, listed, missingMediaToolCapabilities } = require("./media-tools-capabilities.cjs");

// The three listing layouts FFmpeg prints.
assert.deepEqual([...listed(" V....D h264_mf              H264 via MediaFoundation\n A....D aac                  AAC\n ------\n", "encoders")], ["h264_mf", "aac"]);
assert.deepEqual([...listed(" ... subtitles         V->V       Render text subtitles\n TSC overlay           VV->V      Overlay\n", "filters")], ["subtitles", "overlay"]);
assert.deepEqual([...listed(" D.. = Demuxing supported\n ---\n D   mov,mp4,m4a,3gp QuickTime / MOV\n  E  mp4             MP4\n DE  wav             WAV\n", "demuxers")],
  ["mov", "mp4", "m4a", "3gp", "mp4", "wav"].filter((name, index, all) => all.indexOf(name) === index));

// A build with everything passes; one without Media Foundation H.264 (as the old GPL-to-LGPL switch
// lost libx264) is refused with the name of what is missing.
const full = { encoders: REQUIRED.encoders.map((name) => ` V....D ${name}  x`).join("\n"), filters: REQUIRED.filters.map((name) => ` ... ${name}  V->V x`).join("\n"),
  muxers: REQUIRED.muxers.map((name) => `  E  ${name}  x`).join("\n"), demuxers: REQUIRED.demuxers.map((name) => ` D   ${name}  x`).join("\n") };
const runner = (lists) => (_file, args) => lists[args[1].slice(1)];
assert.deepEqual(missingMediaToolCapabilities("ffmpeg.exe", runner(full)), []);
assert.deepEqual(missingMediaToolCapabilities("ffmpeg.exe", runner({ ...full, encoders: full.encoders.replace(" V....D h264_mf  x", "") })), ["encoders:h264_mf"]);

// Every encoder the code names is in the list (a new one must be added before it ships).
const desktop = path.resolve(__dirname, "..");
const sources = [];
const walk = (dir, pattern) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name);
  if (fs.statSync(file).isDirectory()) { if (!/node_modules|__pycache__|tests?$/u.test(name)) walk(file, pattern); }
  else if (pattern.test(name) && !/self_check|test_/u.test(name)) sources.push(fs.readFileSync(file, "utf8")); } };
walk(path.join(desktop, "src", "main"), /\.cjs$/u);
walk(path.join(desktop, "sidecars", "content-engine", "content_engine"), /\.py$/u);
const named = new Set();
for (const text of sources) for (const match of text.matchAll(/["'](?:-c:v|-c:a|-vcodec|-acodec)["']\s*,\s*["']([a-z0-9_]+)["']/gu)) named.add(match[1]);
// libx264 is only used when a developer's FFmpeg has it (h264-encoder.cjs, videoEncoderArgs); copy is not an encoder.
for (const name of named) if (!["copy", "libx264"].includes(name)) assert.ok(REQUIRED.encoders.includes(name), `encoder ${name} is used by the code but not required of the bundled FFmpeg`);

// The real build is checked by the release preflight (run-release.cjs), on the FFmpeg it packages.
console.log("media tools capabilities self-check passed: listing layouts, refused build, encoders in step with the code");
