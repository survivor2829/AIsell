const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const retention = require("./artifact-retention.cjs");

function existingParent(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw Error("Release storage has no existing parent");
    current = parent;
  }
  return current;
}

function resolveBuildStorage(desktopDir, environment = process.env) {
  const source = fs.realpathSync(desktopDir);
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: source, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw Error("Cannot identify repository for release storage");
  const common = fs.realpathSync(result.stdout.trim());
  const identity = `${os.homedir()}\0${common}`;
  const repository = crypto.createHash("sha256").update(process.platform === "win32" ? identity.toLowerCase() : identity).digest("hex").slice(0, 12);
  const releaseRoot = path.resolve(source, "../release");
  const target = fs.realpathSync(existingParent(releaseRoot));
  const root = path.resolve(environment.XIAOXI_RELEASE_STORAGE_ROOT
    || path.join(path.parse(target).root, ".xiaoxi-build", repository));
  if (fs.statSync(existingParent(root)).dev !== fs.statSync(target).dev) {
    throw Error("XIAOXI_RELEASE_STORAGE_ROOT must be on the release target volume");
  }
  if (process.platform === "win32" && path.join(root, "s", "00000000").length > 75) {
    throw Error("XIAOXI_RELEASE_STORAGE_ROOT is too long for bundled browser paths; choose a short directory on the release volume");
  }
  const legacy = [path.join(source, ".build/runtime-cache")];
  if (path.basename(common) === ".git") legacy.push(path.join(path.dirname(common), "desktop/.build/runtime-cache"));
  return { root, repository, releaseRoot, cacheRoot: path.join(root, "c"), stagingParent: path.join(root, "s"),
    fallbackCacheRoots: [...new Set(legacy)] };
}

function ensureBuildStorage(storage) {
  const { root, repository } = storage;
  let current = path.parse(root).root;
  for (const part of path.relative(current, root).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error("Release storage must not contain links");
  }
  const marker = path.join(root, "storage.json");
  if (fs.existsSync(root) && !fs.existsSync(marker) && fs.readdirSync(root).length) {
    throw Error("Release storage is not an empty or previously registered build directory");
  }
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(marker)) {
    try { fs.writeFileSync(marker, JSON.stringify({ schema: 1, repository }), { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const saved = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (saved.schema !== 1 || saved.repository !== repository) throw Error("Release storage belongs to another repository");
  for (const directory of [storage.cacheRoot, storage.stagingParent]) {
    retention.safePath(root, directory);
    fs.mkdirSync(directory, { recursive: true });
  }
  return storage;
}

// A shared cache is only rotated while its complete build holds this guard.
function withBuildStorage(storage, action) {
  ensureBuildStorage(storage);
  const lock = path.join(storage.root, "build.lock");
  const identity = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { descriptor = fs.openSync(lock, "wx"); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = fs.readFileSync(lock, "utf8");
      try {
        const owner = JSON.parse(previous);
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw Error("Release storage has an unreadable build guard");
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if (probe.code === "ESRCH" && fs.readFileSync(lock, "utf8") === previous) { fs.unlinkSync(lock); continue; }
          throw probe;
        }
      } catch (probe) { throw Error(`Release storage is busy or its build guard needs inspection: ${probe.message}`); }
      throw Error("Another release build is using this repository's shared runtime cache");
    }
  }
  if (descriptor === undefined) throw Error("Cannot acquire release storage guard");
  const owner = fs.fstatSync(descriptor, { bigint: true });
  try { fs.writeFileSync(descriptor, identity); return action(); }
  finally {
    fs.closeSync(descriptor);
    try {
      const current = fs.lstatSync(lock, { bigint: true });
      if (current.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(lock);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function retryBuildArtifacts(roots, log = console.warn) {
  const pending = [];
  for (const root of new Set(roots)) {
    if (!fs.existsSync(root)) continue;
    const applied = retention.retryArtifacts(root);
    try {
      const file = path.join(root, ".artifact-retention.json");
      const ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      const protectedPaths = new Set(Object.values(ledger).flatMap(value => value.generations.flat()));
      for (const [category, state] of Object.entries(ledger)) {
        const paths = state.owned.filter(relative => !protectedPaths.has(relative) && fs.existsSync(retention.safePath(root, relative)));
        if (paths.length || state.cleanupFailure || state.cleanupDeferred) pending.push({ root, category, paths,
          reason: state.cleanupFailure?.reason || state.cleanupDeferred?.reason || "pending" });
      }
      if (!applied) pending.push({ root, reason: "retention_request_pending" });
    } catch (error) { pending.push({ root, reason: "retention_status_unavailable" }); }
  }
  if (pending.length) log(`Build artifact cleanup pending: ${pending.map(value => `${value.root} (${value.reason})`).join("; ")}`);
  return { complete: pending.length === 0, pending };
}

function buildArtifactRoots(storage) {
  return [storage.releaseRoot, path.join(storage.releaseRoot, "components/test"), storage.cacheRoot, storage.stagingParent];
}

module.exports = { resolveBuildStorage, ensureBuildStorage, withBuildStorage, retryBuildArtifacts, buildArtifactRoots };
