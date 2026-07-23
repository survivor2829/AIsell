const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function compareNames(left, right) {
  const leftBytes = Buffer.from(left.name, "utf8");
  const rightBytes = Buffer.from(right.name, "utf8");
  return Buffer.compare(leftBytes, rightBytes);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function treeSha256(root) {
  const absoluteRoot = path.resolve(root);
  const digest = crypto.createHash("sha256");
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort(compareNames);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(absoluteRoot, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        digest.update(`directory\0${relative}\0`);
        visit(absolute);
      } else if (entry.isFile()) {
        digest.update(`file\0${relative}\0${fs.statSync(absolute).size}\0${sha256(absolute)}\0`);
      } else {
        throw new Error(`Unsupported release tree entry: ${absolute}`);
      }
    }
  };
  visit(absoluteRoot);
  return digest.digest("hex");
}

module.exports = { compareNames, sha256, treeSha256 };
