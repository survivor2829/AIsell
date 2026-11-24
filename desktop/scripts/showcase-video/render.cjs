// Renders the homepage showcase video. Usage:
//   node scripts/showcase-video/render.cjs <assetDir> <props.json> <out.mp4> [chrome.exe]
// <assetDir> holds the files the props name (product photos, sheet, plate, shots, music).
const path = require("node:path");
const fs = require("node:fs");
const { bundle } = require("@remotion/bundler");
const { renderMedia, selectComposition } = require("@remotion/renderer");

(async () => {
  const [assetDir, propsFile, out, chromeArg] = process.argv.slice(2);
  // An installed Chrome when there is one; otherwise Remotion downloads its own headless browser.
  const chrome = chromeArg || ["C:/Program Files/Google/Chrome/Application/chrome.exe", path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")].find((file) => fs.existsSync(file));
  const inputProps = JSON.parse(fs.readFileSync(propsFile, "utf8"));
  for (const key of ["products", "thumbs", "segments"]) {
    const list = inputProps[key];
    if (!Array.isArray(list) || !list.length) throw new Error(`props.${key} must be a non-empty list`);
    if (key !== "segments" && new Set(list).size !== list.length) throw new Error(`props.${key} must not repeat a file`);
  }
  const serveUrl = await bundle({ entryPoint: path.join(__dirname, "index.tsx"), publicDir: path.resolve(assetDir) });
  // No fixed port: Remotion picks a free one. On a PC with a system proxy, run without HTTP(S)_PROXY or the local page may not load.
  const options = { serveUrl, id: "Showcase", inputProps, ...(chrome ? { browserExecutable: chrome, chromeMode: "chrome-for-testing" } : {}), logLevel: "error" };
  const composition = await selectComposition(options);
  await renderMedia({ ...options, composition, codec: "h264", crf: 18, concurrency: 4, audioBitrate: "192k", outputLocation: out,
    onProgress: ({ progress }) => { if (Math.round(progress * 100) % 10 === 0) process.stdout.write(`\r${Math.round(progress * 100)}%`); } });
  console.log(`\nrendered ${out} (${composition.durationInFrames} frames)`);
})().catch((error) => { console.error(error); process.exit(1); });
