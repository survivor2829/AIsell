"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { minifyAppSource } = require("./minify-app-source.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "minify-app-"));
try {
  const app = path.join(root, "app");
  fs.mkdirSync(path.join(app, "src", "main"), { recursive: true });
  fs.mkdirSync(path.join(app, "rpa"), { recursive: true });
  fs.writeFileSync(path.join(app, "src", "main", "page.cjs"), [
    "// 设计说明：这段注释不能进安装包。",
    "/* 试拍结论：刮条落地 */",
    "const label = \"一趟洗一大片\";",
    "function inject(fn, ...args) { return `(${fn.toString()})(...${JSON.stringify(args)})`; }",
    "// The injected function runs in a page with none of this module's names.",
    "module.exports = { label, code: inject((a, b) => { const helper = (x) => x * 2; return helper(a) + b; }, 3, 4) };",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(app, "rpa", "script.cjs"), "/*! keep this licence */\n// drop this\nmodule.exports = String.raw`C:\\一\\二`;\n");
  fs.writeFileSync(path.join(app, "src", "main", "data.json"), "{\"untouched\": true}\n");
  const maps = path.join(root, "maps");
  const summary = minifyAppSource(app, { version: "9.9.9", mapsRoot: maps });

  const page = fs.readFileSync(path.join(app, "src", "main", "page.cjs"), "utf8");
  assert.doesNotMatch(page, /设计说明|试拍结论|injected function/, "design comments are removed");
  assert.equal(summary.files, 2, "only scripts are touched");
  assert.equal(fs.readFileSync(path.join(app, "src", "main", "data.json"), "utf8"), "{\"untouched\": true}\n");
  const loaded = require(path.join(app, "src", "main", "page.cjs"));
  assert.equal(loaded.label, "一趟洗一大片", "strings stay as they were");
  // A function serialized for a web page still runs on its own (no helper names were added).
  assert.doesNotMatch(loaded.code, /__name/);
  assert.equal(new Function(`return ${loaded.code}`)(), 10);
  const script = fs.readFileSync(path.join(app, "rpa", "script.cjs"), "utf8");
  assert.match(script, /keep this licence/, "licence comments stay");
  assert.doesNotMatch(script, /drop this/);
  assert.equal(require(path.join(app, "rpa", "script.cjs")), "C:\\一\\二", "raw templates keep their exact text");
  // Maps are written beside the build, never into the application, and point back to the source.
  const map = JSON.parse(fs.readFileSync(path.join(maps, "9.9.9", "src", "main", "page.cjs.map"), "utf8"));
  assert.deepEqual(map.sources, ["src/main/page.cjs"]);
  assert.doesNotMatch(page, /sourceMappingURL/, "the packaged file does not point at a map");
  // A field stack trace in the minified file maps back to the original line.
  const { mapStack } = require("./map-field-stack.cjs");
  const at = page.indexOf("*2");
  assert.ok(at > 0);
  const packaged = ["C:", "Program Files", "X", "resources", "app", "src", "main", "page.cjs"].join("\\");
  const mapped = mapStack(`at ${packaged}:1:${at + 1}`, { version: "9.9.9", mapsRoot: maps });
  assert.ok(/src\/main\/page\.cjs:6:\d+/.test(mapped.text), mapped.text);
  assert.equal(mapped.mapped, 1);
  assert.equal(mapStack("no frames here", { version: "9.9.9", mapsRoot: maps }).mapped, 0, "nothing mapped is reported, not passed through silently");
  assert.ok(JSON.parse(fs.readFileSync(path.join(maps, "9.9.9", "minifier.json"), "utf8")).esbuild, "the minifier version is recorded with the maps");
  assert.throws(() => minifyAppSource(app, { version: "1", mapsRoot: path.join(app, "maps") }), /outside the packaged application/);
  // Case-folded, and anywhere in a packaged target (…/resources/app), not only inside resources/app.
  const target = path.join(root, "target"); const nestedApp = path.join(target, "resources", "app");
  fs.mkdirSync(nestedApp, { recursive: true });
  assert.throws(() => minifyAppSource(nestedApp, { version: "1", mapsRoot: path.join(target, "maps").toUpperCase() }), /outside the packaged application/);
  assert.throws(() => minifyAppSource(app, { mapsRoot: maps }), /release version/);
  console.log("minify app source self-check passed: comments gone, strings and injected functions intact, maps outside the app");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
