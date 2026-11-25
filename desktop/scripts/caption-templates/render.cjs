// Renders template previews. Usage:
//   node scripts/caption-templates/render.cjs <assetDir> <samples.json> <outDir> [templates,comma,separated]
// <samples.json>: [{ name, ...TemplateProps without template }]; every template is rendered on every sample,
// plus a still (PNG) at each sample's "stillMs".
const path = require("node:path");
const fs = require("node:fs");
const { bundle } = require("@remotion/bundler");
const { renderMedia, renderStill, selectComposition } = require("@remotion/renderer");

(async () => {
  const [assetDir, samplesFile, outDir, only] = process.argv.slice(2);
  const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")].find((file) => fs.existsSync(file));
  const samples = JSON.parse(fs.readFileSync(samplesFile, "utf8"));
  const templates = (only || "live,notes,cinema,news,pop").split(",");
  fs.mkdirSync(outDir, { recursive: true });
  const serveUrl = await bundle({ entryPoint: path.join(__dirname, "index.tsx"), publicDir: path.resolve(assetDir) });
  for (const sample of samples) {
    for (const template of templates) {
      const inputProps = { ...sample, template };
      const options = { serveUrl, id: "CaptionTemplate", inputProps, ...(chrome ? { browserExecutable: chrome, chromeMode: "chrome-for-testing" } : {}), logLevel: "error" };
      const composition = await selectComposition(options);
      const base = path.join(outDir, `${sample.name}-${template}`);
      for (const [index, ms] of (sample.stillMs || []).entries()) {
        await renderStill({ ...options, composition, frame: Math.round((ms / 1000) * 30), output: `${base}-${index + 1}.png` });
      }
      if (!process.env.STILLS_ONLY) {
        await renderMedia({ ...options, composition, codec: "h264", crf: 20, concurrency: 4, audioBitrate: "192k", outputLocation: `${base}.mp4` });
      }
      console.log("done", base);
    }
  }
})().catch((error) => { console.error(error); process.exit(1); });
