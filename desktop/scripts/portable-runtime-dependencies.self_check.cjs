const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { copyRuntimePackageTree } = require("./build-portable-release.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-dependencies-"));
async function main() {
  try {
    copyRuntimePackageTree("mammoth", root);
    const packagedMammoth = path.join(root, "node_modules", "mammoth");
    const mammoth = require(packagedMammoth);
    assert.equal(typeof mammoth.extractRawText, "function");
    const fixture = path.join(packagedMammoth, "test", "test-data", "single-paragraph.docx");
    const extracted = await mammoth.extractRawText({ path: fixture });
    assert.ok(extracted.value.trim(), "the copied dependency closure must extract a real DOCX");
    console.log("portable runtime dependencies self-check passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
