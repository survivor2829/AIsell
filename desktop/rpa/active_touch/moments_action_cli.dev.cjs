#!/usr/bin/env node

const {
  executeMomentsComment,
  executeMomentsLike,
  inspectMomentsMenu
} = require("./moments_action.dev.cjs");

function valueAfter(args, flag) {
  const index = args.lastIndexOf(flag);
  return index === -1 || index === args.length - 1 ? "" : args[index + 1];
}

function optionalValueAfter(args, flag) {
  const value = valueAfter(args, flag);
  return value || undefined;
}

async function main(argv) {
  const [command = "", ...args] = argv.slice(2);
  const options = {
    baseDir: optionalValueAfter(args, "--data-dir"),
    observationId: valueAfter(args, "--observation-id")
  };
  const handlers = {
    "moments-inspect-menu": () => inspectMomentsMenu(options),
    "moments-like": () => executeMomentsLike(options),
    "moments-comment": () => executeMomentsComment({
      ...options,
      commentText: Buffer.from(valueAfter(args, "--comment-text-base64"), "base64").toString("utf8"),
      ...(args.includes("--enhanced-readback") ? { enhancedReadback: true } : {})
    })
  };
  if (!handlers[command]) {
    return {
      ok: false,
      action: command || "moments-action",
      status: "blocked",
      blocked_reason: "moments_action_invalid",
      error: `Unknown Moments action: ${command}`,
      real_action_attempted: false
    };
  }
  return handlers[command]();
}

if (require.main === module) {
  void main(process.argv).then((result) => {
    console.log(JSON.stringify(result));
    process.exitCode = result?.error ? 1 : 0;
  }).catch((error) => {
    const command = String(process.argv[2] || "moments-action");
    console.log(JSON.stringify({
      ok: false,
      action: command,
      status: "outcome_unknown",
      blocked_reason: "moments_action_failed",
      error: error instanceof Error ? error.message : "Moments action failed",
      real_action_attempted: null
    }));
    process.exitCode = 1;
  });
}

module.exports = { main };
