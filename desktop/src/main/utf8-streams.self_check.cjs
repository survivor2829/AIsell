// Text read from a child process, a pipe or an HTTP reply arrives in chunks; a Chinese character can be
// split between two of them. Adding chunks up as text without decoding on the stream turns it into
// garbage (the Wan3 price page failed now and then this way, 2026-11-19; contact sync read 微信数据 as
// ������ in its self-check). Every handler in the main process and rpa that builds text from "data"
// chunks decodes on that stream (setEncoding / StringDecoder) or collects buffers and decodes once.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");

// Why: two chunks splitting 汉 decode correctly only when the stream decodes.
{
  const bytes = Buffer.from("汉字", "utf8"), naive = new PassThrough(), decoded = new PassThrough();
  let a = "", b = "";
  naive.on("data", (chunk) => { a += chunk; });
  decoded.setEncoding("utf8"); decoded.on("data", (chunk) => { b += chunk; });
  for (const stream of [naive, decoded]) { stream.write(bytes.subarray(0, 1)); stream.write(bytes.subarray(1)); }
  assert.notEqual(a, "汉字"); assert.equal(b, "汉字");
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// Each `<stream>.on("data", (<name>) => …)` handler that turns <name> into text needs `<stream>.setEncoding`
// (or a StringDecoder fed with <name>) in the same file.
function offendersIn(text, label) {
  const found = [];
  const handler = /([\w$.]+?)\??\.on\(\s*["']data["']\s*,\s*(?:\(\s*(\w+)\s*\)|(\w+))\s*=>/gu;
  for (const match of text.matchAll(handler)) {
    const stream = match[1], name = match[2] || match[3];
    const lineIndex = text.slice(0, match.index).split(/\r?\n/u).length - 1;
    // Only this handler: up to the next listener (or a few lines on), never the stream after it.
    const start = match.index + match[0].length, next = text.slice(start).search(/\.on(?:ce)?\(\s*["']/u);
    const body = text.slice(start, next < 0 ? start + 600 : start + Math.min(next, 600));
    const n = escape(name);
    const asText = new RegExp(`(?:\\+=\\s*(?:String\\(\\s*)?${n}\\b(?!\\.length)|\\+\\s*(?:String\\(\\s*)?${n}\\s*\\)|${n}\\.toString\\(\\s*(?:["']utf-?8["'])?\\s*\\))`, "u");
    if (!asText.test(body)) continue;
    const decodes = new RegExp(`${escape(stream)}\\??\\.setEncoding`, "u").test(text) || new RegExp(`Decoder\\.write\\(\\s*${n}\\b`, "u").test(body);
    if (!decodes) found.push(`${label}:${lineIndex + 1} ${stream} adds "${name}" into text without decoding on the stream`);
  }
  return found;
}
// The guard itself must catch the patterns found on 2026-11-19 and accept the fixed forms.
assert.equal(offendersIn('child.stdout.on("data", (chunk) => { out += chunk; });', "t").length, 1);
assert.equal(offendersIn('child.stderr?.on("data", (chunk) => { tail = (tail + String(chunk)).slice(-9); });', "t").length, 1);
assert.equal(offendersIn('res.on("data", (d) => { body += String(d); });', "t").length, 1);
assert.equal(offendersIn('child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });', "t").length, 1);
assert.equal(offendersIn('child.stdout.setEncoding("utf8");\nchild.stdout.on("data", (chunk) => { out += chunk; });', "t").length, 0);
assert.equal(offendersIn('child.stdout?.setEncoding?.("utf8");\nchild.stdout?.on("data", (chunk) => { out += chunk; });', "t").length, 0);
assert.equal(offendersIn('res.on("data", (chunk) => { size += chunk.length; parts.push(chunk); });', "t").length, 0);
assert.equal(offendersIn('child.stdout.on("data", (chunk) => { run.text += run.decoder.write(chunk); });', "t").length, 0);
// Decoding one stream does not excuse another stream in the same file.
assert.equal(offendersIn('child.stdout.setEncoding("utf8");\nchild.stdout.on("data", (c) => { a += c; });\nchild.stderr.on("data", (c) => { b += c; });', "t").length, 1);

const roots = ["src/main", "rpa"].map((dir) => path.join(__dirname, "..", "..", dir));
const files = roots.flatMap((root) => fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map((name) => path.join(root, name)) : [])
  .filter((file) => /\.(cjs|mjs|js)$/u.test(file) && !/self_check|node_modules/u.test(file));
const offenders = files.flatMap((file) => offendersIn(fs.readFileSync(file, "utf8"), path.relative(process.cwd(), file)));
assert.deepEqual(offenders, [], offenders.join("\n"));
console.log(`utf8 streams self-check passed: split characters decode on the stream; ${files.length} files scanned`);
