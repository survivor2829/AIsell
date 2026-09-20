const fs = require("node:fs");
const JSZip = require("jszip");
const { digest } = require("../src/shared/component-contract.cjs");

async function entries(buffer) {
  // Reject collapsed/duplicate entries before deciding that two libraries match.
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { end = at; break; }
  }
  if (end < 0) throw new Error("Invalid Python library archive");
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const files = Object.values(archive.files).sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (files.length !== buffer.readUInt16LE(end + 10) || files.some(file => file.dir || file.unsafeOriginalName !== file.name)) throw new Error("Ambiguous Python library archive");
  return Promise.all(files.map(async file => ({ name: file.name, data: await file.async("nodebuffer") })));
}

async function stabilizePythonLibrary(file, reference = null) {
  const original = fs.readFileSync(file);
  const current = await entries(original);
  if (reference) {
    const previous = fs.readFileSync(reference.file);
    if (digest(previous) !== reference.sha256) throw new Error("Python library reference differs from the accepted base manifest");
    const accepted = await entries(previous);
    if (current.length === accepted.length && current.every((entry, index) => entry.name === accepted[index].name && entry.data.equals(accepted[index].data))) {
      fs.writeFileSync(file, previous);
      return { reused: true, contentChanged: false, entries: current.length };
    }
  }
  // New dependencies remain new. Stable ordering prevents a fresh base from
  // changing again solely because PyInstaller enumerates a set differently.
  const archive = new JSZip();
  for (const entry of current) archive.file(entry.name, entry.data, {
    date: new Date("2000-01-01T00:00:00Z"), createFolders: false, compression: "STORE", unixPermissions: 0o100644
  });
  fs.writeFileSync(file, await archive.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  return { reused: false, contentChanged: Boolean(reference), entries: current.length };
}

module.exports = { stabilizePythonLibrary };
