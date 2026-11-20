// What the bundled FFmpeg must provide, checked before a release builds anything.
// 1.2.46–1.2.48 switched to an LGPL FFmpeg without libx264 while code still asked for it: every
// customer's digital-human upload failed until 1.2.62, and customers found it first. Every encoder,
// filter and format the app's media paths use (src/main, sidecars/content-engine) is listed here;
// a build whose FFmpeg lacks one stops in preflight. media-tools-capabilities.self_check.cjs scans
// the code and fails when it uses an FFmpeg name missing here, so the lists cannot fall behind.
//
//   node scripts/media-tools-capabilities.cjs --snapshot <ffmpeg.exe>
// rewrites media-tools-names.json (every name that FFmpeg build knows) after FFmpeg is replaced.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REQUIRED = Object.freeze({
  // h264_mf: the content engine and the JS paths encode with Media Foundation; libopenh264 is the
  // JS fallback (Windows N editions without Media Foundation).
  encoders: ["h264_mf", "libopenh264", "aac", "pcm_s16le", "mjpeg"],
  // Every filter the code puts in a graph, lavfi sources (sine, aevalsrc, anullsrc) included.
  filters: ["acompressor", "adelay", "aevalsrc", "afade", "afftdn", "aformat", "alimiter", "ametadata", "amix", "anull", "anullsink",
    "anullsrc", "apad", "aresample", "asetpts", "asplit", "ass", "atrim", "colorchannelmixer", "concat", "crop", "drawbox", "drawtext",
    "ebur128", "format", "fps", "gblur", "highpass", "loudnorm", "lowpass", "overlay", "pad", "scale", "setpts", "setsar",
    "sidechaincompress", "sine", "split", "subtitles", "tile", "volume", "volumedetect", "xstack", "zoompan"],
  // Written: by extension (mp4, mov, image2 for .jpg/.png, wav) or with -f (the rest).
  muxers: ["mp4", "mov", "wav", "s16le", "null", "image2", "image2pipe", "rawvideo", "hash"],
  demuxers: ["mov", "concat", "wav", "image2", "lavfi"]
});

// Words the code scan meets that are FFmpeg filter names but are used as ordinary values there.
const NOT_FILTERS = Object.freeze({
  bass: "an instrument name in auto_mix_v2.py", buffer: "an execFile encoding option", copy: "'-c', 'copy' (stream copy, not a filter)",
  feedback: "an app area name", guided: "a mix mode name", loop: "an auto-mix field name", metadata: "a dictionary key",
  mix: "a production kind", null: "'-f', 'null' (the null muxer, listed under muxers)", random: "a dry-run mode",
  scroll: "a publish phase", segment: "an id prefix", thumbnail: "a preview variant"
});

// Names from `ffmpeg -encoders/-filters/-muxers/-demuxers`: after the flag column, the first word.
// Encoders and filters print dotted flags (" V....D h264_mf"); formats print three flag places
// padded with spaces (" D   concat", "  E  mp4") and may list several names ("mov,mp4,m4a").
function listed(text, kind) {
  const names = new Set();
  for (const line of String(text || "").split(/\r?\n/u)) {
    const match = kind === "filters"
      ? line.match(/^\s*[.TSC|]{2,4}\s+([A-Za-z0-9_]+)\s/u)
      : kind === "muxers" || kind === "demuxers"
        ? line.match(/^ [D. ][E. ][d. ] ([A-Za-z0-9_,]+)\s/u)
        : line.match(/^\s*[A-Z.]{2,6}\s+([A-Za-z0-9_,]+)\s/u);
    if (match) for (const name of match[1].split(",")) names.add(name);
  }
  return names;
}

const runFfmpeg = (file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });

// Missing capabilities as "kind:name"; empty when the build has everything the app uses.
function missingMediaToolCapabilities(ffmpegPath, run = runFfmpeg) {
  const missing = [];
  for (const [kind, names] of Object.entries(REQUIRED)) {
    const available = listed(run(ffmpegPath, ["-hide_banner", `-${kind}`]), kind);
    for (const name of names) if (!available.has(name)) missing.push(`${kind}:${name}`);
  }
  return missing;
}

// FFmpeg names the code uses: filters in graph strings, formats after -f, encoders after -c:v/-c:a.
function namesInCode(sources, known) {
  const filters = new Set(), formats = new Set(), encoders = new Set();
  for (const text of sources) {
    for (const match of text.matchAll(/(?:["'`,;\]]|\[[a-z0-9_]+\])([a-z][a-z0-9_]{1,30})(?==|,|;|\[|["'`])/gu)) {
      if (known.filters.includes(match[1]) && !Object.hasOwn(NOT_FILTERS, match[1])) filters.add(match[1]);
    }
    for (const match of text.matchAll(/["']-f["']\s*,\s*["']([a-z0-9_]+)["']/gu)) formats.add(match[1]);
    for (const match of text.matchAll(/["'](?:-c:v|-c:a|-vcodec|-acodec)["']\s*,\s*["']([a-z0-9_]+)["']/gu)) encoders.add(match[1]);
  }
  return { filters, formats, encoders };
}

function snapshot(ffmpegPath, run = runFfmpeg) {
  const names = {};
  for (const kind of ["encoders", "filters", "muxers", "demuxers"]) names[kind] = [...listed(run(ffmpegPath, ["-hide_banner", `-${kind}`]), kind)].sort();
  names.version = String(run(ffmpegPath, ["-hide_banner", "-version"]).split(/\r?\n/u)[0] || "").trim();
  return names;
}

if (require.main === module) {
  const [flag, ffmpeg] = process.argv.slice(2);
  if (flag !== "--snapshot" || !ffmpeg) { console.error("usage: node scripts/media-tools-capabilities.cjs --snapshot <ffmpeg.exe>"); process.exit(2); }
  fs.writeFileSync(path.join(__dirname, "media-tools-names.json"), JSON.stringify(snapshot(ffmpeg), null, 1) + "\n");
  console.log("wrote media-tools-names.json");
}

module.exports = { REQUIRED, NOT_FILTERS, listed, missingMediaToolCapabilities, namesInCode, snapshot };
