// Text read from a child process, a pipe or an HTTP reply arrives in chunks; a Chinese character can be
// split between two of them. Adding chunks up as text without decoding on the stream turns it into
// garbage (the Wan3 price page failed now and then this way, 2026-11-19). Every place in the main
// process that builds text from "data" chunks decodes on the stream (setEncoding / StringDecoder) or
// collects buffers and decodes once.
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
// Guard: a file that adds data chunks into text must decode on the stream or collect buffers.
const roots = ["src/main", "rpa"].map((dir) => path.join(__dirname, "..", "..", dir));
const files = roots.flatMap((root) => fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map((name) => path.join(root, name)) : [])
  .filter((file) => /\.(cjs|mjs|js)$/u.test(file) && !/self_check|node_modules/u.test(file));
const offenders = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (!/\.on\(\s*["']data["']/u.test(text)) continue;
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (/\+=?\s*(?:chunk|d|data)\.toString\(/u.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${index + 1} adds chunk.toString() — decode on the stream instead`);
    // Adding raw chunks into text needs the stream to decode (setEncoding) or a StringDecoder in the same file.
    if (/(?:\+=\s*(?:chunk|d)\s*[;)]|\+\s*chunk\)|\+\s*String\(chunk\))/u.test(line) && !/setEncoding|StringDecoder/u.test(text))
      offenders.push(`${path.relative(process.cwd(), file)}:${index + 1} adds raw chunks into text without decoding on the stream`);
  });
}
assert.deepEqual(offenders, [], offenders.join("\n"));
console.log(`utf8 streams self-check passed: split characters decode on the stream; ${files.length} files scanned`);
