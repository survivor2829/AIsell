// One paid Wan3 image-to-video clip for the login presenter (5 s, 720P, silent),
// sent through the provider gateway with the test profile's saved license.
// Usage: npx electron scripts/generate-login-presenter-loop.cjs --role production --input <frame.jpg> --output <clip.mp4>
// The operation id is written to <clip.mp4>.receipt.json before submitting. Running again
// replays that gateway receipt and polls the same task; it never submits a second paid request.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { app, safeStorage } = require("electron");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
const { createLicenseStore } = require("../src/main/license-auth-ipc.cjs");
const { createProviderGatewayClient } = require("../src/main/provider-gateway-client.cjs");

const PROMPT = "画面中的人物面向镜头站立，自然地眨眼、微笑，轻轻点一下头，然后抬起一只手友好地挥手打招呼，再自然放下手，回到开头的姿势。"
  + "镜头完全固定不动，背景始终是同一片纯色，不出现任何新的物体、文字或光效；人物的样貌、发型、服装和颜色保持不变；动作轻柔自然，首尾姿态一致，便于循环播放。";
const VIDEO_ROUTE = "/bailian/api/v1/services/aigc/video-generation/video-synthesis";

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Invalid argument near ${argv[index] || "end"}.`);
    values[argv[index].slice(2)] = argv[index + 1];
  }
  return values;
}

const args = readArgs(process.argv.slice(2));
if (args.check === "1") { args.input = args.input || __filename; args.output = args.output || "check"; }
const input = path.resolve(String(args.input || "")), output = path.resolve(String(args.output || ""));
if (!fs.existsSync(input)) throw new Error("--input must point to the prepared 9:16 frame.");
if (!args.output) throw new Error("--output is required.");
const receiptFile = `${output}.receipt.json`;
const userData = path.join(app.getPath("appData"), "xiaoxi-active-touch-test");
app.setPath("userData", userData);

app.whenReady().then(async () => {
  const config = cloudConfig({ developmentEdition: true });
  const client = createProviderGatewayClient({ config, licenseStore: createLicenseStore({ rootDir: path.join(userData, "data"), safeStorage }),
    appId: config.appId, channel: config.channel, version: require("../package.json").version, buildId: "login-presenter-loop", installId: randomUUID() });
  await client.initialize({ force: true, verify: true });
  const state = client.status();
  if (!state.ready) throw new Error(`Gateway session unavailable (${state.code || "unknown"}).`);
  if (!state.capabilities?.bailian_video) throw new Error("The gateway does not offer bailian_video for this license.");
  if (args.check === "1") { console.log(`gateway ready, bailian_video available, session until ${state.expiresAt}`); return; }
  const call = async (route, options = {}) => {
    const response = await client.fetch(client.url(route), { timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024, ...options,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`gateway ${response.status}: ${body?.error?.message || body?.error || body?.message || "request failed"}`), { status: response.status });
    return body;
  };

  let receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, "utf8")) : null;
  if (!receipt) {
    receipt = { role: args.role || "", operationId: `login-loop-${args.role || "presenter"}-${randomUUID()}`, model: "wan3.0-video", resolution: "720P", seconds: 5, createdAt: new Date().toISOString() };
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
    const image = `data:image/jpeg;base64,${fs.readFileSync(input).toString("base64")}`;
    const body = { model: "wan3.0-video", input: { prompt: PROMPT, media: [{ type: "reference_image", url: image }] },
      parameters: { resolution: "720P", ratio: "9:16", duration: 5, audio: false, prompt_extend: false, watermark: false } };
    const submitted = await call(VIDEO_ROUTE, { method: "POST", body: JSON.stringify(body), headers: { "X-DashScope-Async": "enable", "X-Xiaoxi-Operation-Id": receipt.operationId } });
    receipt.taskId = submitted?.output?.task_id || "";
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
    console.log(`submitted ${receipt.taskId || "(no task id yet)"}`);
  }
  if (!receipt.taskId) {
    // The submission happened but its answer was lost: replay the gateway receipt, never resubmit.
    const replay = await call(`/operations/${receipt.operationId}`);
    receipt.taskId = replay?.output?.task_id || "";
    if (!receipt.taskId) throw new Error("The original request has no task id yet; check again later. No new request was sent.");
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  }
  console.log(`polling ${receipt.taskId}`);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const task = await call(`/bailian/api/v1/tasks/${receipt.taskId}`);
    const status = task?.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = String(task.output.video_url || "").replace(/^http:\/\/(dashscope-[a-z0-9-]+\.oss-)/u, "https://$1");
      const video = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!video.ok) throw new Error(`download failed ${video.status}`);
      fs.writeFileSync(output, Buffer.from(await video.arrayBuffer()));
      fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, completedAt: new Date().toISOString(), bytes: fs.statSync(output).size }, null, 2));
      console.log(`saved ${output}`);
      return;
    }
    if (status === "FAILED" || status === "CANCELED") throw new Error(`task ${status}: ${task.output.message || task.output.code || ""}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Still running after 20 minutes; run the same command again later to resume the same task.");
}).then(() => app.exit(0), (error) => { console.error(error instanceof Error ? error.message : String(error)); app.exit(1); });
