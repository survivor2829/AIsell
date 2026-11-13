// Split out of auto-reply-ipc.cjs (2026-11-13), unchanged. See auto-reply-ipc.cjs for the controller.
const crypto = require("node:crypto");
const { readContacts } = require("../../rpa/active_touch/state_machine.cjs");
const { identityKey } = require("../../rpa/active_touch/touch_task_state.cjs");
const { RATE_WINDOW_MS, GLOBAL_RATE_LIMIT, SYSTEM_IDS, SYSTEM_NAMES } = require("./auto-reply-constants.cjs");
const { normalizeText } = require("./auto-reply-text.cjs");

function isSystemContact(contact) {
  const identifiers = [contact?.wechatId, contact?.wxid, contact?.id]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const name = normalizeText(contact?.name);
  return !identifiers.length
    || identifiers.some((id) => SYSTEM_IDS.has(id) || id.endsWith("@chatroom") || id.startsWith("gh_"))
    || SYSTEM_NAMES.has(name)
    || /群聊$/u.test(name);
}

function compactConversationAlias(value) {
  return normalizeText(value).normalize("NFKC").replace(/\s+/gu, "");
}

function contactConversationAliases(contact, { includeOpaqueWechatId = false } = {}) {
  const aliases = [contact?.name, contact?.remark, contact?.nickname]
    .map((value) => normalizeText(value).normalize("NFKC"))
    .filter(Boolean);
  const wechatId = normalizeText(contact?.wechatId).normalize("NFKC");
  // A rendered chat title can occasionally equal a human-readable WeChat ID,
  // but opaque ASCII identifiers (especially wxid_*) must never be fed to OCR
  // as plausible titles.
  if (wechatId && (includeOpaqueWechatId || !/^(?:wxid_|gh_)/iu.test(wechatId)
    && !/@(?:chatroom)?$/iu.test(wechatId) && !/^[a-z][a-z0-9_.-]*$/iu.test(wechatId))) aliases.push(wechatId);
  return [...new Set(aliases)];
}

function contactAliasIndex(contacts, options = {}) {
  const ownership = new Map();
  for (const contact of contacts) {
    for (const alias of contactConversationAliases(contact, options)) {
      const key = compactConversationAlias(alias);
      if (!key) continue;
      const entry = ownership.get(key) || { alias, contacts: [] };
      if (!entry.contacts.includes(contact)) entry.contacts.push(contact);
      ownership.set(key, entry);
    }
  }
  return ownership;
}

function autoReplyConversationAliases(contacts) {
  return [...contactAliasIndex(contacts).values()]
    .filter((entry) => entry.contacts.length === 1)
    .map((entry) => entry.alias);
}

function eligibleContacts(activeTouchDir) {
  const contacts = readContacts(activeTouchDir)
    .filter((contact) => contact.wechatAccountId && !isSystemContact(contact));
  const allowedContacts = new Set([...contactAliasIndex(contacts).values()]
    .filter((entry) => entry.contacts.length === 1)
    .map((entry) => entry.contacts[0]));
  return contacts.filter((contact) => allowedContacts.has(contact));
}

function testContactLabel(contact) {
  return normalizeText(contact?.remark)
    || normalizeText(contact?.nickname)
    || normalizeText(contact?.name)
    || "已同步联系人";
}

function testContactUniverse(activeTouchDir) {
  // Disabled contacts still participate in the global alias index. Otherwise a
  // selected contact could be promoted to a falsely unique name after its
  // colliding record is disabled in the contact table.
  return readContacts(activeTouchDir)
    .filter((contact) => !isSystemContact(contact));
}

