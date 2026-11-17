// Build-time download only. Customers receive the model inside the product-detail component.
// The model comes out of a pinned PyPI wheel (immutable URL); wheel and model are both hash-checked.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const config = require("../sidecars/product-detail/app/line_ocr_model.json");

const root = path.resolve(__dirname, "../.build/line-ocr-models");
const target = path.join(root, config.file);
const checksum = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function prepare() {
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(target)) {
    if (checksum(target) !== config.sha256) throw new Error("Existing line OCR model hash mismatch; inspect it before replacing.");
    console.log("Line OCR model verified.");
    return target;
  }
  const work = fs.mkdtempSync(path.join(root, "download-"));
  try {
    const archive = path.join(work, "model.whl");
    const fetched = spawnSync("curl.exe", ["--fail", "--location", "--retry", "2", "--output", archive, config.archiveUrl], { stdio: "inherit", windowsHide: true });
    if (fetched.status !== 0 || checksum(archive) !== config.archiveSha256) throw new Error("Line OCR archive download/hash verification failed.");
    // Windows' own tar (bsdtar) reads zip archives; only the one member is extracted. Named by
    // full path and run inside the work folder: a GNU tar earlier on PATH reads "C:" as a host.
    const tar = path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "tar.exe");
    const extracted = spawnSync(tar, ["-xf", "model.whl", config.archiveMember], { cwd: work, stdio: "inherit", windowsHide: true });
    const member = path.join(work, ...config.archiveMember.split("/"));
    if (extracted.status !== 0 || !fs.existsSync(member) || checksum(member) !== config.sha256) {
      throw new Error("Line OCR model extraction/hash verification failed.");
    }
    fs.renameSync(member, target);
    console.log("Line OCR model downloaded and verified.");
    return target;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) prepare();
module.exports = { prepare, target };
