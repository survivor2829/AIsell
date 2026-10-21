const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function compareNames(left, right) {
  const leftBytes = Buffer.from(left.name, "utf8");
  const rightBytes = Buffer.from(right.name, "utf8");
  return Buffer.compare(leftBytes, rightBytes);
}

// Scoped to this build process. File identity and both Windows timestamps must
// still match before reusing bytes already read by inventory/copy validation.
const verifiedFiles = new Map();
const readBuffer = Buffer.allocUnsafe(1024 * 1024);
function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
}
function sha256(file) {
  const absolute = path.resolve(file), before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw Error("Release hash requires a regular file");
  const identity = fileIdentity(before), previous = verifiedFiles.get(absolute);
  if (previous?.identity === identity) return previous.sha256;
  const hash = crypto.createHash("sha256"), buffer = readBuffer;
  const fd = fs.openSync(absolute, "r");
  try {
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, count));
    if (fileIdentity(fs.fstatSync(fd, { bigint: true })) !== identity) throw Error("Release file changed while hashing");
  } finally { fs.closeSync(fd); }
  if (fileIdentity(fs.lstatSync(absolute, { bigint: true })) !== identity) throw Error("Release file changed while hashing");
  const digest = hash.digest("hex");
  verifiedFiles.set(absolute, { identity, sha256: digest });
  return digest;
}

function hashInventory(root) {
  root = path.resolve(root);
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort(compareNames)) {
      const absolute = path.join(directory, entry.name), stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw Error("Release inventory forbids links");
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        const hash = sha256(absolute);
        const current = fs.lstatSync(absolute, { bigint: true });
        if (verifiedFiles.get(path.resolve(absolute))?.identity !== fileIdentity(current)) throw Error("Release inventory file changed");
        files.push({ path: path.relative(root, absolute).replaceAll("\\", "/"), size: Number(current.size),
          sha256: hash, identity: fileIdentity(current) });
      } else throw Error("Release inventory requires regular files");
    }
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw Error("Release inventory forbids links");
  visit(root);
  return { schema: 1, root, files };
}

function primeHashInventory(inventory, root) {
  root = path.resolve(root);
  if (inventory?.schema !== 1 || inventory.root !== root || !Array.isArray(inventory.files)) throw Error("Release inventory identity invalid");
  const updates = [];
  for (const file of inventory.files) {
    if (typeof file.path !== "string" || file.path.includes("\\") || file.path.split("/").some(part => !part || part === "." || part === "..")
        || path.isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error("Release inventory entry invalid");
    const absolute = path.resolve(root, file.path);
    if (!absolute.startsWith(root + path.sep)) throw Error("Release inventory path invalid");
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== file.size || fileIdentity(stat) !== file.identity) throw Error("Release inventory file changed");
    updates.push([absolute, { identity: file.identity, sha256: file.sha256 }]);
  }
  for (const [absolute, value] of updates) verifiedFiles.set(absolute, value);
}

function copyTreeVerified(source, destination) {
  const stat = fs.lstatSync(source, { bigint: true });
  if (stat.isSymbolicLink()) throw Error("Release copy forbids links");
  if (stat.isDirectory()) {
    fs.mkdirSync(destination);
    for (const entry of fs.readdirSync(source)) copyTreeVerified(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (!stat.isFile()) throw Error("Release copy requires regular files");
  const identity = fileIdentity(stat), hash = crypto.createHash("sha256"), buffer = readBuffer;
  const input = fs.openSync(source, "r");
  let output;
  try {
    output = fs.openSync(destination, "wx", Number(stat.mode) & 0o777);
    for (let count; (count = fs.readSync(input, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, count));
      for (let offset = 0; offset < count;) offset += fs.writeSync(output, buffer, offset, count - offset);
    }
    if (fileIdentity(fs.fstatSync(input, { bigint: true })) !== identity
        || fileIdentity(fs.lstatSync(source, { bigint: true })) !== identity) throw Error("Release copy source changed");
  } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
  const destinationStat = fs.lstatSync(destination, { bigint: true });
  if (destinationStat.size !== stat.size) throw Error("Release copy size mismatch");
  verifiedFiles.set(path.resolve(destination), { identity: fileIdentity(destinationStat), sha256: hash.digest("hex") });
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

module.exports = { compareNames, sha256, treeSha256, hashInventory, primeHashInventory, copyTreeVerified };
