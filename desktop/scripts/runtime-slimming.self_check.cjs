const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { keepsLocale, keepsBrowserFile } = require("./runtime-slimming.cjs");
const { treeSha256 } = require("./release-tree-hash.cjs");

for (const kept of ["locales/zh-CN.pak", "locales/zh-TW.pak", "locales/en-US.pak", "locales", "chrome.dll", "resources/app/locales/de.json"]) {
  assert.ok(keepsLocale(kept), `${kept} stays`);
}
for (const dropped of ["locales/de.pak", "locales/ja.pak", "locales/en-GB.pak"]) assert.ok(!keepsLocale(dropped), `${dropped} goes`);
for (const dropped of ["setup.exe", "interactive_ui_tests.exe", "elevated_tracing_service.exe", "locales/fr.pak"]) {
  assert.ok(!keepsBrowserFile(dropped), `${dropped} is not shipped with the browser`);
}
assert.ok(keepsBrowserFile("chrome.exe") && keepsBrowserFile("locales/zh-CN.pak"));

// The recorded browser tree is the shipped one: hashing the source with the
// filter equals hashing a filtered copy, which is what the runtime verifies.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "slim-"));
const source = path.join(root, "source");
fs.mkdirSync(path.join(source, "locales"), { recursive: true });
for (const name of ["chrome.exe", "setup.exe", "locales/zh-CN.pak", "locales/de.pak"]) fs.writeFileSync(path.join(source, name), name);
const copy = path.join(root, "copy");
fs.cpSync(source, copy, { recursive: true, filter: file => keepsBrowserFile(path.relative(source, file).split(path.sep).join("/")) });
assert.deepEqual(fs.readdirSync(path.join(copy, "locales")), ["zh-CN.pak"]);
assert.ok(!fs.existsSync(path.join(copy, "setup.exe")));
assert.equal(treeSha256(source, keepsBrowserFile), treeSha256(copy));
assert.notEqual(treeSha256(source), treeSha256(copy));
fs.rmSync(root, { recursive: true, force: true });
console.log("runtime slimming self-check passed: Chinese and English locales kept, unused browser programs dropped, shipped tree hash matches");
