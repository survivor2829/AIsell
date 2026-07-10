const fs = require("node:fs");
const path = require("node:path");

const developmentEdition = process.env.XIAOXI_EDITION === "development" && fs.existsSync(path.join(__dirname, "preload.dev.cjs"));

module.exports = {
  developmentEdition,
  editionLabel: developmentEdition ? "开发版" : "客户版",
  preloadFile: developmentEdition ? "preload.dev.cjs" : "preload.cjs"
};
