"use strict";
// Prompt wording is kept on the server (user decision 2026-11-25): the app writes a token where a prompt used to be,
// and the provider gateway puts the stored text back before the request reaches a model
// (server/provider-gateway/prompt_library.py, prompt-library.json). The customer's own data is still filled in here,
// around the tokens. ⟦ ⟧ never clash with template braces ({name}, ${name}) or JSON escaping.
// Run from the source repository (development machine, CI), the server's prompt-library.json sits beside the code, so
// self-checks and local runs see the real wording (XIAOXI_PROMPT_LIBRARY can name another file). It is never packaged,
// so a customer computer only ever produces tokens. XIAOXI_PROMPT_TOKENS=1 forces tokens (to test that path).
const fs = require("node:fs");
const path = require("node:path");
const REPO_LIBRARY = path.resolve(__dirname, "..", "..", "..", "server", "provider-gateway", "prompt-library.json");

const OPEN = "⟦xiaoxi-prompt:";
const CLOSE = "⟧";
const ID = /^[a-z0-9][a-z0-9_.-]{0,99}$/u;
let library = null;

function stored() {
  if (process.env.XIAOXI_PROMPT_TOKENS === "1") return null;
  const file = process.env.XIAOXI_PROMPT_LIBRARY || (fs.existsSync(REPO_LIBRARY) ? REPO_LIBRARY : "");
  if (!file) return null;
  if (!library || library.file !== file) library = { file, entries: JSON.parse(fs.readFileSync(file, "utf8")) };
  return library.entries;
}

function promptRef(id, version = 1) {
  if (!ID.test(String(id)) || !Number.isInteger(version) || version < 1 || version > 9999) throw new Error(`invalid prompt id: ${id}@${version}`);
  const entries = stored();
  if (entries) {
    const text = entries[`${id}@${version}`];
    if (typeof text !== "string") throw new Error(`prompt not in library: ${id}@${version}`);
    return text;
  }
  return `${OPEN}${id}@${version}${CLOSE}`;
}

module.exports = { promptRef, PROMPT_TOKEN_OPEN: OPEN, PROMPT_TOKEN_CLOSE: CLOSE };
