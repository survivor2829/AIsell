#!/usr/bin/env node

const { prepareMomentsDryRun } = require("./moments_dry_run.dev.cjs");

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 || index === args.length - 1 ? "" : args[index + 1];
}

function optionalValueAfter(args, flag) {
  const index = args.lastIndexOf(flag);
  return index === -1 || index === args.length - 1 ? undefined : args[index + 1];
}

function main(argv) {
  const args = argv.slice(2);
  return prepareMomentsDryRun(optionalValueAfter(args, "--data-dir"), {
    mode: valueAfter(args, "--mode"),
    likeEnabled: args.includes("--like"),
    commentEnabled: args.includes("--comment-enabled"),
    commentText: Buffer.from(valueAfter(args, "--comment-text-base64"), "base64").toString("utf8")
  });
}

const result = main(process.argv);
console.log(JSON.stringify(result));
process.exitCode = result.error ? 1 : 0;
