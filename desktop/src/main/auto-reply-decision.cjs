const ACTION_REASON_CODES = Object.freeze({
  answer: Object.freeze(["business_knowledge", "general_guidance", "company_fact_unavailable"]),
  clarify: Object.freeze(["missing_detail"]),
  handoff: Object.freeze(["explicit_human_request", "transaction_commitment", "after_sales_action"]),
  silent: Object.freeze(["no_reply_needed"])
});

const AUTO_REPLY_ACTIONS = new Set(Object.keys(ACTION_REASON_CODES));
const AUTO_REPLY_REASON_CODES = new Set(Object.values(ACTION_REASON_CODES).flat());

function isAutoReplyActionReason(action, reasonCode) {
  return ACTION_REASON_CODES[action]?.includes(reasonCode) === true;
}

module.exports = {
  AUTO_REPLY_ACTIONS,
  AUTO_REPLY_REASON_CODES,
  isAutoReplyActionReason
};
