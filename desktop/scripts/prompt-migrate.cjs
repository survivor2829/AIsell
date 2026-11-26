"use strict";
// Moves chosen prompt literals of a JS file to the server prompt library (user decision 2026-11-25).
// Usage: node scripts/prompt-migrate.cjs <file.cjs> <spec.json>   spec: [{ "line": 12, "id": "touch.reply.system" }]
// A string literal becomes promptRef("id"); a template literal keeps its ${expressions} and each longer fixed run
// becomes ${promptRef("id.pN")}. Before writing, every rewritten literal is rebuilt from the library and must read
// exactly as before. The require of src/shared/prompt-ref.cjs is added above the first use.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const desktop = path.resolve(__dirname, "..");
const LIBRARY = process.env.XIAOXI_PROMPT_LIBRARY_OUT || path.resolve(desktop, "..", "server", "provider-gateway", "prompt-library.json");
const han = (text) => (String(text).match(/\p{Script=Han}/gu) || []).length;
const significant = (text) => han(text) >= 4 || text.trim().length >= 24;
const escapeTemplate = (text) => text.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`").replace(/\$\{/gu, "\\${");

function main(file, specFile) {
  const full = path.resolve(file);
  const source = fs.readFileSync(full, "utf8");
  const tree = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const library = fs.existsSync(LIBRARY) ? JSON.parse(fs.readFileSync(LIBRARY, "utf8")) : {};
  const store = (key, text) => {
    if (key in library && library[key] !== text) throw new Error(`${key} already holds different text; use a new version`);
    library[key] = text;
  };
  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      literals.push({ node, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    // Templates nested in a template's ${…} are reachable too; migrate inner ones in an earlier run than the outer.
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const edits = [];
  for (const entry of JSON.parse(fs.readFileSync(specFile, "utf8"))) {
    // Several literals can start on one line (a template nested in another, both sides of a ternary): "contains"
    // picks the one whose own fixed text holds the given words; otherwise the longest is taken.
    const ownText = (node) => ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("") : node.text;
    const found = literals.filter((item) => item.line === entry.line && (!entry.contains || ownText(item.node).includes(entry.contains)))
      .sort((a, b) => (b.node.end - b.node.getStart()) - (a.node.end - a.node.getStart()))[0];
    if (!found) throw new Error(`no string literal starts on line ${entry.line}`);
    const node = found.node;
    if (!ts.isTemplateExpression(node)) {
      store(`${entry.id}@1`, node.text);
      edits.push({ start: node.getStart(), end: node.end, text: `promptRef("${entry.id}")`, check: { kind: "plain", before: node.text, id: entry.id } });
      continue;
    }
    // Template literal: fixed runs -> ${promptRef(...)}, expressions copied as written.
    const statics = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    const expressions = node.templateSpans.map((span) => span.expression.getText(tree));
    let n = 0;
    const rebuilt = statics.map((text) => {
      if (!significant(text)) return escapeTemplate(text);
      n += 1;
      const key = `${entry.id}.p${n}`;
      store(`${key}@1`, text);
      return "${promptRef(\"" + key + "\")}";
    });
    if (!n) throw new Error(`${entry.id}: no fixed text long enough to move`);
    let text = "`";
    rebuilt.forEach((part, index) => { text += part + (index < expressions.length ? "${" + expressions[index] + "}" : ""); });
    text += "`";
    edits.push({ start: node.getStart(), end: node.end, text, check: { kind: "template", before: statics, expressions } });
  }
  // Check: rebuild each replacement with the library text and compare with the original literal.
  for (const edit of edits) {
    if (edit.check.kind === "plain") {
      if (library[`${edit.check.id}@1`] !== edit.check.before) throw new Error(`literal ${edit.check.id} changed`);
      continue;
    }
    const parsed = ts.createSourceFile("check.js", edit.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const template = parsed.statements[0].expression;
    const pieces = [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
    const exprs = template.templateSpans.map((span) => span.expression.getText(parsed));
    // Re-merge: an expression promptRef("key") is the stored text; anything else must equal the original expression.
    const merged = []; const original = [];
    pieces.forEach((piece, index) => {
      merged.push(["t", piece]);
      if (index < exprs.length) {
        const ref = /^promptRef\("([a-z0-9][a-z0-9_.-]{0,99})"\)$/u.exec(exprs[index]);
        merged.push(ref ? ["t", library[`${ref[1]}@1`]] : ["e", exprs[index]]);
      }
    });
    edit.check.before.forEach((piece, index) => { original.push(["t", piece]); if (index < edit.check.expressions.length) original.push(["e", edit.check.expressions[index]]); });
    const squash = (list) => list.reduce((out, [kind, value]) => {
      if (kind === "t" && out.length && out[out.length - 1][0] === "t") out[out.length - 1][1] += value; else out.push([kind, value]);
      return out;
    }, []).filter(([kind, value]) => kind === "e" || value !== "");
    if (JSON.stringify(squash(merged)) !== JSON.stringify(squash(original))) throw new Error("a template literal changed");
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  if (!/\{[^}]*\bpromptRef\b[^}]*\}\s*=\s*require\(/u.test(output)) {
    const relative = path.relative(path.dirname(full), path.join(desktop, "src", "shared", "prompt-ref.cjs")).replace(/\\/gu, "/");
    const requireLine = `const { promptRef } = require("${relative.startsWith(".") ? relative : "./" + relative}");`;
    const parsed = ts.createSourceFile(full, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const firstUse = output.indexOf("promptRef(");
    // After the last top-level require statement that comes before the first use.
    const requires = parsed.statements.filter((statement) => statement.getStart() < firstUse && /require\(/u.test(statement.getText(parsed)) && ts.isVariableStatement(statement));
    const at = requires.length ? requires[requires.length - 1].end : (output.startsWith('"use strict";') ? '"use strict";'.length : 0);
    output = output.slice(0, at) + "\n" + requireLine + output.slice(at);
  }
  // The rewritten file still parses.
  const diagnostics = ts.transpileModule(output, { reportDiagnostics: true, compilerOptions: { allowJs: true } }).diagnostics || [];
  if (diagnostics.length) throw new Error(`rewritten file does not parse: ${diagnostics[0].messageText}`);
  fs.writeFileSync(full, output);
  fs.writeFileSync(LIBRARY, JSON.stringify(Object.fromEntries(Object.entries(library).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 1) + "\n");
  console.log(`${path.basename(full)}: moved ${edits.length} literal(s); library has ${Object.keys(library).length} entries`);
}

main(process.argv[2], process.argv[3]);
