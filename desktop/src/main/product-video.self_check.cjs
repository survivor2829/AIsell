const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProductVideoService } = require("./product-video-service.cjs");
const { planVideo } = require("./video-directors.cjs");

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-video-check-"));
  let submitted = 0;
  const resolutions = [];
  const clip = Buffer.alloc(2048);
  clip.write("ftyp", 4, "ascii");
  const provider = {
    imageUploadBody: () => ({ body: Buffer.from("image"), headers: {} }),
    nodeOf: (payload) => payload,
    taskIdOf: (payload) => payload.task_id,
    resultUrl: () => "https://example.com/clip.mp4",
    download: async (_url, destination) => fs.writeFileSync(destination, clip),
    request: async (route, request) => {
      if (route === "/apimart/uploads/images") return { url: "https://example.com/product.png" };
      if (route === "/apimart/videos/generations") { resolutions.push(request.body.resolution); return { task_id: `video-${++submitted}` }; }
      return { status: "completed" };
    }
  };
  const service = createProductVideoService({ rootDir: root, provider,
    gatewayClient: { isEnabled: () => true, initialize: async () => ({ ready: true, capabilities: { apimart: true, apimart_video: true } }) },
    assembleVideo: async ({ destination, shots }) => { assert.equal(shots.length, 2); fs.copyFileSync(shots[0], destination); },
    enhanceVideo: async ({ source, destination }) => fs.copyFileSync(source, destination)
  });
  try {
    const imagePath = path.join(root, "input.png");
    fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    const image = service.importImage(imagePath);
    const input = { mode: "product", durationSeconds: 30, sceneId: "community", surfaceId: "marble",
      dirtId: "none", goalId: "appearance", facts: "", expression: "", imageId: image.id };
    const plan = planVideo(input);
    assert.equal(plan.shots.length, 2);
    assert.equal(plan.evidenceStatus, "appearance_only");
    assert.equal(plan.sourceResolution, '480p');
    assert.ok(plan.shots.every((shot) => !shot.prompt.includes("展示清洁前后")));
    const created = service.create(input);
    service.start(created.id);
    for (let i = 0; i < 100 && service.get(created.id).status !== "completed"; i += 1) {
      service.refresh(created.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(service.get(created.id).status, "completed");
    assert.equal(submitted, 2);
    assert.deepEqual(resolutions, ['480p', '480p']);
    service.refresh(created.id);
    assert.equal(submitted, 2);
    const exported = await service.exportVideo(created.id, path.join(root, "export.mp4"));
    assert.ok(fs.statSync(exported.path).size >= 1024);
    assert.ok(fs.readFileSync(exported.subtitlePath, "utf8").includes("00:00:15,000"));
    assert.ok(exported.sendText.includes("小区外围"));
    console.log("product-video self-check passed");
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
