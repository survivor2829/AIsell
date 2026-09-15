const assert = require("node:assert/strict");
const { unclassifiedAddedReasons } = require("./wechat-failure-policy-review.cjs");

assert.deepEqual(unclassifiedAddedReasons('+ return { blocked_reason: "outcome_unknown" };'), []);
assert.deepEqual(unclassifiedAddedReasons('+ return { reasonCode: "brand_new_unclassified_reason" };'), ["brand_new_unclassified_reason"]);
assert.deepEqual(unclassifiedAddedReasons('+ Write-XiaoxiFailure "rule-r001" "another_new_reason"'), ["another_new_reason"]);
console.log("WeChat failure policy review gate self-check passed");
