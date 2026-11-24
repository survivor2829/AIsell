// Renders the homepage showcase video. Usage:
//   node scripts/showcase-video/render.cjs <assetDir> <props.json> <out.mp4> [chrome.exe]
// <assetDir> holds the files the props name (product photos, sheet, plate, shots, music).
const path = require("node:path");
const fs = require("node:fs");
const { bundle } = require("@remotion/bundler");
const { renderMedia, selectComposition } = require("@remotion/renderer");

(async () => {
  const [assetDir, propsFile, out, chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe"] = process.argv.slice(2);
  const inputProps = JSON.parse(fs.readFileSync(propsFile, "utf8"));
  const serveUrl = await bundle({ entryPoint: path.join(__dirname, "index.tsx"), publicDir: path.resolve(assetDir) });
  const options = { serveUrl, id: "Showcase", inputProps, browserExecutable: chrome, chromeMode: "chrome-for-testing", logLevel: "error", port: 31000 + Math.floor(Math.random() * 2000) };
  const composition = await selectComposition(options);
  await renderMedia({ ...options, composition, codec: "h264", crf: 18, concurrency: 4, audioBitrate: "192k", outputLocation: out,
    onProgress: ({ progress }) => { if (Math.round(progress * 100) % 10 === 0) process.stdout.write(`\r${Math.round(progress * 100)}%`); } });
  console.log(`\nrendered ${out} (${composition.durationInFrames} frames)`);
})().catch((error) => { console.error(error); process.exit(1); });