function testContactIdCounts(contacts) {
  const counts = new Map();
  for (const contact of contacts) {
    const id = normalizeText(contact?.id);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function uniqueAliasesForTestContact(contact, aliasIndex) {
  return [...aliasIndex.values()]
    .filter((entry) => entry.contacts.length === 1 && entry.contacts[0] === contact)
    .map((entry) => entry.alias)
    .filter(Boolean);
}

function testContactScopeLabel(contact, aliases) {
  const contactLabel = testContactLabel(contact);
  const uniqueAlias = aliases[0] || contactLabel;
  return contactLabel === uniqueAlias ? contactLabel : `${contactLabel}（会话：${uniqueAlias}）`;
}

function testContactScopeOptions(activeTouchDir) {
  const contactUniverse = testContactUniverse(activeTouchDir);
  const aliasIndex = contactAliasIndex(contactUniverse);
  const contactIdCounts = testContactIdCounts(contactUniverse);
  return contactUniverse.reduce((options, contact) => {
    const id = normalizeText(contact?.id);
    if (!id || contactIdCounts.get(id) !== 1 || !normalizeText(contact?.wechatAccountId) || contact.allowed === false) return options;
    const aliases = uniqueAliasesForTestContact(contact, aliasIndex);
    if (!aliases.length) return options;
    options.push({ id, label: testContactScopeLabel(contact, aliases) });
    return options;
  }, []);
}

function resolveTestContactScope(activeTouchDir, contactId) {
  const selectedContactId = normalizeText(contactId);
  if (!selectedContactId) {
    return { ok: false, code: "test_contact_required", error: "请先选择一位已同步联系人" };
  }
  const contactUniverse = testContactUniverse(activeTouchDir);
  const matchingContacts = contactUniverse.filter((contact) => normalizeText(contact?.id) === selectedContactId);
  if (matchingContacts.length !== 1) {
    return { ok: false, code: "test_contact_id_ambiguous", error: "所选测试联系人身份不唯一，请重新同步后选择" };
  }
  const selected = matchingContacts[0];
  if (!normalizeText(selected?.wechatAccountId) || selected.allowed === false) {
    return { ok: false, code: "test_contact_invalid", error: "所选测试联系人已失效，请重新同步后选择" };
  }
  const aliases = uniqueAliasesForTestContact(selected, contactAliasIndex(contactUniverse));
  if (!aliases.length) {
    return { ok: false, code: "test_contact_alias_ambiguous", error: "所选测试联系人没有可唯一识别的会话名称" };
  }
  const binding = crypto.createHash("sha256")
    .update(JSON.stringify({
      id: selected.id,
      account: normalizeText(selected.wechatAccountId),
      wxid: normalizeText(selected.wxid),
      wechatId: normalizeText(selected.wechatId),
      name: normalizeText(selected.name),
      remark: normalizeText(selected.remark),
      nickname: normalizeText(selected.nickname),
      aliases: [...aliases].sort()
    }))
    .digest("hex");
  return {
    ok: true,
    scope: {
      binding,
      contact: selected,
      contactId: selected.id,
      contactLabel: testContactScopeLabel(selected, aliases),
      aliases,
      aliasKeys: new Set(aliases.map((alias) => compactConversationAlias(alias)).filter(Boolean))
    }
  };
}

function normalizedContext(candidate) {
  if (!Array.isArray(candidate?.context)) return [];
  const context = candidate.context
    .slice(-12)
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "",
      content: normalizeText(item?.content),
      key: normalizeText(item?.key)
    }))
    .filter((item) => item.role && item.content);
  const latest = context.at(-1);
  if (!latest || latest.role !== "user" || latest.content !== normalizeText(candidate.message)) return [];
  return context;
}

function fingerprintFor(contact, candidate) {
  const runtimeId = normalizeText(candidate?.runtimeId);
  const incoming = normalizeText(candidate?.message);
  if (!runtimeId || !incoming) return "";
  return crypto.createHash("sha256")
    .update(JSON.stringify([
      contact.wechatAccountId || "unknown",
      contact.id,
      runtimeId,
      incoming
    ]))
    .digest("hex");
}

