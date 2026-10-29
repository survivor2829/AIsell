const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { serviceRollbackDecision } = require("./component-paths.cjs");

// Field case 2026-10-29: 1.2.23 ran, product detail timed out at browser_check,
// the next launch restored 1.2.22. Both versions carried the same product-detail
// files, so the rollback could not help and the update was lost each time.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-rollback-"));
const paths = { directory: path.join(root, "updates"), generations: path.join(root, "updates", "generations"), selection: path.join(root, "updates", "selection.json") };
const installed = path.join(root, "installed");
const [older, newer] = ["a".repeat(64), "b".repeat(64)];
const write = (directory, files) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "component-base.json"), JSON.stringify({ schema: 2, files }));
};
const detail = sha => ({ path: "resources/product-detail/product-detail.exe", sha256: sha, size: 10 });
const engine = sha => ({ path: "resources/content-engine/content-engine-worker.exe", sha256: sha, size: 20 });
const app = sha => ({ path: "resources/app/src/main/main.cjs", sha256: sha, size: 30 });
write(installed, [detail("1"), engine("1"), app("1")]);
write(path.join(paths.generations, older), [detail("1"), engine("1"), app("2")]);
write(path.join(paths.generations, newer), [detail("1"), engine("2"), app("3")]);
fs.mkdirSync(paths.directory, { recursive: true });
fs.writeFileSync(paths.selection, JSON.stringify({ active: newer, previous: older }));
const context = { paths, root: path.join(paths.generations, newer), installedRoot: installed };
const decide = (code, prefix) => serviceRollbackDecision(code, prefix, context);

assert.deepEqual(decide("PRODUCT_DETAIL_START_TIMEOUT", "resources/product-detail/"), { rollback: false, basis: "service_unchanged_by_update" },
  "a timeout of a service this update did not change keeps the new version");
assert.deepEqual(decide("PRODUCT_DETAIL_EXITED", "resources/product-detail/"), { rollback: false, basis: "service_unchanged_by_update" });
assert.deepEqual(decide("CONTENT_ENGINE_START_TIMEOUT", "resources/content-engine/"), { rollback: true, basis: "service_changed_by_update" },
  "a service the update changed may be what broke: the previous version is restored");
assert.deepEqual(decide("PRODUCT_DETAIL_SPAWN_FAILED", "resources/product-detail/"), { rollback: true, basis: "service_files_broken" },
  "files that cannot launch always restore the previous version");
assert.deepEqual(decide("PRODUCT_DETAIL_RUNTIME_LINK_FAILED", "resources/product-detail/"), { rollback: true, basis: "service_files_broken" });
assert.equal(decide("PRODUCT_DETAIL_READY_INVALID", "resources/product-detail/").rollback, false, "other failures never touched the version");
fs.writeFileSync(paths.selection, JSON.stringify({ active: newer, previous: null }));
assert.deepEqual(decide("PRODUCT_DETAIL_START_TIMEOUT", "resources/product-detail/"), { rollback: false, basis: "service_unchanged_by_update" },
  "the installed base counts as the previous version");
fs.writeFileSync(paths.selection, JSON.stringify({ active: null, previous: null }));
assert.equal(decide("PRODUCT_DETAIL_START_TIMEOUT", "resources/product-detail/").rollback, false, "nothing to undo on the installed version");
assert.equal(serviceRollbackDecision("PRODUCT_DETAIL_START_TIMEOUT", "resources/product-detail/", null).rollback, true,
  "without version information the old, cautious behaviour stays");
fs.rmSync(root, { recursive: true, force: true });
console.log("component service rollback self-check passed: unchanged services keep the update, broken or changed ones restore the previous version");
