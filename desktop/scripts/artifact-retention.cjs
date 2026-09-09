const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function safePath(root, target) {
  const base = fs.realpathSync(root);
  const absolute = path.resolve(root, target);
  const relative = path.relative(base, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Artifact path escapes managed root");
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Artifact path contains a link");
  }
  return absolute;
}

function removeOwned(root, target) {
  const absolute = safePath(root, target);
  // Reject links inside a tree as well as links in its ancestors.
  const inspect = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Artifact tree contains a link");
      if (entry.isDirectory()) inspect(path.join(directory, entry.name));
    }
  };
  if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) inspect(absolute);
  fs.rmSync(absolute, { recursive: true, force: true });
}

// Only entries registered by this implementation are eligible for retirement.
// Existing historical backups and user data are never discovered by globbing.
function retainArtifacts(root, category, targets, keep = 1, owned = targets) {
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
  const ledger = path.join(root, ".artifact-retention.json");
  const lock = `${ledger}.lock`;
  const inbox = safePath(root, ".artifact-retention-requests");
  let fd;
  try {
    if (!/^[a-z0-9-]+$/i.test(category) || !Number.isInteger(keep) || keep < 1) throw new Error("Invalid retention policy");
    const relativePaths = values => values.map(t => path.relative(root, safePath(root, t)));
    fs.mkdirSync(inbox, { recursive: true });
    const receipt = path.join(inbox, `${Date.now()}-${crypto.randomUUID()}.json`);
    const temporaryReceipt = `${receipt}.tmp`;
    fs.writeFileSync(temporaryReceipt, JSON.stringify({ category, refs: relativePaths(targets), owned: relativePaths(owned), keep }));
    fs.renameSync(temporaryReceipt, receipt);
    // A deferred request stays in the inbox, including after a process crash.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        fd = fs.openSync(lock, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const identity = fs.readFileSync(lock, "utf8");
          let pid;
          try { pid = JSON.parse(identity).pid; } catch { /* A crashed writer may leave an empty lock. */ }
          if ((!Number.isInteger(pid) || pid <= 0) && Date.now() - fs.statSync(lock).mtimeMs > 60000 && fs.readFileSync(lock, "utf8") === identity) fs.unlinkSync(lock);
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (probeError) {
              if (probeError.code === "ESRCH" && fs.readFileSync(lock, "utf8") === identity) fs.unlinkSync(lock);
            }
          }
        } catch { /* A live writer may still be writing the lock identity. */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    if (fd === undefined) throw new Error("Retention busy; ownership request saved for next run");
    const data = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, "utf8")) : {};
    const requests = fs.readdirSync(inbox).filter(name => name.endsWith(".json")).sort();
    for (const name of requests) {
      const request = JSON.parse(fs.readFileSync(safePath(root, path.join(inbox, name)), "utf8"));
      if (!/^[a-z0-9-]+$/i.test(request.category) || !Number.isInteger(request.keep) || request.keep < 1) throw new Error("Invalid saved retention request");
      for (const item of [...request.refs, ...request.owned]) safePath(root, item);
      const state = data[request.category] || { generations: [], owned: [] };
      state.generations = [...state.generations.filter(g => JSON.stringify(g) !== JSON.stringify(request.refs)), request.refs].slice(-request.keep);
      state.owned = [...new Set([...state.owned, ...request.owned])];
      data[request.category] = state;
    }
    const protectedFiles = new Set(Object.values(data).flatMap(state => state.generations.flat()));
    const save = () => {
      const temporary = `${ledger}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
      fs.renameSync(temporary, ledger);
    };
    save();
    for (const name of requests) fs.unlinkSync(path.join(inbox, name));
    for (const state of Object.values(data)) {
      state.owned = state.owned.filter(relative => {
        if (protectedFiles.has(relative)) return true;
        try { removeOwned(root, relative); return false; }
        catch (error) { console.warn(`Artifact cleanup deferred: ${error.message}`); return true; }
      });
    }
    save();
  } catch (error) {
    console.warn(`Artifact retention deferred: ${error.message}`);
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
module.exports = { retainArtifacts, removeOwned, safePath };
