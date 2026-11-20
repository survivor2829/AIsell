"use strict";
// The release preflight refuses an FFmpeg that lacks something the app uses (the 1.2.46–1.2.62
// libx264 lesson), and the required lists cannot fall behind the code: every filter, format and
// encoder the code names that FFmpeg knows (media-tools-names.json) must be required.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { REQUIRED, NOT_FILTERS, listed, missingMediaToolCapabilities, namesInCode } = require("./media-tools-capabilities.cjs");
const known = require("./media-tools-names.json");

// The three listing layouts FFmpeg prints.
assert.deepEqual([...listed(" V....D h264_mf              H264 via MediaFoundation\n A....D aac                  AAC\n ------\n", "encoders")], ["h264_mf", "aac"]);
assert.deepEqual([...listed(" ... subtitles         V->V       Render text subtitles\n TSC overlay           VV->V      Overlay\n", "filters")], ["subtitles", "overlay"]);
assert.deepEqual([...listed(" D.. = Demuxing supported\n ---\n D   mov,mp4,m4a,3gp QuickTime / MOV\n  E  mp4             MP4\n DE  wav             WAV\n", "demuxers")],
  ["mov", "mp4", "m4a", "3gp", "wav"]);

// A build with everything passes; one without Media Foundation H.264 or a filter the mix needs is
// refused with the name of what is missing.
const full = { encoders: REQUIRED.encoders.map((name) => ` V....D ${name}  x`).join("\n"), filters: REQUIRED.filters.map((name) => ` ... ${name}  V->V x`).join("\n"),
  muxers: REQUIRED.muxers.map((name) => `  E  ${name}  x`).join("\n"), demuxers: REQUIRED.demuxers.map((name) => ` D   ${name}  x`).join("\n") };
const runner = (lists) => (_file, args) => lists[args[1].slice(1)];
assert.deepEqual(missingMediaToolCapabilities("ffmpeg.exe", runner(full)), []);
assert.deepEqual(missingMediaToolCapabilities("ffmpeg.exe", runner({ ...full, encoders: full.encoders.replace(" V....D h264_mf  x", "") })), ["encoders:h264_mf"]);
assert.deepEqual(missingMediaToolCapabilities("ffmpeg.exe", runner({ ...full, filters: full.filters.replace(" ... sidechaincompress  V->V x", "") })), ["filters:sidechaincompress"]);
assert.deepEqual(missingMediaToolCapabilities("ffmpeg.exe", runner({ ...full, muxers: full.muxers.replace("  E  hash  x", "") })), ["muxers:hash"]);

// Every required name exists in the bundled build, and the words skipped as ordinary values really
// are FFmpeg filter names (otherwise they would not need skipping).
for (const kind of ["encoders", "filters", "muxers", "demuxers"]) for (const name of REQUIRED[kind]) assert.ok(known[kind].includes(name), `${kind}:${name} is required but the bundled FFmpeg (${known.version}) does not list it`);
for (const word of Object.keys(NOT_FILTERS)) assert.ok(known.filters.includes(word), `${word} is not an FFmpeg filter: remove it from NOT_FILTERS`);

// The code scan: what the app's media paths name must be required.
const desktop = path.resolve(__dirname, "..");
const sources = [];
const walk = (dir, pattern) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name);
  if (fs.statSync(file).isDirectory()) { if (!/^(?:node_modules|__pycache__|tests?)$/u.test(name)) walk(file, pattern); }
  else if (pattern.test(name) && !/self_check|^test_|\.dev\./u.test(name)) sources.push(fs.readFileSync(file, "utf8")); } };
walk(path.join(desktop, "src", "main"), /\.cjs$/u);
walk(path.join(desktop, "sidecars", "content-engine", "content_engine"), /\.py$/u);
const used = namesInCode(sources, known);
assert.ok(used.filters.size > 20 && used.formats.has("hash") && used.encoders.has("h264_mf"), "the code scan finds the media paths");
for (const name of used.filters) assert.ok(REQUIRED.filters.includes(name), `filter ${name} is used by the code but not required of the bundled FFmpeg (add it to REQUIRED.filters, or to NOT_FILTERS with the reason if it is an ordinary word there)`);
for (const name of used.formats) assert.ok(REQUIRED.muxers.includes(name) || REQUIRED.demuxers.includes(name), `format ${name} is used with -f but not required of the bundled FFmpeg`);
// libx264 is only used when a developer's FFmpeg has it (h264-encoder.cjs, videoEncoderArgs); copy is stream copy.
for (const name of used.encoders) if (!["copy", "libx264"].includes(name)) assert.ok(REQUIRED.encoders.includes(name), `encoder ${name} is used by the code but not required of the bundled FFmpeg`);
// Nothing required that the code no longer uses (so the list stays a true picture of the code).
const notUsed = REQUIRED.filters.filter((name) => !used.filters.has(name));
assert.deepEqual(notUsed, [], `required filters the code no longer uses: ${notUsed.join(", ")}`);

// The real build is checked by the release preflight (run-release.cjs), on the FFmpeg it packages.
console.log(`media tools capabilities self-check passed: listing layouts, refused builds, ${used.filters.size} filters / ${used.formats.size} formats / encoders in step with the code`);