function contactForAutoReplyConversation(contacts, candidate) {
  const conversation = normalizeText(candidate?.conversation || candidate?.currentConversation);
  if (!conversation) return null;
  const entry = contactAliasIndex(contacts, { includeOpaqueWechatId: true }).get(compactConversationAlias(conversation));
  if (entry?.contacts?.length === 1) return entry.contacts[0];
  if (candidate?.messageDriven !== true) return null;
  const accountIds = [...new Set((Array.isArray(contacts) ? contacts : [])
    .map((contact) => normalizeText(contact?.wechatAccountId))
    .filter(Boolean))];
  if (accountIds.length !== 1) return null;
  const visualIdentity = JSON.stringify([accountIds[0], compactConversationAlias(conversation)]);
  const identity = crypto.createHash("sha256").update(visualIdentity).digest("hex").slice(0, 24);
  return {
    id: `visual-inbound-${identity}`,
    wechatAccountId: accountIds[0],
    name: "",
    remark: "",
    nickname: "",
    wechatId: ""
  };
}

function incomingEvidenceFor(candidate) {
  const runtimeId = normalizeText(candidate?.runtimeId);
  const visualEvidenceRuntimeId = normalizeText(candidate?.visualEvidenceRuntimeId);
  const messageSignature = normalizeText(candidate?.messageSignature).toLowerCase();
  const incoming = normalizeText(candidate?.message);
  const isVisual = normalizeText(candidate?.visualMode) === "visual_render_v1"
    || /^visual:v[12]:[a-f0-9]{64}$/u.test(runtimeId)
    || /^visual:v1:[a-f0-9]{64}$/u.test(visualEvidenceRuntimeId);
  let identity = "";
  if (isVisual) {
    // visual:v1 is a semantic OCR signature (role + text), so a customer may
    // legitimately produce it again in a later turn. Only the v2 occurrence
    // token contains the driver's durable turn boundary and may deduplicate a
    // send outcome across polls or restarts.
    if (/^visual:v2:[a-f0-9]{64}$/u.test(runtimeId)) identity = runtimeId;
  } else if (runtimeId && incoming) {
    const latestContextKey = Array.isArray(candidate?.context) ? normalizeText(candidate.context.at(-1)?.key) : "";
    identity = JSON.stringify([runtimeId, latestContextKey || runtimeId, incoming]);
  }
  return {
    id: identity ? crypto.createHash("sha256").update(`${isVisual ? "visual" : "uia"}\n${identity}`).digest("hex") : "",
    kind: isVisual ? "visual" : "uia",
    runtimeId,
    visualEvidenceRuntimeId,
    messageSignature
  };
}

function isTerminalProcessed(entry) {
  return Boolean(entry) && !["generating", "ready_to_send", "retryable"].includes(normalizeText(entry.status));
}

function retryPolls(attempts) {
  return Math.min(2 ** Math.max(0, Math.min(Number(attempts) - 1, 6)), 60);
}

// Kept as a diagnostic calculation for existing logs and self-checks. It no
// longer blocks or pauses the live listener.
function exceedsRateLimit(events, nowMs = Date.now()) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    const at = new Date(event?.at || 0).getTime();
    return Number.isFinite(at) && at <= nowMs && nowMs - at < RATE_WINDOW_MS;
  }).length >= GLOBAL_RATE_LIMIT;
}

function buildHandoffMessage({ conversation, reason, latest, at = new Date() }) {
  return [
    "【需人工跟进】",
    `客户：${normalizeText(conversation) || "未知客户"}`,
    `原因：${normalizeText(reason) || "需要人工确认"}`,
    `最新需求：${normalizeText(latest) || "未识别"}`,
    `时间：${at.toLocaleString("zh-CN", { hour12: false })}`,
    "请人工跟进"
  ].join("\n");
}

