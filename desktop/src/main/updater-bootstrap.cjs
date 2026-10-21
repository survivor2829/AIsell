const path = require("node:path");

// Import has no startup side effects; the verified launcher owns the handoff.
async function start(context) {
  if (context.mode === "helper") {
    await require("./update-helper.cjs").runHelper({ jobFile: context.jobFile, userData: context.userData });
    return;
  }
  if (context.mode !== "development") {
    global.__xiaoxiComponents = { ...context,
      resourcesRoot: path.join(context.root, "resources"), applicationRoot: path.join(context.root, "resources/app"),
      healthy: false, verification: require("./component-paths.cjs").createRuntimeVerification() };
  }
  require("./main.cjs");
}
module.exports = { start };
