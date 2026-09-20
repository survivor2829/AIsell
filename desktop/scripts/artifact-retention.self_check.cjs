const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { retainArtifacts, removeOwned } = require("./artifact-retention.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-retention-"));
try {
  const historical = path.join(root, ".backup-historical");
  fs.mkdirSync(historical);
  for (let version = 0; version < 3; version++) {
    const directory = path.join(root, `release-${version}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "payload"), "a bounded artifact");
    retainArtifacts(root, "test", [directory]);
  }
  assert(fs.existsSync(historical));
  const abandonedLock = path.join(root, ".artifact-retention.json.lock");
  fs.writeFileSync(abandonedLock, "");
  fs.utimesSync(abandonedLock, new Date(0), new Date(0));
  retainArtifacts(root, "lock-recovery", [historical], 1, []);
  assert(!fs.existsSync(abandonedLock));
  assert(!fs.existsSync(path.join(root, "release-0")));
  assert(!fs.existsSync(path.join(root, "release-1")));
  assert(fs.existsSync(path.join(root, "release-2")));
  assert.throws(() => removeOwned(root, root), /escapes/);
  assert.throws(() => removeOwned(root, path.dirname(root)), /escapes/);
  // Component generations can share unchanged ZIPs.
  for (const name of ["shared.zip", "old.zip", "new.zip"]) fs.writeFileSync(path.join(root, name), name);
  retainArtifacts(root, "components", [path.join(root, "shared.zip"), path.join(root, "old.zip")]);
  retainArtifacts(root, "components", [path.join(root, "shared.zip"), path.join(root, "new.zip")]);
  assert(fs.existsSync(path.join(root, "shared.zip")));
  assert(!fs.existsSync(path.join(root, "old.zip")));
  // Merely referencing a pre-existing archive must not transfer ownership.
  retainArtifacts(root, "legacy-reference", [historical], 1, []);
  retainArtifacts(root, "legacy-reference", [path.join(root, "new.zip")], 1, []);
  assert(fs.existsSync(historical));
  console.log("Artifact retention passed: bounded generations, shared components, historical preservation, path boundaries");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
