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

function candidateName(candidate) {
  const explicit = candidate?.displayName || candidate?.nickname || candidate?.name || candidate?.title;
  return normalized(explicit || "");
}

function hasNameConflict(candidate, siblings, expectedName, query) {
  const expected = normalized(expectedName);
  if (!expected) return false;
  const target = candidateName(candidate);
  const nearby = [candidate, ...(Array.isArray(siblings) ? siblings : [])].filter((item, index, all) => all.indexOf(item) === index);
  return nearby.some((item) => {
    const explicit = candidateName(item);
    if (!explicit || explicit === expected || explicit.includes(expected) || expected.includes(explicit)) return false;
    const text = normalized(item?.text || "");
    if (!text || text.includes(normalized(query)) || text.includes("微信号") || text.includes("wechatid")) return false;
    return explicit === text || text.includes(explicit);
  }) || (target && target !== expected && !target.includes(expected) && !expected.includes(target));
}

function isNetworkLookupText(value) {
  return normalized(value).includes("网络查找微信号");
}

function isNetworkLookupCandidate(candidate) {
  return isNetworkLookupText(`${candidate?.name || ""} ${candidate?.automationId || ""} ${candidate?.text || ""}`);
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

function sharesVisualRow(left, right) {
  if (!hasValidBounds(left) || !hasValidBounds(right)) return false;
  const overlap = Math.min(Number(left.bottom), Number(right.bottom)) - Math.max(Number(left.top), Number(right.top));
  const minimumHeight = Math.min(Number(left.bottom) - Number(left.top), Number(right.bottom) - Number(right.top));
  const horizontalGap = Math.max(0, Number(left.left) - Number(right.right), Number(right.left) - Number(left.right));
  return overlap >= minimumHeight / 2 && horizontalGap <= Math.max(36, minimumHeight * 3);
}

function sharesCompactLocalSurface(left, right) {
  if (!hasValidBounds(left) || !hasValidBounds(right)) return false;
  const horizontalOverlap = Math.min(Number(left.right), Number(right.right)) - Math.max(Number(left.left), Number(right.left));
  const minimumWidth = Math.min(Number(left.right) - Number(left.left), Number(right.right) - Number(right.left));
  const verticalGap = Math.max(0, Number(left.top) - Number(right.bottom), Number(right.top) - Number(left.bottom));
  const minimumHeight = Math.min(Number(left.bottom) - Number(left.top), Number(right.bottom) - Number(right.top));
  return horizontalOverlap >= minimumWidth / 2 && verticalGap <= Math.max(18, minimumHeight);
}

function sharesLocalResultColumn(left, right) {
  if (!hasValidBounds(left) || !hasValidBounds(right)) return false;
  const horizontalOverlap = Math.min(Number(left.right), Number(right.right)) - Math.max(Number(left.left), Number(right.left));
  const minimumWidth = Math.min(Number(left.right) - Number(left.left), Number(right.right) - Number(right.left));
  return horizontalOverlap >= minimumWidth / 2;
}

function networkLookupRowCandidates(candidates, query) {
  const sorted = [...candidates].sort((left, right) => Number(left.top) - Number(right.top) || Number(left.left) - Number(right.left));
  const blocked = new Set();
  const queryText = normalized(query);
  for (const [index, anchor] of sorted.entries()) {
    if (!normalized(anchor.text).includes("网络查找")) continue;
    const surface = [anchor];
    let combined = normalized(anchor.text);
    let previous = anchor;
    for (const candidate of sorted.slice(index + 1)) {
      if (!sharesVisualRow(previous, candidate) && !followsIdentityFragment(previous, candidate)) break;
      surface.push(candidate);
      combined += normalized(candidate.text);
      previous = candidate;
      if (combined.includes("网络查找微信号") && (!queryText || combined.includes(queryText))) break;
    }
    if (combined.includes("网络查找微信号")) surface.forEach((candidate) => blocked.add(candidate));
  }
  return blocked;
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
  const text = normalized(candidate?.text).replace(/^[^\p{L}\p{N}]{1,2}/u, "");
  const expectedQuery = normalized(query);
  const labels = ["搜一搜", "网络搜索", "搜索网络", "搜索网络结果"];
  for (const label of labels) {
    if (text === label || (expectedQuery && text === `${label}${expectedQuery}`)) return true;
  }
  return false;
}

function isLocalContactSection(value) {
  const text = normalized(value);
  return /^(?:最)?常.{0,2}用$/u.test(text) || ["联系人", "最近联系人", "好友"].includes(text);
}

function isOtherSearchSection(value) {
  return ["群聊", "聊天记录", "公众号", "小程序", "文件", "文件传输"].includes(normalized(value));
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

function isNearbyLocalResult(candidate, webSearchCandidates, webSearchTop) {
  const height = Number(candidate.bottom) - Number(candidate.top);
  if (Number(candidate.bottom) > webSearchTop || webSearchTop - Number(candidate.bottom) > Math.max(72, height * 3)) return false;
  return webSearchCandidates.some((webCandidate) => {
    const overlap = Math.min(Number(candidate.right), Number(webCandidate.right))
      - Math.max(Number(candidate.left), Number(webCandidate.left));
    return overlap > 0;
  });
}

function uniqueCompactLocalSurface(visualCandidates, webSearchTop, query, expectedName, wechatIdSearch = false) {
  const nearby = (wechatIdSearch ? visualCandidates : visualCandidates
    .filter((candidate) => {
      const height = Number(candidate.bottom) - Number(candidate.top);
      return Number(candidate.bottom) <= webSearchTop
        && webSearchTop - Number(candidate.bottom) <= Math.max(72, height * 3);
    }))
    .sort((left, right) => Number(left.top) - Number(right.top));
  if (!nearby.length) return null;

  const groups = [];
  for (const candidate of nearby) {
    const current = groups.at(-1);
    const height = Number(candidate.bottom) - Number(candidate.top);
    const gapLimit = wechatIdSearch ? height * 1.5 : Math.max(10, Math.min(18, height * 0.6));
    if (!current || Number(candidate.top) - current.bottom > gapLimit) {
      groups.push({ items: [candidate], bottom: Number(candidate.bottom) });
    } else {
      current.items.push(candidate);
      current.bottom = Math.max(current.bottom, Number(candidate.bottom));
    }
  }
  if (groups.length !== 1) return null;

  const items = groups[0].items;
  // A single friend contributes at most a name line and its smaller ID line.
  // More OCR lines may hide another friend; do not infer uniqueness from a
  // shared section heading or from proximity alone.
  if (wechatIdSearch && items.length > 2) return null;
  const combinedText = items.map((candidate) => String(candidate.text || "")).join(" ");
  if (isNetworkLookupText(combinedText)) return null;
  const bareQueryCandidate = items.find((candidate) => normalized(candidate.text) === normalized(query));
  if (bareQueryCandidate && (wechatIdSearch
    ? items.length < 2
    : !items.some((candidate) => candidate !== bareQueryCandidate
      && matchesIdentity(candidate, "", expectedName)
      && sharesCompactLocalSurface(candidate, bareQueryCandidate)))) return null;
  const left = Math.min(...items.map((candidate) => Number(candidate.left)));
  const top = Math.min(...items.map((candidate) => Number(candidate.top)));
  const right = Math.max(...items.map((candidate) => Number(candidate.right)));
  const bottom = Math.max(...items.map((candidate) => Number(candidate.bottom)));
  return {
    text: items.map((candidate) => String(candidate.text || "")).join(" "),
    left,
    top,
    right,
    bottom,
    x: wechatIdSearch ? Number(items[0].x) : Math.round((left + right) / 2),
    y: wechatIdSearch ? Number(items[0].y) : Math.round((top + bottom) / 2)
  };
}

function resolveWechatSearchResultObservation(observation = {}, identity = {}) {
  const reject = (rule_id, reason = "search_result_identity_unverified") => ({
    status: reason === "exact_search_result_not_found" ? "not_found" : "unverified", reason, rule_id,
    diagnostics: { rule_id, candidate_count: distinctCandidates(observation.uiaCandidates).length,
      visual_candidate_count: Array.isArray(observation.visualCandidates) ? observation.visualCandidates.length : 0,
      ocr_ok: observation.ocrOk === true }
  });
  const query = String(identity.query ?? "").trim();
  const expectedName = String(identity.expectedName ?? "").trim();
  const wechatIdSearch = identity.queryType === "wechat_id";
  const uiaCandidates = distinctCandidates(observation.uiaCandidates).filter((candidate) => !isNetworkLookupCandidate(candidate));
  if (uiaCandidates.length === 1) {
    if (wechatIdSearch) return { status: "selected", mode: "unique_local_wechat_id_uia", candidate: uiaCandidates[0] };
    return matchesIdentity(uiaCandidates[0], "", expectedName) && !hasNameConflict(uiaCandidates[0], [], expectedName, query)
      ? { status: "selected", mode: "unique_local_uia", candidate: uiaCandidates[0] }
      : reject(hasNameConflict(uiaCandidates[0], [], expectedName, query) ? "search-r016" : "search-r001", hasNameConflict(uiaCandidates[0], [], expectedName, query) ? "wechat_id_name_conflict" : "search_result_identity_unverified");
  }
  if (uiaCandidates.length > 1) {
    if (wechatIdSearch) return reject("search-r002");
    const matches = uiaCandidates.filter((candidate) => matchesIdentity(candidate, "", expectedName));
    return matches.length === 1 && !hasNameConflict(matches[0], uiaCandidates, expectedName, query)
      ? { status: "selected", mode: "identity_matched_uia", candidate: matches[0] }
      : reject(matches.length === 0 ? "search-r001" : "search-r002");
  }

  const cropBounds = validRectangle(observation.cropBounds);
  const visualItems = Array.isArray(observation.visualCandidates) ? observation.visualCandidates
    : observation.visualCandidates && typeof observation.visualCandidates === "object" ? [observation.visualCandidates] : [];
  const webItems = Array.isArray(observation.webSearchCandidates) ? observation.webSearchCandidates
    : observation.webSearchCandidates && typeof observation.webSearchCandidates === "object" ? [observation.webSearchCandidates] : [];
  if (observation.ocrOk !== true || !cropBounds
    || [...visualItems, ...webItems].some((candidate) => !hasValidBounds(candidate) || !isInside(candidate, cropBounds))) {
    return reject(observation.ocrOk !== true ? "search-r003" : !cropBounds ? "search-r004"
      : [...visualItems, ...webItems].some(candidate => !hasValidBounds(candidate)) ? "search-r005" : "search-r006");
  }
  const observedVisualCandidates = distinctCandidates(visualItems);
  const networkLookupCandidates = networkLookupRowCandidates(observedVisualCandidates, query);
  const visualCandidates = observedVisualCandidates.filter((candidate) => !networkLookupCandidates.has(candidate));
  const webSearchCandidates = distinctCandidates([
    ...webItems,
    ...visualCandidates.filter((candidate) => isNetworkSearchLabel(candidate, query))
  ]);
  const webSearchTop = webSearchCandidates.length
    ? Math.min(...webSearchCandidates.map((candidate) => Number(candidate.top)))
    : cropBounds.bottom;
  const localVisualCandidates = visualCandidates.filter((candidate) => Number(candidate.bottom) <= webSearchTop);
  if (wechatIdSearch) {
    const reportedTop = observation.webSearchTop;
    if (webSearchCandidates.length > 1 || (webSearchCandidates.length && (webSearchCandidates.some((candidate) => !isNetworkSearchLabel(candidate, query))
      || (reportedTop !== null && reportedTop !== undefined && reportedTop !== "" && Number(reportedTop) !== webSearchTop)
      || webSearchTop < cropBounds.top || webSearchTop >= cropBounds.bottom))) return reject("search-r011");
    if (!webSearchCandidates.length) return reject("search-r008");
    const contactHeader = localVisualCandidates.find((candidate) => isLocalContactSection(candidate.text));
    if (localVisualCandidates.filter((candidate) => labelledWechatId(candidate)).length > 1) return reject("search-r007");
    const nextSectionTop = contactHeader ? Math.min(webSearchTop, ...[
      ...localVisualCandidates.filter((candidate) => Number(candidate.top) > Number(contactHeader.top) && isOtherSearchSection(candidate.text)),
      ...networkLookupCandidates
    ].map((candidate) => Number(candidate.top))) : webSearchTop;
    const headerHeight = contactHeader ? Number(contactHeader.bottom) - Number(contactHeader.top) : 0;
    const sectionCandidates = contactHeader ? localVisualCandidates.filter((candidate) => Number(candidate.top) >= Number(contactHeader.bottom)
      && Number(candidate.bottom) <= nextSectionTop
      && Number(candidate.left) > Number(contactHeader.left) + headerHeight * 0.5)
      .sort((left, right) => Number(left.top) - Number(right.top) || Number(left.left) - Number(right.left)) : [];
    const firstItem = sectionCandidates[0];
    // The broad OCR crop can include the conversation pane.  Keep only text in the
    // first local row's horizontal column; this follows live geometry across DPI and
    // window sizes without trusting gray identity text or machine-specific pixels.
    const sectionItems = firstItem
      ? sectionCandidates.filter((candidate) => candidate === firstItem || sharesLocalResultColumn(firstItem, candidate))
      : [];
    const localSurface = firstItem && Number(firstItem.top) - Number(contactHeader.bottom) <= headerHeight * 4
      ? uniqueCompactLocalSurface(sectionItems, nextSectionTop, query, expectedName, true) : null;
    if (localSurface) return { status: "selected", mode: "unique_local_wechat_id_visual", candidate: localSurface };
    if (!localVisualCandidates.length) return reject("search-r015", "exact_search_result_not_found");
    const exactLabelled = labelledWechatIdCandidates(localVisualCandidates, query, webSearchTop)
      .filter((candidate) => labelledWechatId(candidate) === normalized(query));
    if (exactLabelled.length === 1) return { status: "selected", mode: "exact_wechat_id_visual", candidate: exactLabelled[0] };
    return reject(webSearchCandidates.length ? "search-r014" : "search-r008");
  }
  const labelledAcrossCrop = labelledWechatIdCandidates(localVisualCandidates, query, webSearchTop)
    .filter((candidate) => labelledWechatId(candidate));
  const exactLabelledAcrossCrop = labelledAcrossCrop.filter((candidate) => labelledWechatId(candidate) === normalized(query));
  if (exactLabelledAcrossCrop.length === 1) {
    const siblings = localVisualCandidates.filter((candidate) => candidate !== exactLabelledAcrossCrop[0]
      && (sharesVisualRow(candidate, exactLabelledAcrossCrop[0]) || sharesCompactLocalSurface(candidate, exactLabelledAcrossCrop[0])));
    if (hasNameConflict(exactLabelledAcrossCrop[0], siblings, expectedName, query)) return reject("search-r016", "wechat_id_name_conflict");
    return { status: "selected", mode: "exact_wechat_id_visual", candidate: exactLabelledAcrossCrop[0] };
  }
  if (labelledAcrossCrop.length === 1) {
    return { status: "selected", mode: "unique_local_visual", candidate: labelledAcrossCrop[0] };
  }
  if (labelledAcrossCrop.length > 1) {
    return reject("search-r007");
  }
  if (!webSearchCandidates.length || webSearchCandidates.some((candidate) => !isNetworkSearchLabel(candidate, query))) {
    return reject(!webSearchCandidates.length ? "search-r008" : "search-r009");
  }
  const hasReportedWebSearchTop = observation.webSearchTop !== null
    && observation.webSearchTop !== undefined
    && observation.webSearchTop !== "";
  const reportedWebSearchTop = Number(observation.webSearchTop);
  if ((hasReportedWebSearchTop && (!Number.isFinite(reportedWebSearchTop) || reportedWebSearchTop !== webSearchTop))
    || webSearchTop < cropBounds.top || webSearchTop >= cropBounds.bottom) {
    return reject(hasReportedWebSearchTop && !Number.isFinite(reportedWebSearchTop) ? "search-r010"
      : hasReportedWebSearchTop && reportedWebSearchTop !== webSearchTop ? "search-r011" : "search-r012");
  }
  const labelledCandidates = labelledWechatIdCandidates(localVisualCandidates, query, webSearchTop)
    .filter((candidate) => labelledWechatId(candidate));
  const exactLabelledCandidates = labelledCandidates.filter((candidate) => labelledWechatId(candidate) === normalized(query));
  const exactLocalCandidates = exactLabelledCandidates.filter((candidate) => Number(candidate.bottom) <= webSearchTop);
  if (exactLocalCandidates.length === 1 && labelledCandidates.length === 1) {
    return { status: "selected", mode: "exact_wechat_id_visual", candidate: exactLocalCandidates[0] };
  }
  const localLabelledCandidates = labelledCandidates.filter((candidate) => Number(candidate.bottom) <= webSearchTop);
  if (localLabelledCandidates.length === 1 && labelledCandidates.length === 1) {
    return { status: "selected", mode: "unique_local_visual", candidate: localLabelledCandidates[0] };
  }
  const queryEcho = normalized(query);
  const exactUnlabelledLocalCandidates = localVisualCandidates.filter((candidate) => normalized(candidate?.text) === queryEcho
    && !webSearchCandidates.some((webCandidate) => composesNetworkEcho(candidate, webCandidate))
    && isNearbyLocalResult(candidate, webSearchCandidates, webSearchTop)
    && localVisualCandidates.some((other) => other !== candidate
      && normalized(other?.text) !== queryEcho
      && matchesIdentity(other, "", expectedName)
      && sharesCompactLocalSurface(other, candidate)));
  if (labelledCandidates.length === 0 && exactUnlabelledLocalCandidates.length === 1) {
    return { status: "selected", mode: "exact_wechat_id_local_visual", candidate: exactUnlabelledLocalCandidates[0] };
  }
  const uniqueLocalSurface = labelledCandidates.length === 0
    ? uniqueCompactLocalSurface(localVisualCandidates, webSearchTop, query, expectedName)
    : null;
  if (uniqueLocalSurface) {
    return { status: "selected", mode: "unique_local_surface_visual", candidate: uniqueLocalSurface };
  }
  const unexplainedCandidates = localVisualCandidates.filter((candidate) => normalized(candidate?.text) !== queryEcho
    || !webSearchCandidates.some((webCandidate) => composesNetworkEcho(candidate, webCandidate)));
  if (labelledCandidates.length > 0 || unexplainedCandidates.length > 0) {
    return reject(labelledCandidates.length > 0 ? "search-r013" : "search-r014");
  }
  return reject("search-r015", "exact_search_result_not_found");
}

function isVerifiedWechatSearchResultMode(mode) {
  return ["unique_local_uia", "identity_matched_uia", "exact_wechat_id_visual", "unique_local_visual", "exact_wechat_id_local_visual", "unique_local_surface_visual", "unique_local_wechat_id_uia", "unique_local_wechat_id_visual"].includes(mode);
}

module.exports = { isVerifiedWechatSearchResultMode, resolveWechatSearchResultObservation };
