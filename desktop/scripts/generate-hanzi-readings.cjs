// Builds sidecars/content-engine/content_engine/assets/hanzi-readings.v1.txt: one line per toneless reading,
// "reading<TAB>chars", every CJK Unified Ideograph (U+4E00..U+9FFF), all readings (heteronyms).
const { pinyin } = require("pinyin-pro");
const out = require("path").join(__dirname, "..", "sidecars", "content-engine", "content_engine", "assets", "hanzi-readings.v1.txt");
const fs = require("fs");
const byReading = new Map();
let covered = 0;
for (let code = 0x4e00; code <= 0x9fff; code++) {
  const ch = String.fromCodePoint(code);
  const readings = pinyin(ch, { toneType: "none", type: "array", multiple: true, v: true });
  const clean = [...new Set(readings.map((r) => String(r).toLowerCase()).filter((r) => /^[a-z]+$/.test(r)))];
  if (!clean.length) continue;
  covered++;
  for (const r of clean) { if (!byReading.has(r)) byReading.set(r, []); byReading.get(r).push(ch); }
}
const lines = [...byReading.keys()].sort().map((r) => `${r}\t${byReading.get(r).join("")}`);
fs.writeFileSync(out, `# toneless Mandarin readings, generated from pinyin-pro ${require("pinyin-pro/package.json").version} (MIT); reading<TAB>characters\n` + lines.join("\n") + "\n");
console.log("chars", covered, "readings", lines.length, "bytes", fs.statSync(out).size);
