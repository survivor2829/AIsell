// What the bundled FFmpeg must provide, checked before a release builds anything.
// 1.2.46–1.2.48 switched to an LGPL FFmpeg without libx264 while code still asked for it: every
// customer's digital-human upload failed until 1.2.62, and customers found it first. Every encoder,
// filter and format the app's media paths use (src/main, sidecars/content-engine) is listed here;
// a build whose FFmpeg lacks one stops in preflight. Add to these lists when code starts using more.
const { execFileSync } = require("node:child_process");

const REQUIRED = Object.freeze({
  // h264_mf: the content engine and the JS paths encode with Media Foundation; libopenh264 is the
  // JS fallback (Windows N editions without Media Foundation).
  encoders: ["h264_mf", "libopenh264", "aac", "pcm_s16le", "mjpeg"],
  filters: ["subtitles", "ass", "drawtext", "overlay", "scale", "pad", "fps", "concat", "amix", "loudnorm", "volumedetect",
    "volume", "atrim", "trim", "apad", "aresample", "aformat", "asetpts", "setpts", "setsar", "afade", "zoompan", "crop",
    "tile", "gblur", "format", "split", "adelay"],
  muxers: ["mp4", "mov", "wav", "s16le", "null", "image2", "image2pipe", "rawvideo"],
  demuxers: ["mov", "concat", "wav", "image2", "lavfi"]
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

// Missing capabilities as "kind:name"; empty when the build has everything the app uses.
function missingMediaToolCapabilities(ffmpegPath, run = (file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })) {
  const missing = [];
  for (const [kind, names] of Object.entries(REQUIRED)) {
    const available = listed(run(ffmpegPath, ["-hide_banner", `-${kind}`]), kind);
    for (const name of names) if (!available.has(name)) missing.push(`${kind}:${name}`);
  }
  return missing;
}

module.exports = { REQUIRED, listed, missingMediaToolCapabilities };
