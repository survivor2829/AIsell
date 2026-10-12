// Produce an unsigned, reviewable patch for the original 1.1.64 application.
// This is not a publisher. A release still needs the original/rebuilt application,
// verified base58, signed component envelope and the acceptance gates in the docs.
const fs = require("node:fs");
const path = require("node:path");
const { digest: sha256 } = require("../src/shared/component-contract.cjs");
const { compareVersions, verifyManifest } = require("../src/shared/cloud-contract.cjs");
const SOURCE_COMMIT = "a253ddc";
const SOURCE_HASHES = Object.freeze({
  "src/main/main.cjs": "bede32f449f5180009314650d7e4ed4fae0ed9346902f0a0bb1ee52a2304ca04",
  "src/main/cloud-maintenance.cjs": "5be03ad7a3bf9970a9dd91fa3faf901629b06a18540f29a369c0edb9e9f4badd",
  "src/main/update-storage.cjs": "d3006906347abe98b8c5906eb75c614c13f74d1d79d6aa81eadcff963781adf3",
  "src/main/update-helper.cjs": "d24410fd607093c632c4991c10d3417858d46eaa2570a70c00341a201d7e3682"
});
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error("legacy_bridge_patch_context_mismatch");
  return source.replace(before, after);
}
// Ship the current recovery implementation as an application-owned namespace.
// Relative dependencies keep their normal layout; immutable base58 is untouched.
function recoveryFiles() {
  const root = path.resolve(__dirname, ".."), files = {}, hashes = {};
  const prefix = "src/main/legacy-recovery/";
  function add(relative) {
    relative = relative.replaceAll("\\", "/");
    if (relative.startsWith("../") || path.isAbsolute(relative)) throw Error("legacy_recovery_dependency_outside_app");
    const target = prefix + relative;
    if (Object.hasOwn(files, target)) return;
    if (relative === "src/main/cloud-config.cjs") {
      // Keep the trust root compiled into the original installed application.
      files[target] = 'const original = require("../../../cloud-config.cjs");\nexports.cloudConfig = ({channel} = {}) => original.cloudConfig({developmentEdition: channel === "test"});\n';
      return;
    }
    const source = fs.readFileSync(path.join(root, relative), "utf8").replaceAll("\r\n", "\n");
    files[target] = source; hashes[relative] = sha256(source);
    for (const match of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) add(path.join(path.dirname(relative), match[1]));
  }
  add("src/main/update-helper.cjs");
  return { files, hashes };
}
function buildLegacyBridgePatch({ sourceApplicationRoot, targetEnvelope, bridgeVersion, config }) {
  const full = verifyManifest(targetEnvelope, config);
  if (compareVersions(bridgeVersion, "1.1.64") <= 0 || compareVersions(full.version, bridgeVersion) <= 0) {
    throw Error("legacy_bridge_version_order_invalid");
  }
  const sources = {};
  for (const [relative, expected] of Object.entries(SOURCE_HASHES)) {
    const source = fs.readFileSync(path.join(sourceApplicationRoot, relative), "utf8").replaceAll("\r\n", "\n");
    if (sha256(source) !== expected) throw Error(`legacy_bridge_source_mismatch:${relative}`);
    sources[relative] = source;
  }
  // Preserve all business data, including directories merely named .runtime-links
  // elsewhere. Only the known regenerable product-detail links are excluded.
  const storage = replaceOnce(sources["src/main/update-storage.cjs"],
    '["data/cloud-maintenance", "update-helper-profile"]',
    '["data/cloud-maintenance", "update-helper-profile", "product-detail/.runtime-links"]');
  let maintenance = sources["src/main/cloud-maintenance.cjs"];
  maintenance = replaceOnce(maintenance,
    'const envelope = await network.request(`/v1/releases/${config.channel}/latest`);',
    'const envelope = require("./legacy-update-target.json"); // Signed, fixed final target of this bridge.');
  const componentStart = maintenance.indexOf("  function readLatestComponents() {");
  const componentEnd = maintenance.indexOf("  async function refreshAnnouncements()", componentStart);
  if (componentStart < 0 || componentEnd < 0) throw Error("legacy_bridge_patch_context_mismatch");
  maintenance = maintenance.slice(0, componentStart)
    + "  function readLatestComponents() { return Promise.resolve(null); }\n"
    + maintenance.slice(componentEnd);
  maintenance = replaceOnce(maintenance, 'require("./update-helper.cjs").createUpdateJob', 'require("./legacy-update-helper.cjs").createUpdateJob');
  maintenance = replaceOnce(maintenance, 'let phase = "prepare";\n    try {', 'let phase = "prepare", launchedJobFile;\n    try {');
  maintenance = replaceOnce(maintenance, '      phase = "launch";', '      launchedJobFile = file;\n      phase = "launch";');
  maintenance = replaceOnce(maintenance, '      notify({ stage: "waiting", error: "" });\n      return true;',
    '      require("./legacy-update-helper.cjs").authorizeUpdateJob(file, job);\n      notify({ stage: "waiting", error: "" });\n      return true;');
  maintenance = replaceOnce(maintenance, '      const failure = updateFailure(error, phase);',
    '      if (launchedJobFile) { try { require("./legacy-update-helper.cjs").revokeUpdateJob(launchedJobFile); } catch {} }\n      const failure = updateFailure(error, phase);');
  maintenance = replaceOnce(maintenance, 'if (!state.pending || !canInstall()) return null;', 'if (stopped || checking || !state.pending || !canInstall()) return null;');
  maintenance = replaceOnce(maintenance, '      require("./legacy-update-helper.cjs").authorizeUpdateJob(file, job);',
    '      if (stopped) throw Error("update_request_cancelled");\n      require("./legacy-update-helper.cjs").authorizeUpdateJob(file, job);');
  let main = sources["src/main/main.cjs"];
  const registration = main.indexOf('      registerCloudMaintenanceIpc({ ipcMain, controller: cloudMaintenance, getMainWindow: () => mainWindow,');
  const start = main.indexOf('      cloudMaintenance.start();', registration);
  if (registration < 0 || start < 0) throw Error("legacy_bridge_patch_context_mismatch");
  main = main.slice(0, registration) + [
    '      const { createLegacyContinuation, legacySafety } = require("./legacy-update-continuation.cjs");',
    '      const updater = createLegacyContinuation({ app, controller: cloudMaintenance, userData: app.getPath("userData"), getMainWindow: () => mainWindow,',
    '        ...legacySafety({ workflow: workflowController, coordinator, productVideo: productVideoRegistration?.service,',
    '          digitalHuman: digitalHumanRegistration?.service, contentEngine: contentEngineController, productDetail: productDetailController }) });',
    '      registerCloudMaintenanceIpc({ ipcMain, controller: cloudMaintenance, getMainWindow: () => mainWindow, restart: updater.request });',
    '      updater.start();', ''
  ].join("\n") + main.slice(start);
  const recovery = recoveryFiles();
  const dedicated = name => fs.readFileSync(path.join(__dirname, "../src/main", name), "utf8");
  return { sourceCommit: SOURCE_COMMIT, bridgeVersion, targetVersion: full.version, targetSha256: full.sha256,
    files: { ...recovery.files, "src/main/main.cjs": main, "src/main/cloud-maintenance.cjs": maintenance, "src/main/update-storage.cjs": storage,
      "src/main/legacy-update-helper.cjs": dedicated("legacy-update-recovery.cjs"),
      "src/main/legacy-update-continuation.cjs": dedicated("legacy-update-continuation.cjs"),
      "src/main/legacy-update-target.json": JSON.stringify(targetEnvelope) },
    sourceHashes: SOURCE_HASHES, recoverySourceHashes: recovery.hashes, implementationReady: true, deliveryReady: false,
    remainingGates: ["original-installation-artifact", "signed-component-package", "ordinary-user-two-stage-upgrade", "real-installer-failure-and-startup-rollback"] };

}
module.exports = { buildLegacyBridgePatch, SOURCE_COMMIT, SOURCE_HASHES };
