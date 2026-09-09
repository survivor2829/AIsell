// Build-time download only. End users never download a model while uploading.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const config = require("../sidecars/product-detail/app/cutout_model.json");
const root = path.resolve(__dirname, "../.build/cutout-models");
const target = path.join(root, config.file);
const checksum = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.mkdirSync(root, { recursive: true });
if (fs.existsSync(target)) {
  if (checksum(target) !== config.sha256) throw new Error("Existing cutout model hash mismatch; inspect it before replacing.");
  console.log("Offline cutout model verified.");
} else {
  const temporary = `${target}.${process.pid}.download`;
  try {
    const result = spawnSync("curl.exe", ["--fail", "--location", "--retry", "2", "--output", temporary, config.url], { stdio: "inherit", windowsHide: true });
    if (result.status !== 0 || checksum(temporary) !== config.sha256) throw new Error("Offline cutout model download/hash verification failed.");
    fs.renameSync(temporary, target);
    console.log("Offline cutout model downloaded and verified.");
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
