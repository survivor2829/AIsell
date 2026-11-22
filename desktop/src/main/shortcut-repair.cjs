// A customer's desktop icon turned into a blank page (cfe8221b, 2026-11-21, after a failed full update
// and a reinstall over it). Windows draws that for a shortcut whose program or icon file is not where
// the shortcut says. On every start the app looks at its own shortcuts (desktop, Start menu) and points
// any such one back at the program that is running, then reports what it found: never a path or a name,
// only which part was missing. Nothing for the customer to do.
const fs = require("node:fs");
const path = require("node:path");

// Every name our installers have used (the 测试版 names before 2026-11-11 included).
const SHORTCUT_NAMES = ["AI短视频获客.lnk", "AI短视频获客 V1.0版本.lnk", "AI短视频获客 V1.0版本-测试版.lnk"];
const same = (a, b) => path.resolve(String(a || "")).toLowerCase() === path.resolve(String(b || "")).toLowerCase();

function repairShortcuts({ shell, folders, executable, exists = fs.existsSync } = {}) {
  const found = [];
  if (!shell?.readShortcutLink || !shell?.writeShortcutLink || !executable || !exists(executable)) return found;
  for (const folder of folders || []) {
    for (const name of SHORTCUT_NAMES) {
      const file = path.join(folder, name);
      if (!exists(file)) continue;
      let link;
      try { link = shell.readShortcutLink(file); } catch { found.push({ place: folder === folders[0] ? "desktop" : "start_menu", state: "unreadable" }); continue; }
      const targetOk = Boolean(link?.target) && exists(link.target);
      const iconOk = !link?.icon || exists(link.icon);
      const place = folder === folders[0] ? "desktop" : "start_menu";
      if (targetOk && iconOk) { found.push({ place, state: "ok" }); continue; }
      // Only a shortcut to this program, by its file name or its folder: never someone else's.
      const ours = path.basename(String(link?.target || "")).toLowerCase() === path.basename(executable).toLowerCase()
        || same(path.dirname(String(link?.target || "")), path.dirname(executable));
      if (!ours) { found.push({ place, state: "not_ours" }); continue; }
      const missing = !targetOk && !iconOk ? "target_and_icon" : !targetOk ? "target" : "icon";
      let repaired = false;
      try {
        repaired = shell.writeShortcutLink(file, "replace", { ...link, target: executable, cwd: path.dirname(executable), icon: executable, iconIndex: 0 }) === true;
      } catch { repaired = false; }
      found.push({ place, state: repaired ? "repaired" : "repair_failed", missing, moved: !same(link?.target, executable) });
    }
  }
  return found;
}

module.exports = { SHORTCUT_NAMES, repairShortcuts };
