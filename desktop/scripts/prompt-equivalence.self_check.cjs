"use strict";
// What a customer computer sends (tokens, expanded by the gateway) must be exactly what the wording run sends, through
// every place the main process adjusts a prompt (user decision 2026-11-25: prompt wording lives on the server).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { builders } = require("./prompt-builders.cjs");
const { LIBRARY } = require("./prompt-library-sync.cjs");

const TOKEN = /⟦xiaoxi-prompt:([a-z0-9][a-z0-9_.-]{0,99})@([1-9][0-9]{0,3})⟧/gu;
const library = JSON.parse(fs.readFileSync(LIBRARY, "utf8"));
// The gateway's rule: every token inside any JSON string becomes its stored text.
const expand = (value) => typeof value === "string" ? value.replace(TOKEN, (_m, id, version) => library[`${id}@${version}`])
  : Array.isArray(value) ? value.map(expand) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) : value;
const hasToken = (value) => JSON.stringify(value).includes("⟦xiaoxi-prompt:");

(async () => {
  const environment = { ...process.env, XIAOXI_PROMPT_TOKENS: "1" };
  delete environment.XIAOXI_PROMPT_LIBRARY;
  const tokens = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "prompt-builders.cjs")], { env: environment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const wording = await builders();
  assert.deepEqual(Object.keys(tokens).sort(), Object.keys(wording).sort());
  let compared = 0;
  for (const [name, value] of Object.entries(wording)) {
    assert.ok(hasToken(tokens[name]), `${name}: a customer computer sends tokens, not wording`);
    assert.equal(JSON.stringify(expand(tokens[name])), JSON.stringify(value), `${name}: the token run sends different text`);
    compared += 1;
  }
  console.log(`prompt equivalence self-check passed: ${compared} assembly paths send the same text with tokens as with wording`);
})().catch((error) => { console.error(error); process.exit(1); });
