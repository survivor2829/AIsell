const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "CreativeWorkspacePage.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "CreativeWorkspacePage.css"), "utf8");

for (const contract of [
  /xiaoxiContent/u,
  /mix\.createProject\(/u,
  /mix\.updateProject\(/u,
  /mix\.listProjects\(/u,
  /mix\.calculateCombinations\(/u,
  /mix\.generateCandidates\(/u,
  /mix\.listCandidates\(/u,
  /mix\.reviewCandidate\(/u,
  /publishQueue\.list\(/u,
  /publishQueue\.update\(/u,
  /exportPackages\.render\(/u,
  /exportPackages\.list\(/u,
  /exportPackages\[action\]\(/u,
  /开头钩子/u,
  /主体信息/u,
  /产品证据/u,
  /结尾引导/u,
  /理论组合/u,
  /有效组合/u,
  /规模过大/u,
  /待生成成片包/u,
  /批准/u,
  /淘汰/u
]) {
  assert.match(source, contract);
}

assert.match(source, /allowRepeatedAssets/u);
assert.match(source, /scoreWeights/u);
assert.match(source, /targetDurationMs/u);
assert.doesNotMatch(source, /rangeFromTarget\(slot\.targetDurationSeconds/u);
assert.match(source, /data-xiaoxi-mix-save/u);
assert.match(source, /data-xiaoxi-mix-generate/u);
assert.match(source, /Promise\.all/u);
assert.match(source, /try[\s\S]*catch/u);
assert.match(styles, /@media \(max-width: 900px\)/u);
assert.match(styles, /workspace-slot-grid/u);
assert.doesNotMatch(source, /预览成片|立即渲染/u);

console.log("Creative workspace self-check passed");
