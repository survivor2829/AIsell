const assert = require("node:assert/strict");

const {
  COMMENT_READBACK_VERIFICATION_MODE,
  COMMENT_READBACK_REQUIRED_PROOF_KEYS,
  validCommentReadbackProof,
  sanitizeCommentReadbackProof
} = require("./moments_comment_readback_proof.dev.cjs");

const observationId = "moments-observation-0717";
const commentText = "自动化测试，ＡＢＣ  🥂\n第二行";

function validResult() {
  return {
    ok: true,
    status: "readback_verified",
    actionAttempted: false,
    commentVerified: true,
    observationId,
    commentText,
    verificationMode: COMMENT_READBACK_VERIFICATION_MODE,
    proof: Object.fromEntries(COMMENT_READBACK_REQUIRED_PROOF_KEYS.map((key) => [key, true]))
  };
}

assert.equal(COMMENT_READBACK_VERIFICATION_MODE, "unique_copy_menu_clipboard_sequence_ordinal_v2");
assert.ok(Object.isFrozen(COMMENT_READBACK_REQUIRED_PROOF_KEYS));
assert.equal(validCommentReadbackProof(validResult(), { observationId, commentText }), true);

for (const [field, invalidValue] of [
  ["ok", false],
  ["status", "verified"],
  ["actionAttempted", true],
  ["commentVerified", false],
  ["observationId", `${observationId}-other`],
  ["commentText", `${commentText} `],
  ["verificationMode", "ocr_exact_text_v0"]
]) {
  const result = validResult();
  result[field] = invalidValue;
  assert.equal(validCommentReadbackProof(result, { observationId, commentText }), false, field);

  const missing = validResult();
  delete missing[field];
  assert.equal(validCommentReadbackProof(missing, { observationId, commentText }), false, `missing ${field}`);
}

for (const key of COMMENT_READBACK_REQUIRED_PROOF_KEYS) {
  for (const invalidValue of [false, undefined, 1, "true", null]) {
    const result = validResult();
    if (invalidValue === undefined) delete result.proof[key];
    else result.proof[key] = invalidValue;
    assert.equal(
      validCommentReadbackProof(result, { observationId, commentText }),
      false,
      `${key}=${String(invalidValue)}`
    );
  }
}

for (const extraValue of [true, false, { copiedText: commentText }]) {
  const result = validResult();
  result.proof.unexpectedProof = extraValue;
  assert.equal(validCommentReadbackProof(result, { observationId, commentText }), false);
}

for (const [key, value] of [
  ["copiedText", commentText],
  ["clipboardText", commentText],
  ["copied_text", commentText],
  ["rawClipboardText", commentText]
]) {
  const result = validResult();
  result[key] = value;
  assert.equal(validCommentReadbackProof(result, { observationId, commentText }), false, key);
}

const nestedRawText = validResult();
nestedRawText.proof.diagnostics = [{ clipboardText: commentText }];
assert.equal(validCommentReadbackProof(nestedRawText, { observationId, commentText }), false);

for (const differentText of [
  "自动化测试，ＡＢＣ \u00a0🥂\n第二行",
  "自动化测试,ＡＢＣ  🥂\n第二行",
  "自动化测试，ABC  🥂\n第二行",
  "自动化测试，ＡＢＣ  🥂️\n第二行",
  "自动化测试，ＡＢＣ  🥂\r\n第二行",
  "自动化测试，ＡＢＣ  🥂\n第二行\n"
]) {
  const result = validResult();
  result.commentText = differentText;
  assert.notEqual(result.commentText, commentText);
  assert.equal(validCommentReadbackProof(result, { observationId, commentText }), false, differentText);
}

const oldOcrMode = validResult();
oldOcrMode.verificationMode = "exact_comment_count_increment_and_editor_completion";
assert.equal(validCommentReadbackProof(oldOcrMode, { observationId, commentText }), false);

const oldClipboardV1Mode = validResult();
oldClipboardV1Mode.verificationMode = "unique_copy_menu_clipboard_sequence_ordinal_v1";
assert.equal(validCommentReadbackProof(oldClipboardV1Mode, { observationId, commentText }), false);

const unexpectedTopLevelField = validResult();
unexpectedTopLevelField.elapsedMs = 42;
assert.equal(validCommentReadbackProof(unexpectedTopLevelField, { observationId, commentText }), false);

const noisy = validResult();
noisy.copiedText = commentText;
noisy.elapsedMs = 42;
noisy.proof.clipboardText = commentText;
const sanitized = sanitizeCommentReadbackProof(noisy);
assert.equal(Object.hasOwn(sanitized, "copiedText"), false);
assert.equal(Object.hasOwn(sanitized, "elapsedMs"), false);
assert.equal(Object.hasOwn(sanitized.proof, "clipboardText"), false);
assert.equal(validCommentReadbackProof(sanitized, { observationId, commentText }), true);

const missingProof = validResult();
delete missingProof.proof.clipboardRestored;
const sanitizedMissingProof = sanitizeCommentReadbackProof(missingProof);
assert.equal(sanitizedMissingProof.proof.clipboardRestored, false);
assert.equal(validCommentReadbackProof(sanitizedMissingProof, { observationId, commentText }), false);

assert.equal(validCommentReadbackProof(null, { observationId, commentText }), false);
assert.equal(validCommentReadbackProof(validResult()), false);
assert.equal(sanitizeCommentReadbackProof(null), null);

console.log("moments comment readback proof self-check passed");
