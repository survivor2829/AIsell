"use strict";
// Prompt wording lives on the server (user decision 2026-11-25). This check keeps the app and the library in step:
// every token the code asks for exists, the shipped size tables match, and no stored wording is left in shipped code.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { outputs, LIBRARY } = require("./prompt-library-sync.cjs");

const desktop = path.resolve(__dirname, "..");
const library = JSON.parse(fs.readFileSync(LIBRARY, "utf8"));
const SHIPPED = ["src/main", "src/shared", "src/renderer", "rpa", "sidecars/content-engine/content_engine", "sidecars/product-detail/app"];
const SKIP = /(self_check|[\\/]tests?[\\/]|[\\/]test_|[\\/]node_modules[\\/]|[\\/]__pycache__[\\/]|[\\/]docs[\\/]|[\\/]scripts[\\/]|prompt_sizes\.py$|prompt-sizes\.cjs$)/u;

function files(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) files(full, out);
    else if (/\.(c?js|tsx?|py|j2|html)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

const shipped = SHIPPED.flatMap((dir) => files(path.join(desktop, dir)));
const referenced = new Set();
const REF = /(?:prompt_ref|promptRef)\(\s*["']([a-z0-9][a-z0-9_.-]{0,99})["'](?:\s*,\s*(\d+))?/gu;
const LITERAL = /⟦xiaoxi-prompt:([a-z0-9][a-z0-9_.-]{0,99})@(\d+)⟧/gu;
for (const file of shipped) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(REF)) referenced.add(`${match[1]}@${match[2] || 1}`);
  for (const match of text.matchAll(LITERAL)) referenced.add(`${match[1]}@${match[2]}`);
}

// 1. Every token the app sends is known to the gateway (an unknown one is refused before any paid call).
const missing = [...referenced].filter((key) => !(key in library));
assert.deepEqual(missing, [], `prompt tokens not in server/provider-gateway/prompt-library.json: ${missing.join(", ")}`);

// 2. The size tables shipped with the app match the library.
for (const [file, text] of Object.entries(outputs())) {
  assert.equal((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "").replace(/\r\n/gu, "\n"), text, `${path.relative(desktop, file)} is out of date: run node scripts/prompt-library-sync.cjs`);
}

// 3. No moved wording is left behind in shipped code (a long stored passage found verbatim means a copy remains).
const longTexts = Object.entries(library).filter(([, text]) => text.trim().length >= 60);
for (const file of shipped) {
  const text = fs.readFileSync(file, "utf8");
  for (const [key, stored] of longTexts) {
    const probe = stored.trim().slice(0, 60);
    assert.ok(!text.includes(probe), `${path.relative(desktop, file)} still contains the wording of ${key}`);
  }
}

// 4. The helpers produce tokens when no library is at hand (as on a customer computer).
const { execFileSync } = require("node:child_process");
const token = execFileSync(process.execPath, ["-e", "process.stdout.write(require('./src/shared/prompt-ref.cjs').promptRef('demo.check'))"],
  { cwd: desktop, env: { ...process.env, XIAOXI_PROMPT_TOKENS: "1" }, encoding: "utf8" });
assert.equal(token, "⟦xiaoxi-prompt:demo.check@1⟧");

console.log(`prompt library self-check passed: ${referenced.size} tokens in use, all known; size tables current; no moved wording left in shipped code`);
