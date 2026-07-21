const COMMENT_READBACK_VERIFICATION_MODE = "unique_copy_menu_clipboard_sequence_ordinal_v2";

const COMMENT_READBACK_REQUIRED_PROOF_KEYS = Object.freeze([
  "commentCandidateUnique",
  "commentBoundsInsideLockedWindow",
  "popupDirectOwnerVerified",
  "popupStable",
  "popupPlacementAnchored",
  "copyMenuItemUnique",
  "copyMenuItemExact",
  "copyMenuBoundsInsidePopup",
  "clipboardSentinelInstalled",
  "clipboardSequenceChanged",
  "clipboardOwnedByLockedProcess",
  "clipboardOrdinalMatched",
  "clipboardRestored",
  "popupClosed"
]);

const RESULT_KEYS = Object.freeze([
  "ok",
  "status",
  "actionAttempted",
  "commentVerified",
  "observationId",
  "commentText",
  "verificationMode",
  "proof"
]);

const RESULT_KEY_SET = new Set(RESULT_KEYS);
const PROOF_KEY_SET = new Set(COMMENT_READBACK_REQUIRED_PROOF_KEYS);

function isPlainDataRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isForbiddenRawTextKey(key) {
  const compact = String(key).replace(/[\s_-]/gu, "").toLowerCase();
  return compact === "copiedtext"
    || compact === "clipboardtext"
    || compact === "rawcopiedtext"
    || compact === "rawclipboardtext";
}

function containsForbiddenRawTextField(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "string" && isForbiddenRawTextKey(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return true;
    if (containsForbiddenRawTextField(descriptor.value, seen)) return true;
  }
  return false;
}

function hasExactKeys(record, allowedKeys, allowedKeySet) {
  const keys = Object.keys(record);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeySet.has(key));
}

function validCommentReadbackProof(result, { observationId, commentText } = {}) {
  try {
    if (typeof observationId !== "string" || typeof commentText !== "string") return false;
    if (!isPlainDataRecord(result) || containsForbiddenRawTextField(result)) return false;
    if (!hasExactKeys(result, RESULT_KEYS, RESULT_KEY_SET)) return false;
    if (result.ok !== true
      || result.status !== "readback_verified"
      || result.actionAttempted !== false
      || result.commentVerified !== true
      || result.observationId !== observationId
      || result.commentText !== commentText
      || result.verificationMode !== COMMENT_READBACK_VERIFICATION_MODE) {
      return false;
    }

    if (!isPlainDataRecord(result.proof)) return false;
    if (!hasExactKeys(result.proof, COMMENT_READBACK_REQUIRED_PROOF_KEYS, PROOF_KEY_SET)) return false;
    return COMMENT_READBACK_REQUIRED_PROOF_KEYS.every((key) => result.proof[key] === true);
  } catch {
    return false;
  }
}

function sanitizeCommentReadbackProof(result) {
  try {
    if (!isPlainDataRecord(result)) return null;
    const sourceProof = isPlainDataRecord(result.proof) ? result.proof : {};
    return {
      ok: result.ok,
      status: result.status,
      actionAttempted: result.actionAttempted,
      commentVerified: result.commentVerified,
      observationId: result.observationId,
      commentText: result.commentText,
      verificationMode: result.verificationMode,
      proof: Object.fromEntries(COMMENT_READBACK_REQUIRED_PROOF_KEYS.map((key) => [
        key,
        sourceProof[key] === true
      ]))
    };
  } catch {
    return null;
  }
}

module.exports = {
  COMMENT_READBACK_VERIFICATION_MODE,
  COMMENT_READBACK_REQUIRED_PROOF_KEYS,
  validCommentReadbackProof,
  sanitizeCommentReadbackProof
};