function resolveWorkflowContactScope(activeTouchDir, recipients) {
  const universe = testContactUniverse(activeTouchDir);
  const aliasIndex = contactAliasIndex(universe);
  const idCounts = testContactIdCounts(universe);
  const byId = new Map(universe.map((contact) => [normalizeText(contact?.id), contact]));
  const uniqueByContact = new Map();
  for (const entry of aliasIndex.values()) {
    if (entry.contacts.length !== 1 || !entry.alias) continue;
    const contact = entry.contacts[0];
    if (!uniqueByContact.has(contact)) uniqueByContact.set(contact, []);
    uniqueByContact.get(contact).push(entry.alias);
  }
  const contacts = [];
  const aliases = [];
  const excluded = [];
  const aliasContacts = new Map();
  const ids = new Set();
  for (const frozen of recipients) {
    const id = normalizeText(frozen?.id);
    const contact = byId.get(id);
    if (!id || ids.has(id) || idCounts.get(id) !== 1 || !contact
      || contact.allowed === false || contact.disabled === true || contact.active === false
      || !normalizeText(contact.wechatAccountId) || identityKey(contact) !== identityKey(frozen)) {
      excluded.push({ id, code: "workflow_recipient_changed" });
      continue;
    }
    ids.add(id);
    const uniqueAliases = uniqueByContact.get(contact) || [];
    if (!uniqueAliases.length) {
      excluded.push({ id, code: "workflow_recipient_ambiguous" });
      continue;
    }
    contacts.push(contact);
    for (const alias of uniqueAliases) {
      aliases.push(alias);
      aliasContacts.set(compactConversationAlias(alias), contact);
    }
  }
  const excludedReasons = Object.fromEntries([...new Set(excluded.map((item) => item.code))]
    .map((code) => [code, excluded.filter((item) => item.code === code).length]));
  if (!contacts.length) return { ok: false, code: "workflow_recipients_none_eligible", error: "接待名单中没有可安全自动回复的联系人，请核对名单后重新启动", contacts, aliases, excluded, excludedReasons };
  const accounts = new Set(contacts.map((contact) => normalizeText(contact.wechatAccountId)));
  if (accounts.size !== 1) return { ok: false, code: "workflow_account_changed", error: "接待名单不属于同一微信账号", contacts, aliases, excluded, excludedReasons };
  return {
    ok: true,
    strict: true,
    excluded,
    excludedReasons,
    scopeBinding: crypto.createHash("sha256").update(JSON.stringify(contacts.map(identityKey).sort())).digest("hex"),
    contacts,
    aliases,
    driverOptions: { exactConversationMatch: true, passiveScan: true },
    resolveContact: (candidate) => {
      // An anonymous red-dot identity cannot authorize a scoped workflow reply.
      if (candidate?.messageDriven === true) return null;
      const conversation = normalizeText(candidate?.conversation || candidate?.currentConversation);
      const evidence = compactConversationAlias(candidate?.conversationEvidence);
      if (normalizeText(candidate?.visualMode) === "visual_render_v1"
        && (!evidence || evidence !== compactConversationAlias(conversation))) return null;
      return aliasContacts.get(compactConversationAlias(conversation)) || null;
    }
  };
}

function handoffReasonLabel(reasonCode) {
  return {
    explicit_human_request: "客户明确要求人工",
    transaction_commitment: "需要处理下单、合同或履约",
    after_sales_action: "需要处理退款、投诉或售后执行"
  }[reasonCode] || "需要人工跟进";
}

function handoffMetadata({ contactId, context, conversation, at }) {
  const key = crypto.createHash("sha256")
    .update(`${contactId}\n${context.map((item) => `${item.role}:${item.key || item.content}`).join("\n")}`)
    .digest("hex");
  return { key, contact_id: contactId, conversation, at: at.toISOString() };
}

module.exports = {
  isSystemContact,
  compactConversationAlias,
  contactConversationAliases,
  contactAliasIndex,
  autoReplyConversationAliases,
  eligibleContacts,
  testContactLabel,
  testContactUniverse,
  testContactIdCounts,
  uniqueAliasesForTestContact,
  testContactScopeLabel,
  testContactScopeOptions,
  resolveTestContactScope,
  normalizedContext,
  fingerprintFor,
  contactForAutoReplyConversation,
  incomingEvidenceFor,
  isTerminalProcessed,
  retryPolls,
  exceedsRateLimit,
  buildHandoffMessage,
  resolveWorkflowContactScope,
  handoffReasonLabel,
  handoffMetadata
};
