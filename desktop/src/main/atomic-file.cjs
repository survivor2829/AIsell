const fs = require("node:fs");
const path = require("node:path");

const RETRYABLE_REPLACE_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

function wait(milliseconds) {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function uniqueTemporaryPath(file) {
  return `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function replaceWithRetry(temporary, file, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 8));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 30));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return { attempts: attempt };
    } catch (error) {
      const retryable = RETRYABLE_REPLACE_ERRORS.has(String(error?.code || ""));
      if (!retryable || attempt === attempts) throw error;
      options.onRetry?.({ attempt, code: String(error.code), file });
      wait(retryDelayMs * attempt);
    }
  }
  throw new Error("atomic_replace_failed");
}

function writeFileAtomic(file, content, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = uniqueTemporaryPath(file);
  let handle;
  try {
    handle = fs.openSync(temporary, "w", options.mode);
    fs.writeFileSync(handle, content, options.encoding);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    return replaceWithRetry(temporary, file, options);
  } catch (error) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

function writeJsonAtomic(file, value, options = {}) {
  const suffix = options.trailingNewline === false ? "" : "\n";
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}${suffix}`, {
    ...options,
    encoding: "utf8"
  });
}

module.exports = {
  RETRYABLE_REPLACE_ERRORS,
  replaceWithRetry,
  uniqueTemporaryPath,
  writeFileAtomic,
  writeJsonAtomic
};
