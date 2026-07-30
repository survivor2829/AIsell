// Verify that docs/2026-05-27_commit-manifest.md covers current git status.

const fs = require("fs");
const { spawnSync } = require("child_process");

const manifestPath = "docs/2026-05-27_commit-manifest.md";
const manifest = fs.readFileSync(manifestPath, "utf8");

const requiredSnippets = [
  "Codex bundled Python: OK",
  "common Python candidates: MISSING",
  "docker: MISSING",
  "bootstrap local dev env plan-only OK",
  "sensitive content scan OK: current status files",
  "Codex bundled Python dependency probe",
  "flask: MISSING",
  "pytest: MISSING",
  "playwright: MISSING",
  "tests/test_batch_progress_ui.py: OK",
  "tests/test_batch_pipeline_smoke.py: OK",
  "using Python static verifier",
  "stdlib source guard tests passed",
  "batch upload UX static checks passed",
  "test_batch_input is ignored by git",
  "upload UX sample path exists: test_batch_input\\upload_ux_sample",
  "upload UX sample content OK: 2 product dirs, 6 product files",
  "upload UX sample product dirs OK: sample-product-a, sample-product-b",
  "upload UX sample product files OK: main.png, detail-1.png, info.txt",
  "upload UX sample product files are non-empty",
  "upload UX sample PNG headers OK: main.png, detail-1.png",
  "upload UX sample info markers OK: synthetic sample, no real customer data",
  "commit manifest covers git status (23 paths); command draft matches manifest (23 paths)",
  "worktree summary: 1 modified, 22 untracked, 23 total",
  "handoff verification passed",
  "recommended route:",
  "1 first: commit current worktree to freeze handoff and validation assets",
  "2 next: restore Python/Flask environment and browser-test /batch/upload",
  "next decision options:",
  "选 1 时的最小执行顺序",
  "不要 stage `test_batch_input/`",
  "提交后下一步建议接 `2. restore Python/Flask environment`",
  "按 `docs/2026-05-27_python-flask-env-recovery-options.md` 的“选 2 时的最小执行顺序”恢复环境",
  "命令草案（仅在用户明确选择 1 后执行）",
  "git add -- templates/batch/upload.html tests/test_batch_upload_ux.py",
  "git commit -m \"chore: add upload ux handoff and validation baseline\"",
  "执行命令草案前仍需先跑一键交接检查",
  "命令草案不得包含 `test_batch_input/`",
  "会解析 `git add -- ...` 草案，并确认它与“建议包含”的 23 个路径完全一致",
  "1. commit current worktree",
  "2. restore Python/Flask environment",
  "3. planning only; no code/install/network/API",
  "entry docs:",
  "commit: docs/2026-05-27_commit-manifest.md",
  "environment: docs/2026-05-27_python-flask-env-recovery-options.md",
  "actions: docs/2026-05-27_next-action-tracker.md",
];

const missingSnippets = requiredSnippets.filter((snippet) => !manifest.includes(snippet));
if (missingSnippets.length) {
  console.error(`missing commit manifest evidence snippets in ${manifestPath}:`);
  for (const snippet of missingSnippets) console.error(`- ${snippet}`);
  process.exit(1);
}

const blockMatch = manifest.match(/建议包含：\s*```text\n([\s\S]*?)\n```/);
if (!blockMatch) {
  console.error(`could not find recommended include block in ${manifestPath}`);
  process.exit(1);
}

const manifestPaths = new Set(
  blockMatch[1]
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean)
);

const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
  encoding: "utf8",
});
if (status.status !== 0) {
  process.stderr.write(status.stderr || "");
  process.exit(status.status || 1);
}

const statusPaths = status.stdout
  .split(/\r?\n/)
  .map((line) => line.trimEnd())
  .filter(Boolean)
  .map((line) => line.slice(3).trim().replaceAll("\\", "/"))
  .filter((path) => path && !path.startsWith("test_batch_input/"));

const missing = statusPaths.filter((path) => !manifestPaths.has(path));
if (missing.length) {
  console.error("git status paths missing from commit manifest:");
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}

const extra = [...manifestPaths].filter((path) => !fs.existsSync(path));
if (extra.length) {
  console.error("commit manifest paths do not exist:");
  for (const path of extra) console.error(`- ${path}`);
  process.exit(1);
}

const commandBlockMatch = manifest.match(/命令草案（仅在用户明确选择 1 后执行）：\s*```powershell\n([\s\S]*?)\n```/);
if (!commandBlockMatch) {
  console.error(`could not find command draft block in ${manifestPath}`);
  process.exit(1);
}

const commandLines = commandBlockMatch[1]
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const addCommand = commandLines.find((line) => line.startsWith("git add -- "));
if (!addCommand) {
  console.error(`could not find git add command draft in ${manifestPath}`);
  process.exit(1);
}

const draftPaths = new Set(
  addCommand
    .slice("git add -- ".length)
    .split(/\s+/)
    .map((path) => path.trim().replaceAll("\\", "/"))
    .filter(Boolean)
);

const draftMissing = [...manifestPaths].filter((path) => !draftPaths.has(path));
if (draftMissing.length) {
  console.error("command draft is missing manifest paths:");
  for (const path of draftMissing) console.error(`- ${path}`);
  process.exit(1);
}

const draftExtra = [...draftPaths].filter((path) => !manifestPaths.has(path));
if (draftExtra.length) {
  console.error("command draft includes paths outside manifest:");
  for (const path of draftExtra) console.error(`- ${path}`);
  process.exit(1);
}

const forbiddenDraftPaths = [...draftPaths].filter((path) => path === "test_batch_input" || path.startsWith("test_batch_input/"));
if (forbiddenDraftPaths.length) {
  console.error("command draft must not include ignored local sample paths:");
  for (const path of forbiddenDraftPaths) console.error(`- ${path}`);
  process.exit(1);
}

const handoffScriptPath = "scripts/verify_2026_05_27_handoff_all.ps1";
const handoffScript = fs.readFileSync(handoffScriptPath, "utf8");
const requiredHandoffOutput = [
  "worktree summary: {0} modified, {1} untracked, {2} total",
  "recommended route:",
  "next decision options:",
  "1. commit current worktree",
  "2. restore Python/Flask environment",
  "3. planning only; no code/install/network/API",
  "entry docs:",
  "commit: docs/2026-05-27_commit-manifest.md",
  "environment: docs/2026-05-27_python-flask-env-recovery-options.md",
  "actions: docs/2026-05-27_next-action-tracker.md",
];
const missingHandoffOutput = requiredHandoffOutput.filter((snippet) => !handoffScript.includes(snippet));
if (missingHandoffOutput.length) {
  console.error(`missing handoff script next-decision output in ${handoffScriptPath}:`);
  for (const snippet of missingHandoffOutput) console.error(`- ${snippet}`);
  process.exit(1);
}

console.log(`commit manifest covers git status (${statusPaths.length} paths); command draft matches manifest (${draftPaths.size} paths)`);
