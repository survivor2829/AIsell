"use strict";
// Lists prompt-like text still written in shipped code (user decision 2026-11-25: prompt wording lives on the server).
// JS/TS is parsed with TypeScript, Python with an ast helper. A literal counts when it holds 30+ Chinese characters,
// or 15+ and reads like model instructions. Usage: node scripts/prompt-inventory.cjs [--json]
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

const desktop = path.resolve(__dirname, "..");
const JS_ROOTS = ["src/main", "src/shared", "rpa", "src/renderer"];
const PY_ROOTS = ["sidecars/content-engine/content_engine", "sidecars/product-detail/app"];
const SKIP = /(self_check|\.test\.|[\\/]tests?[\\/]|[\\/]test_|[\\/]scripts[\\/]|[\\/]docs[\\/]|[\\/]node_modules[\\/]|[\\/]__pycache__[\\/]|\.dev\.cjs$)/u;
const INSTRUCTION = /(你是|请(根据|输出|生成|按|只|用)|只输出|输出\s*JSON|JSON\s*格式|不要输出|严格|要求[:：]|规则[:：]|返回\s*JSON)/u;
const han = (text) => (String(text).match(/\p{Script=Han}/gu) || []).length;
const counts = (text) => han(text) >= 30 || (han(text) >= 15 && INSTRUCTION.test(text));

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) walk(full, ext, out);
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

function jsLiterals(file) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.tsx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
  const found = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push({ text: node.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      found.push({ text: parts.join("…"), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const PY_HELPER = String.raw`
import ast, json, sys
out = []
for file in sys.argv[1:]:
    try:
        tree = ast.parse(open(file, encoding="utf-8").read())
    except Exception:
        continue
    for node in ast.walk(tree):
        # Docstrings (a bare string statement) are comments, not text the program uses.
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            node.value._xiaoxi_seen = True
            continue
        if isinstance(node, ast.JoinedStr):
            parts = [v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)]
            out.append([file, node.lineno, "…".join(parts)])
            for v in node.values:
                v._xiaoxi_seen = True
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and not getattr(node, "_xiaoxi_seen", False):
            out.append([file, node.lineno, node.value])
print(json.dumps(out, ensure_ascii=False))
`;

function pyLiterals(files, python) {
  const run = spawnSync(python, ["-c", PY_HELPER, ...files], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout).map(([file, line, text]) => ({ file, line, text }));
}

function inventory({ python = process.env.XIAOXI_CONTENT_ENGINE_BUILD_PYTHON || "D:/.xiaoxi-build/content-engine-venv-base-1.1.105/Scripts/python.exe" } = {}) {
  const hits = [];
  for (const root of JS_ROOTS) for (const file of walk(path.join(desktop, root), /\.(c?js|tsx?)$/u)) {
    for (const literal of jsLiterals(file)) if (counts(literal.text)) hits.push({ file: path.relative(desktop, file), line: literal.line, han: han(literal.text), text: literal.text });
  }
  const pyFiles = PY_ROOTS.flatMap((root) => walk(path.join(desktop, root), /\.py$/u));
  for (const literal of pyLiterals(pyFiles, python)) if (counts(literal.text)) hits.push({ file: path.relative(desktop, literal.file), line: literal.line, han: han(literal.text), text: literal.text });
  return hits;
}

module.exports = { inventory, han };

if (require.main === module) {
  const hits = inventory();
  if (process.argv.includes("--json")) { console.log(JSON.stringify(hits, null, 1)); return; }
  const byFile = new Map();
  for (const hit of hits) { const row = byFile.get(hit.file) || { count: 0, han: 0 }; row.count += 1; row.han += hit.han; byFile.set(hit.file, row); }
  for (const [file, row] of [...byFile].sort((a, b) => b[1].han - a[1].han)) console.log(`${String(row.han).padStart(6)} 字 ${String(row.count).padStart(4)} 段  ${file}`);
  console.log(`合计 ${hits.reduce((sum, hit) => sum + hit.han, 0)} 字，${hits.length} 段，${byFile.size} 个文件`);
}
