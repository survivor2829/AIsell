// Compile inline scripts in templates/batch/upload.html without project deps.
//
// This is a lightweight syntax smoke check for environments where the Flask app
// cannot be started yet. It does not replace browser/manual verification.

const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("templates/batch/upload.html", "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]);

let count = 0;
for (const code of blocks) {
  count += 1;
  new vm.Script(code, { filename: `templates/batch/upload.html:inline-${count}.js` });
}

console.log(`compiled inline scripts: ${count}`);
