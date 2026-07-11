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

const requestedEdition = String(process.env.XIAOXI_EDITION || packagedEdition() || "customer");
const developmentEdition = requestedEdition === "development" && fs.existsSync(path.join(__dirname, "preload.dev.cjs"));
const pilotEdition = requestedEdition === "pilot"
  && fs.existsSync(path.join(__dirname, "../../rpa/active_touch/state_machine.dev.cjs"))
  && fs.existsSync(path.join(__dirname, "../../rpa/active_touch/wechat_window_driver.dev.cjs"));
const rendererDir = process.env.XIAOXI_EDITION === "development"
  ? "dist-development"
  : process.env.XIAOXI_EDITION === "pilot" ? "dist-pilot" : "dist";

module.exports = {
  developmentEdition,
  pilotEdition,
  editionLabel: developmentEdition ? "开发版" : pilotEdition ? "受控试用版" : "客户版",
  preloadFile: developmentEdition ? "preload.dev.cjs" : "preload.cjs",
  rendererDir
};
