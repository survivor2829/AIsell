function normalized(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

function distinctCandidates(candidates) {
  const seen = new Set();
  const items = Array.isArray(candidates) ? candidates : (candidates && typeof candidates === "object" ? [candidates] : []);
  return items.filter((candidate) => {
    const x = Math.round(Number(candidate?.x));
    const y = Math.round(Number(candidate?.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const key = `${x}:${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchesIdentity(candidate, query, expectedName) {
  const text = normalized(`${candidate?.name || ""} ${candidate?.automationId || ""} ${candidate?.text || ""}`);
  const identities = [expectedName, query].map(normalized).filter((value) => value.length >= 2);
  return identities.some((identity) => text.includes(identity));
}

function matchesVisualIdentity(candidate, expectedName) {
  const identity = normalized(expectedName);
  return identity.length >= 2 && normalized(candidate?.text).includes(identity);
}

function resolveWechatSearchResultObservation(observation = {}, identity = {}) {
  const query = String(identity.query ?? "").trim();
  const expectedName = String(identity.expectedName ?? "").trim();
  const uiaCandidates = distinctCandidates(observation.uiaCandidates);
  if (uiaCandidates.length === 1) {
    return { status: "selected", mode: "unique_local_uia", candidate: uiaCandidates[0] };
  }
  if (uiaCandidates.length > 1) {
    const matches = uiaCandidates.filter((candidate) => matchesIdentity(candidate, query, expectedName));
    return matches.length === 1
      ? { status: "selected", mode: "identity_matched_uia", candidate: matches[0] }
      : { status: "unverified", reason: "search_result_identity_unverified" };
  }

  const visualCandidates = distinctCandidates(observation.visualCandidates)
    .filter((candidate) => !/搜一搜|网络搜索|搜索网络/u.test(String(candidate?.text || "")));
  const visualMatches = visualCandidates.filter((candidate) => matchesVisualIdentity(candidate, expectedName));
  if (visualMatches.length === 1) {
    return { status: "selected", mode: "identity_matched_visual", candidate: visualMatches[0] };
  }
  if (visualMatches.length > 1 || visualCandidates.length > 0) {
    return { status: "unverified", reason: "search_result_identity_unverified" };
  }
  if (observation.ocrOk === true && observation.webSearchVisible === true) {
    return { status: "not_found", reason: "exact_search_result_not_found" };
  }
  return { status: "unverified", reason: "search_result_identity_unverified" };
}

function isVerifiedWechatSearchResultMode(mode) {
  return ["unique_local_uia", "identity_matched_uia", "identity_matched_visual"].includes(mode);
}

module.exports = { isVerifiedWechatSearchResultMode, resolveWechatSearchResultObservation };
