// This entry is packaged only by build-cloud-smoke.cjs into an isolated test app.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createCloudMaintenance } = require("./src/main/cloud-maintenance.cjs");
const { createDiagnosticLogger } = require("./src/main/diagnostics.cjs");
const { cloudConfig } = require("./src/main/cloud-config.cjs");
app.setPath("userData", path.join(app.getPath("appData"), "aihuoke-maintenance-smoke"));
let controller, quitting = false;
app.whenReady().then(async () => {
  const root = app.getPath("userData"); fs.mkdirSync(root, { recursive: true });
  const sentinel = path.join(root, "preserve-me.txt");
  const hadSentinel = fs.existsSync(sentinel);
  if (!hadSentinel) fs.writeFileSync(sentinel, "preserved across automatic upgrade");
  const logger = createDiagnosticLogger({ rootDir: root });
  controller = createCloudMaintenance({ rootDir: root, config: { ...cloudConfig({ developmentEdition: true }), appId: "com.aihuoke.maintenance.smoke", channel: "smoke" },
    version: app.getVersion(), buildId: `smoke-${app.getVersion()}`, logger, canInstall: () => app.isPackaged });
  controller.setConsent(true); controller.start();
  if (app.getVersion() === "0.1.0") logger.event("smoke", "controlled_failure", { message: "PRIVATE_CUSTOMER_TEST", apiKey: ["sk", "NEVER_UPLOAD_TEST"].join("-"), filePath: "C:/Users/private" }, { level: "error", code: "smoke_failure" });
  const deadline = Date.now() + 10 * 60_000;
  const timer = setInterval(async () => {
    const status = controller.status();
    fs.writeFileSync(path.join(root, `evidence-${app.getVersion()}.json`), JSON.stringify({ version: app.getVersion(), hadSentinel,
      sentinel: fs.readFileSync(sentinel, "utf8"), status }, null, 2));
    if ((status.stage === "ready" || status.stage === "current") && !status.queued || Date.now() > deadline) {
      clearInterval(timer); app.quit();
    }
  }, 1000);
});
app.on("before-quit", (event) => {
  if (quitting || !controller) return;
  event.preventDefault(); quitting = true; controller.stop();
  controller.installOnExit().finally(() => app.quit());
});
