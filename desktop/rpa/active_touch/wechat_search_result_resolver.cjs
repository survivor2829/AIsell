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

function hasValidBounds(candidate) {
  const left = Number(candidate?.left);
  const top = Number(candidate?.top);
  const right = Number(candidate?.right);
  const bottom = Number(candidate?.bottom);
  const x = Number(candidate?.x);
  const y = Number(candidate?.y);
  return [left, top, right, bottom, x, y].every(Number.isFinite)
    && right > left
    && bottom > top
    && x >= left
    && x <= right
    && y >= top
    && y <= bottom;
}

function validRectangle(value) {
  const left = Number(value?.left);
  const top = Number(value?.top);
  const right = Number(value?.right);
  const bottom = Number(value?.bottom);
  return [left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top
    ? { left, top, right, bottom }
    : null;
}

function isInside(candidate, bounds) {
  return Number(candidate.left) >= bounds.left && Number(candidate.top) >= bounds.top
    && Number(candidate.right) <= bounds.right && Number(candidate.bottom) <= bounds.bottom;
}

function labelledWechatId(candidate) {
  const match = normalized(candidate?.text).match(/^(?:微信号|微信id|wechatid)[:：]?(.+)$/u);
  return match?.[1] || "";
}

function wechatIdLabelValue(candidate) {
  const match = normalized(candidate?.text).match(/^(?:微信号|微信id|wechatid)[:：]?(.*)$/u);
  return match ? match[1] : null;
}

function followsIdentityFragment(previous, candidate) {
  const overlap = Math.min(Number(previous.bottom), Number(candidate.bottom))
    - Math.max(Number(previous.top), Number(candidate.top));
  const previousHeight = Number(previous.bottom) - Number(previous.top);
  const candidateHeight = Number(candidate.bottom) - Number(candidate.top);
  const scale = Math.max(previousHeight, candidateHeight);
  const sameLine = overlap >= Math.min(previousHeight, candidateHeight) / 2
    && Number(candidate.left) >= Number(previous.left)
    && Number(candidate.left) - Number(previous.right) <= scale * 2.5;
  const verticalGap = Number(candidate.top) - Number(previous.bottom);
  const stacked = verticalGap >= -scale / 4
    && verticalGap <= scale * 1.5
    && Number(candidate.left) <= Number(previous.right) + scale * 2.5
    && Number(candidate.right) >= Number(previous.left) - scale;
  return sameLine || stacked;
}

function labelledWechatIdCandidates(candidates, query, webSearchTop) {
  const target = normalized(query);
  const labelled = candidates.filter((candidate) => wechatIdLabelValue(candidate) !== null);
  return labelled.map((anchor) => {
    let value = wechatIdLabelValue(anchor);
    if (!target || value === target || !target.startsWith(value)) return anchor;
    let previous = anchor;
    const acceptedFragments = [];
    const fragments = candidates
      .filter((candidate) => candidate !== anchor
        && wechatIdLabelValue(candidate) === null
        && Number(candidate.bottom) <= webSearchTop
        && (Number(candidate.top) >= Number(anchor.top) - (Number(anchor.bottom) - Number(anchor.top)) / 4))
      .sort((left, right) => Number(left.top) - Number(right.top) || Number(left.left) - Number(right.left));
    for (const fragment of fragments) {
      if (!followsIdentityFragment(previous, fragment)) continue;
      const next = value + normalized(fragment.text);
      if (!target.startsWith(next)) continue;
      value = next;
      previous = fragment;
      acceptedFragments.push(fragment);
      if (value === target) {
        return {
          ...anchor,
          text: `${anchor.text}${acceptedFragments.map((item) => item.text).join("")}`,
          right: Math.max(Number(anchor.right), Number(fragment.right)),
          bottom: Math.max(Number(anchor.bottom), Number(fragment.bottom)),
          reconstructed: true
        };
      }
    }
    return anchor;
  });
}

function isNetworkSearchLabel(candidate, query) {
  const text = normalized(candidate?.text);
  const expectedQuery = normalized(query);
  const labels = ["搜一搜", "网络搜索", "搜索网络", "搜索网络结果"];
  for (const label of labels) {
    if (text === label || (expectedQuery && text === `${label}${expectedQuery}`)) return true;
  }
  return false;
}

function composesNetworkEcho(candidate, webCandidate) {
  const verticalOverlap = Math.min(Number(candidate.bottom), Number(webCandidate.bottom))
    - Math.max(Number(candidate.top), Number(webCandidate.top));
  const horizontalOverlap = Math.min(Number(candidate.right), Number(webCandidate.right))
    - Math.max(Number(candidate.left), Number(webCandidate.left));
  const horizontalGap = Math.max(0, Number(candidate.left) - Number(webCandidate.right), Number(webCandidate.left) - Number(candidate.right));
  const verticalGap = Math.max(0, Number(candidate.top) - Number(webCandidate.bottom), Number(webCandidate.top) - Number(candidate.bottom));
  const minimumHeight = Math.min(Number(candidate.bottom) - Number(candidate.top), Number(webCandidate.bottom) - Number(webCandidate.top));
  const minimumWidth = Math.min(Number(candidate.right) - Number(candidate.left), Number(webCandidate.right) - Number(webCandidate.left));
  const sameLine = verticalOverlap >= minimumHeight / 2 && horizontalGap <= Math.max(12, minimumHeight);
  // Current WeChat may render "搜索网络结果" as a section header and the
  // echoed query on the following row.  Treat only a tightly bounded exact
  // query directly below that verified header as part of the web section.
  const tightlyStacked = Number(candidate.top) >= Number(webCandidate.top)
    && horizontalOverlap >= minimumWidth / 2
    && verticalGap <= Math.max(48, minimumHeight * 2);
  return sameLine || tightlyStacked;
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

  const cropBounds = validRectangle(observation.cropBounds);
  const visualItems = Array.isArray(observation.visualCandidates) ? observation.visualCandidates
    : observation.visualCandidates && typeof observation.visualCandidates === "object" ? [observation.visualCandidates] : [];
  const webItems = Array.isArray(observation.webSearchCandidates) ? observation.webSearchCandidates
    : observation.webSearchCandidates && typeof observation.webSearchCandidates === "object" ? [observation.webSearchCandidates] : [];
  if (observation.ocrOk !== true || !cropBounds
    || [...visualItems, ...webItems].some((candidate) => !hasValidBounds(candidate) || !isInside(candidate, cropBounds))) {
    return { status: "unverified", reason: "search_result_identity_unverified" };
  }
  const visualCandidates = distinctCandidates(visualItems);
  const webSearchCandidates = distinctCandidates(webItems);
  if (!webSearchCandidates.length || webSearchCandidates.some((candidate) => !isNetworkSearchLabel(candidate, query))) {
    return { status: "unverified", reason: "search_result_identity_unverified" };
  }
  const webSearchTop = Math.min(...webSearchCandidates.map((candidate) => Number(candidate.top)));
  const reportedWebSearchTop = Number(observation.webSearchTop);
  if (!Number.isFinite(reportedWebSearchTop) || reportedWebSearchTop !== webSearchTop
    || reportedWebSearchTop < cropBounds.top || reportedWebSearchTop >= cropBounds.bottom) {
    return { status: "unverified", reason: "search_result_identity_unverified" };
  }
  const labelledCandidates = labelledWechatIdCandidates(visualCandidates, query, webSearchTop)
    .filter((candidate) => labelledWechatId(candidate));
  const exactLabelledCandidates = labelledCandidates.filter((candidate) => labelledWechatId(candidate) === normalized(query));
  const exactLocalCandidates = exactLabelledCandidates.filter((candidate) => Number(candidate.bottom) <= webSearchTop);
  if (exactLocalCandidates.length === 1 && labelledCandidates.length === 1) {
    return { status: "selected", mode: "exact_wechat_id_visual", candidate: exactLocalCandidates[0] };
  }
  const queryEcho = normalized(query);
  const unexplainedCandidates = visualCandidates.filter((candidate) => normalized(candidate?.text) !== queryEcho
    || !webSearchCandidates.some((webCandidate) => composesNetworkEcho(candidate, webCandidate)));
  if (labelledCandidates.length > 0 || unexplainedCandidates.length > 0) {
    return { status: "unverified", reason: "search_result_identity_unverified" };
  }
  return { status: "not_found", reason: "exact_search_result_not_found" };
}

function isVerifiedWechatSearchResultMode(mode) {
  return ["unique_local_uia", "identity_matched_uia", "exact_wechat_id_visual"].includes(mode);
}

module.exports = { isVerifiedWechatSearchResultMode, resolveWechatSearchResultObservation };
