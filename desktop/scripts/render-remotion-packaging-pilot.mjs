import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const require = createRequire(import.meta.url);
const { STYLE_IDS, normalizeMotionManifest, publicFilenameForSource } = require("../remotion-packaging/contract.cjs");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}.`);
    values[key.slice(2)] = value;
  }
  return values;
}

function existingFile(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label} does not exist.`);
  return resolved;
}

function findChrome() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function generateSound(ffmpeg, target, args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, target], {
    cwd: path.dirname(target),
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000
  });
  if (result.status !== 0) throw new Error(`Unable to generate local sound effect: ${(result.stderr || "ffmpeg failed").trim()}`);
}

function prepareSounds(ffmpeg, publicDir) {
  generateSound(ffmpeg, path.join(publicDir, "sfx-pop.wav"), [
    "-f", "lavfi", "-i", "sine=frequency=980:duration=0.16:sample_rate=48000",
    "-af", "volume=0.32,afade=t=out:st=0.07:d=0.09"
  ]);
  generateSound(ffmpeg, path.join(publicDir, "sfx-click.wav"), [
    "-f", "lavfi", "-i", "sine=frequency=1450:duration=0.09:sample_rate=48000",
    "-af", "volume=0.24,afade=t=out:st=0.025:d=0.065"
  ]);
  generateSound(ffmpeg, path.join(publicDir, "sfx-whoosh.wav"), [
    "-f", "lavfi", "-i", "anoisesrc=color=pink:duration=0.42:amplitude=0.16:sample_rate=48000",
    "-af", "highpass=f=260,lowpass=f=3600,afade=t=in:st=0:d=0.08,afade=t=out:st=0.18:d=0.24"
  ]);
}

const args = readArgs(process.argv.slice(2));
const source = existingFile(args.source, "The pilot source video");
const manifestPath = existingFile(args.manifest, "The pilot manifest");
const outputDir = path.resolve(String(args["output-dir"] || ""));
if (!args["output-dir"]) throw new Error("--output-dir is required.");
const requestedStyles = String(args.styles || STYLE_IDS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
if (!requestedStyles.length || requestedStyles.some((styleId) => !STYLE_IDS.includes(styleId))) {
  throw new Error("--styles contains an unknown Remotion style.");
}
const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/u, ""));
const publicSourceFile = publicFilenameForSource(source);
const ffmpeg = args.ffmpeg || "ffmpeg";
const chrome = findChrome();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-remotion-pilot-"));
const publicDir = path.join(temporaryRoot, "public");
const bundleDir = path.join(temporaryRoot, "bundle");
fs.mkdirSync(publicDir);
fs.mkdirSync(outputDir, { recursive: true });

try {
  fs.copyFileSync(source, path.join(publicDir, publicSourceFile));
  prepareSounds(ffmpeg, publicDir);
  const serveUrl = await bundle({
    entryPoint: path.join(desktopDir, "remotion-packaging", "index.ts"),
    publicDir,
    outDir: bundleDir,
    enableCaching: false,
    onProgress: () => undefined
  });
  for (const styleId of requestedStyles) {
    const inputProps = normalizeMotionManifest({ ...rawManifest, styleId, sourceFile: publicSourceFile });
    const composition = await selectComposition({
      serveUrl,
      id: "DynamicPackaging",
      inputProps,
      browserExecutable: chrome || undefined,
      logLevel: "warn"
    });
    const outputLocation = path.join(outputDir, `${styleId}.mp4`);
    const temporaryOutput = path.join(outputDir, `${styleId}.rendering.mp4`);
    let lastBucket = -1;
    try {
      await renderMedia({
        composition,
        serveUrl,
        codec: "h264",
        audioCodec: "aac",
        pixelFormat: "yuv420p",
        crf: 18,
        outputLocation: temporaryOutput,
        inputProps,
        browserExecutable: chrome || undefined,
        concurrency: 2,
        overwrite: true,
        logLevel: "warn",
        isProduction: false,
        timeoutInMilliseconds: 120_000,
        onProgress: ({ progress }) => {
          const bucket = Math.floor(progress * 10);
          if (bucket !== lastBucket) {
            lastBucket = bucket;
            process.stdout.write(`${styleId}: ${Math.min(100, bucket * 10)}%\n`);
          }
        }
      });
      fs.rmSync(outputLocation, { force: true });
      fs.renameSync(temporaryOutput, outputLocation);
    } finally {
      fs.rmSync(temporaryOutput, { force: true });
    }
    process.stdout.write(`${styleId}: rendered\n`);
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
