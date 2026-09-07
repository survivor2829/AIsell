const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(path.join(__dirname, "CreativeStudioPage.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "CreativeStudioPage.css"), "utf8");

for (const contract of [
  /视频创作中心/u,
  /开始创作/u,
  /正在进行/u,
  /最近完成/u,
  /系统状态/u,
  /还没有创作任务/u,
  /读取创作任务失败/u,
  /onOpenProduct/u,
  /onOpenLegacy/u,
  /onOpenMaterials/u,
  /onOpenFinished/u,
  /onOpenDiagnostics/u,
  /onContinueProduct/u,
  /content\.status\(\)/u,
  /content\.tasks\.list\(\{ limit: 50 \}\)/u,
  /content\.settings\.volcengineArkStatus\(\)/u,
  /Promise\.allSettled/u,
  /content\.tasks\.pause/u,
  /content\.tasks\.resume/u,
  /content\.tasks\.cancel/u,
  /<progress/u,
  /aria-live="polite"/u,
  /Math\.round\(value \* 100\)/u,
  /window\.setTimeout/u,
]) assert.match(page, contract);

for (const removedContract of [
  /studio-workbench/u,
  /studio-preview/u,
  /studio-timeline/u,
  /创作积木/u,
  /框架已预留/u,
  /添加第一个模块/u,
  /window\.setInterval/u,
]) assert.doesNotMatch(page, removedContract);

for (const contract of [
  /studio-dashboard-grid/u,
  /studio-task-row/u,
  /studio-system-panel/u,
  /:focus-visible/u,
  /@media/u,
]) assert.match(styles, contract);

for (const removedContract of [
  /\.studio-workbench/u,
  /\.studio-preview/u,
  /\.studio-timeline/u,
]) assert.doesNotMatch(styles, removedContract);

console.log("creative studio self-check passed");
