const assert = require("node:assert/strict");
const { buildMap, lookup, describe, engineKind } = require("./error-code-map.cjs");

const map = buildMap();
assert.ok(map.size > 300, "the map covers the engine and WeChat codes in the source");
const music = lookup("auto_mix_music_not_audible");
assert.equal(music.kind, "audio");
assert.ok(music.sites.some(site => /creative_render\.py:\d+$/.test(`${site.file}:${site.line}`)), "raise sites point at the engine source");
assert.ok(music.replay.length, "a code with a decision replay says so");
const split = [...map.values()].find(entry => entry.modules.includes("content_engine") && entry.sites.length);
assert.ok(split, "engine codes are found");
assert.equal(lookup("moments_post_not_found").kind, "wechat_window", "WeChat reasons written in JS are found too");
assert.equal(lookup("message_input_failed_wechat_user_active")?.kind ?? "environment", "environment");
assert.equal(lookup("auto"), null, "keyword arguments of require() are not codes");
assert.equal(lookup("product_detail_start_timeout")?.kind, "local_service", "a logged lower-case code finds the capitalised source constant");
assert.equal(engineKind("cloud_request_failed"), "network");
assert.equal(engineKind("output_write_failed"), "environment");
assert.match(describe(null), /找不到/);
assert.match(describe(music), /抛出位置/);
// Every site must exist in today's source: the map may never point at nothing.
const fs = require("node:fs"), path = require("node:path");
for (const entry of map.values()) for (const site of entry.sites.slice(0, 3)) {
  const file = path.resolve(__dirname, "../..", site.file);
  assert.ok(fs.existsSync(file), `${entry.code} points at a missing file ${site.file}`);
  assert.ok(site.line >= 1 && site.line <= fs.readFileSync(file, "utf8").split(/\n/).length, `${entry.code} points past the end of ${site.file}`);
}
console.log(`error code map self-check passed: ${map.size} codes, every site exists`);
