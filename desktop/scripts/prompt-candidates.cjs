"use strict";
// Dev helper: candidate prompt literals of one file with the code line they start on. node scripts/prompt-candidates.cjs <file>
const fs = require("node:fs");
const path = require("node:path");
const { inventory } = require("./prompt-inventory.cjs");
const target = path.normalize(process.argv[2]);
const lines = fs.readFileSync(path.join(__dirname, "..", target), "utf8").split(/\r?\n/u);
for (const hit of inventory().filter((item) => path.normalize(item.file) === target).sort((a, b) => a.line - b.line)) {
  console.log(`${String(hit.line).padStart(5)} ${String(hit.han).padStart(5)}字 | ${lines[hit.line - 1].trim().slice(0, 90)} | ${JSON.stringify(hit.text.slice(0, 50))}`);
}
