const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-atomic-file-"));
const file = path.join(root, "state.json");
const originalRenameSync = fs.renameSync;

try {
  fs.writeFileSync(file, JSON.stringify({ version: 1 }), "utf8");
  let attempts = 0;
  fs.renameSync = (source, destination) => {
    attempts += 1;
    if (attempts <= 2) {
      const error = new Error("simulated Windows scanner lock");
      error.code = "EPERM";
      throw error;
    }
    return originalRenameSync(source, destination);
  };
  writeJsonAtomic(file, { version: 2 }, { retryDelayMs: 1 });
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);

  fs.renameSync = () => {
    const error = new Error("simulated permanent Windows lock");
    error.code = "EBUSY";
    throw error;
  };
  assert.throws(() => writeJsonAtomic(file, { version: 3 }, { attempts: 2, retryDelayMs: 1 }), /simulated permanent/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
  console.log("atomic-file self-check passed");
} finally {
  fs.renameSync = originalRenameSync;
  fs.rmSync(root, { recursive: true, force: true });
}
