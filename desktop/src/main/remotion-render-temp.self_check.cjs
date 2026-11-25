// Render leftovers (2026-11-24): the engine's render temp folder (content-engine/.remotion-runtime) on the dev
// machine held 55 Chrome profiles (458 MB) that Remotion failed to delete on Windows or that a killed worker left.
// Each worker clears Remotion-named leftovers a day old whose Chrome is gone, and touches nothing else.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  process.env.XIAOXI_REMOTION_WORKER_IMPORT_ONLY = "1";
  const { sweepRenderLeftovers } = await import(pathToFileURL(path.join(__dirname, "remotion-render-worker.mjs")).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "render-temp-check-"));
  try {
    const day = 24 * 60 * 60 * 1000;
    const make = (name, ageMs, lockfile = false) => {
      const directory = path.join(temp, name);
      fs.mkdirSync(path.join(directory, "Default"), { recursive: true });
      fs.writeFileSync(path.join(directory, "Default", "data"), "x");
      if (lockfile) fs.writeFileSync(path.join(directory, "lockfile"), "");
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(directory, when, when);
      return directory;
    };
    const oldProfile = make("puppeteer_dev_chrome_profile-AbC123", 2 * day, true);
    const freshProfile = make("puppeteer_dev_chrome_profile-New999", 60 * 1000);
    const busyProfile = make("puppeteer_dev_chrome_profile-Busy00", 2 * day, true);
    const oldAssets = make("remotion-v4.0.512-assetsn665kyux2c", 2 * day);
    const oldWorking = make("react-motion-renderCc1uKR", 2 * day);
    const otherApp = make("some-other-app-cache", 30 * day);
    const strayFile = path.join(temp, "puppeteer_dev_chrome_profile-file");
    fs.writeFileSync(strayFile, "a file, not a folder");
    fs.utimesSync(strayFile, new Date(Date.now() - 2 * day), new Date(Date.now() - 2 * day));
    // Chrome keeps its lockfile open without delete sharing; model that by making the removal fail.
    const realRm = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (target === path.join(busyProfile, "lockfile")) throw Object.assign(Error("busy"), { code: "EBUSY" });
      return realRm(target, options);
    };
    let removed;
    try { removed = await sweepRenderLeftovers(temp); } finally { fs.rmSync = realRm; }

    const exists = (target) => fs.existsSync(target);
    assert.equal(exists(oldProfile), false, "an old Chrome profile whose Chrome is gone is removed");
    assert.equal(exists(oldAssets), false, "an old Remotion asset folder is removed");
    assert.equal(exists(oldWorking), false, "an old Remotion working folder is removed");
    assert.equal(exists(freshProfile), true, "a profile from the last day may still be in use");
    assert.equal(exists(busyProfile), true, "a profile whose Chrome is still running is kept");
    assert.equal(exists(otherApp), true, "other programs' folders are never touched");
    assert.equal(exists(strayFile), true, "only folders are removed");
    assert.deepEqual(removed.sort(), ["puppeteer_dev_chrome_profile-AbC123", "react-motion-renderCc1uKR", "remotion-v4.0.512-assetsn665kyux2c"]);
    assert.deepEqual(await sweepRenderLeftovers(path.join(temp, "missing")), [], "a missing temp folder is not an error");

    const worker = fs.readFileSync(path.join(__dirname, "remotion-render-worker.mjs"), "utf8");
    assert.match(worker, /IMPORT_ONLY !== "1"\) \{\s*(?:\/\/[^\n]*\s*)*void sweepRenderLeftovers\(os\.tmpdir\(\)\)/u, "every started worker sweeps its temp folder");
    console.log("remotion render temp checks passed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
