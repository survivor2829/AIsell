const fs = require("node:fs");
const path = require("node:path");

function packagedEdition() {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(__dirname, "../../dist/build-edition.json"), "utf8"));
    return String(marker.edition || "");
  } catch {
    return "";
  }
}

const environmentEdition = String(process.env.XIAOXI_EDITION || "");
const requestedEdition = String(environmentEdition || packagedEdition() || "pilot");
const developmentEdition = requestedEdition === "development" && fs.existsSync(path.join(__dirname, "preload.dev.cjs"));
const pilotEdition = requestedEdition === "pilot"
  && fs.existsSync(path.join(__dirname, "../../rpa/active_touch/state_machine.dev.cjs"))
  && fs.existsSync(path.join(__dirname, "../../rpa/active_touch/wechat_window_driver.dev.cjs"));
// Portable builds copy their selected renderer into resources/app/dist.
// Edition-specific directories exist only in the source tree during local runs.
const rendererDir = environmentEdition === "development"
  ? "dist-development"
  : environmentEdition === "pilot" ? "dist-pilot" : "dist";

module.exports = {
  developmentEdition,
  pilotEdition,
  editionLabel: developmentEdition ? "测试版" : "",
  preloadFile: developmentEdition ? "preload.dev.cjs" : "preload.cjs",
  rendererDir
};
