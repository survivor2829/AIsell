const assert = require("node:assert/strict");
const path = require("node:path");
const { repairShortcuts } = require("./shortcut-repair.cjs");

// A blank-page desktop icon (cfe8221b, 2026-11-21): a shortcut of ours whose program or icon is gone is
// pointed back at the running program; others are left alone, and nothing breaks without a shell.
const exe = path.join("C:\\Apps\\AI获客-测试版", "AI获客 V1.0版本-测试版.exe");
const desktop = "C:\\Users\\u\\Desktop", menu = "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
function run(links, present = []) {
  const files = new Set([exe, ...present, ...Object.keys(links)].map((file) => file.toLowerCase()));
  const written = [];
  const shell = {
    readShortcutLink: (file) => { const link = links[file]; if (link === "broken") throw Error("x"); return { ...link }; },
    writeShortcutLink: (file, operation, options) => { written.push({ file, operation, options }); return true; }
  };
  return { found: repairShortcuts({ shell, folders: [desktop, menu], executable: exe, exists: (file) => files.has(String(file).toLowerCase()) }), written };
}
const at = (folder, name = "AI短视频获客.lnk") => path.join(folder, name);

// Program and icon where the shortcut says: untouched.
let r = run({ [at(desktop)]: { target: exe, icon: exe, iconIndex: 0 } });
assert.deepEqual(r.found, [{ place: "desktop", state: "ok" }]); assert.equal(r.written.length, 0);
// Its icon file gone (the blank page): pointed back, the rest of the shortcut kept.
r = run({ [at(desktop)]: { target: exe, icon: "C:\\Apps\\old\\uninstallerIcon.ico", args: "--x" } });
assert.deepEqual(r.found, [{ place: "desktop", state: "repaired", missing: "icon", moved: false }]);
assert.deepEqual(r.written[0], { file: at(desktop), operation: "replace", options: { target: exe, icon: exe, iconIndex: 0, cwd: path.dirname(exe), args: "--x" } });
// The program moved (an old folder of ours): same file name → ours, pointed at the running program.
r = run({ [at(menu, "AI短视频获客 V1.0版本-测试版.lnk")]: { target: "C:\\Old\\AI获客 V1.0版本-测试版.exe" } });
assert.deepEqual(r.found, [{ place: "start_menu", state: "repaired", missing: "target", moved: true }]);
// Someone else's program under one of our names: left alone.
r = run({ [at(desktop)]: { target: "C:\\Other\\other.exe" } });
assert.deepEqual(r.found, [{ place: "desktop", state: "not_ours" }]); assert.equal(r.written.length, 0);
// An unreadable shortcut, a failed write, no shell, or the program itself missing: reported or skipped, never thrown.
assert.deepEqual(run({ [at(desktop)]: "broken" }).found, [{ place: "desktop", state: "unreadable" }]);
const failing = repairShortcuts({ shell: { readShortcutLink: () => ({ target: "C:\\gone\\AI获客 V1.0版本-测试版.exe" }), writeShortcutLink: () => false },
  folders: [desktop], executable: exe, exists: (file) => [exe, at(desktop)].includes(file) });
assert.deepEqual(failing, [{ place: "desktop", state: "repair_failed", missing: "target", moved: true }]);
assert.deepEqual(repairShortcuts({ shell: null, folders: [desktop], executable: exe }), []);
assert.deepEqual(repairShortcuts({ shell: { readShortcutLink() {}, writeShortcutLink() {} }, folders: [desktop], executable: exe, exists: () => false }), []);
assert.equal(JSON.stringify(run({ [at(desktop)]: { target: "C:\\Old\\AI获客 V1.0版本-测试版.exe" } }).found).includes("Old"), false, "no paths in what is reported");

console.log("shortcut repair self-check passed: our broken shortcuts point back at the running program; others untouched");
