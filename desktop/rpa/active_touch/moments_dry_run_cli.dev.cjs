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
  let expectedWindow;
  let targetPost;
  const expectedWindowRequired = args.includes("--expected-window-base64");
  const expectedWindowBase64 = valueAfter(args, "--expected-window-base64");
  if (expectedWindowBase64) {
    try {
      const parsed = JSON.parse(Buffer.from(expectedWindowBase64, "base64").toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) expectedWindow = parsed;
    } catch {}
  }
  const targetPostRequired = args.includes("--target-post-base64");
  const targetPostBase64 = valueAfter(args, "--target-post-base64");
  if (targetPostBase64) {
    try {
      const parsed = JSON.parse(Buffer.from(targetPostBase64, "base64").toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) targetPost = parsed;
    } catch {}
  }
  return prepareMomentsDryRun(optionalValueAfter(args, "--data-dir"), {
    mode: valueAfter(args, "--mode"),
    likeEnabled: args.includes("--like"),
    commentEnabled: args.includes("--comment-enabled"),
    commentText: Buffer.from(valueAfter(args, "--comment-text-base64"), "base64").toString("utf8"),
    ...(args.includes("--allow-body-only") ? { allowBodyOnly: true } : {}),
    ...(targetPostRequired ? { targetPostRequired: true, targetPost } : {}),
    ...(expectedWindowRequired ? { expectedWindowRequired: true, expectedWindow } : {})
  });
}

if (require.main === module) {
  const result = main(process.argv);
  console.log(JSON.stringify(result));
  process.exitCode = result.error ? 1 : 0;
}

module.exports = { main };
