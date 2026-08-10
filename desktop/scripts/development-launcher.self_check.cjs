const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcher = fs.readFileSync(
  path.resolve(__dirname, "../..", "启动内部开发版.cmd"),
  "utf8"
);

assert.match(launcher, /dist-development\\index\.html/u);
assert.match(launcher, /node_modules\\electron\\dist\\electron\.exe/u);
assert.match(launcher, /electron\.exe" \.\s*$/mu);
assert.doesNotMatch(
  launcher,
  /resolveDefaultDevelopmentSidecarRuntime|Product detail or materials runtime/u,
  "optional product-detail and materials runtimes must not block the whole AI acquisition app"
);

console.log("development launcher self-check passed");
