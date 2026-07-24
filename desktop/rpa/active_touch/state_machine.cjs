const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("../../src/main/atomic-file.cjs");
const { readWindowTitles } = require("./window_title_reader.cjs");
const {
  focusWechatWindow,
  inputWechatMessageDraft,
  inputWechatSearchQuery,
  openWechatSearchResult,
  verifyWechatCurrentConversation
} = require("./wechat_window_driver.cjs");

const DEFAULT_STATE = {
  version: 1,
  calibrated: false,
  target_selected: false,
  conversation_located: false,
  conversation_verified: false,
  dry_run: true,
  selected_customer: null,
  task_context: null,
  conversation_title: "",
  conversation_verification_mode: "",
  conversation_token: "",
  conversation_title_mode: "",
  located_window_title: "",
  search_input_done: false,
  search_result_clicked: false,
  search_query: "",
  message_input_done: false,
  message_draft: "",
  send_gate_status: "blocked",
  send_gate_reason: "",
  real_send_armed: false,
  real_send_enabled: false,
  real_send_clicked: false,
  real_send_status: "not_sent",
  real_send_reason: "",
  post_send_verified: false,
  post_send_status: "not_checked",
  post_send_reason: "",
  message_bubble_verified: false,
  message_bubble_status: "not_checked",
  message_bubble_reason: "",
  wechat_account_id: "",
  window_pid: 0,
  window_handle: "",
  window_process_name: "",
  real_send_attempts: {},
  queue_dry_run_count: 0,
  queue_dry_run_passed: false,
  queue_dry_run_results: [],
  last_result: "idle",
  blocked_reason: ""
};

function statePath(baseDir) {
  return path.join(baseDir, "state.json");
}

function logPath(baseDir) {
  return path.join(baseDir, "run_logs.jsonl");
}

function contactsPath(baseDir) {
  return path.join(baseDir, "contacts.json");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function loadState(baseDir = __dirname) {
  const filePath = statePath(baseDir);
  if (!fs.existsSync(filePath)) return { ...DEFAULT_STATE };
  return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) };
}

function saveState(baseDir, state) {
  fs.mkdirSync(baseDir, { recursive: true });
  writeJsonAtomic(statePath(baseDir), state, { trailingNewline: false });
}

function readLogs(baseDir = __dirname, limit = 50) {
  try {
    return fs
      .readFileSync(logPath(baseDir), "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

function readContacts(baseDir = __dirname) {
  const raw = readJson(contactsPath(baseDir));
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw.contacts) ? raw.contacts : [];

  return rows
    .map((row, index) => {
      const remark = String(row.remark ?? "").trim();
      const nickname = String(row.nickname ?? row.nick_name ?? "").trim();
      const wxid = String(row.wxid ?? row.username ?? row.user_name ?? "").trim();
      const wechatId = String(row.wechatId ?? row.wechat_id ?? row.alias ?? "").trim();
      const name = String(row.name || remark || nickname || wechatId).trim();
      if (!name) return null;
      return {
        id: String(row.id || wxid || wechatId || name),
        name,
        remark,
        nickname,
        wxid,
        wechatId,
        wechatAccountId: String(row.wechatAccountId ?? row.wechat_account_id ?? "").trim(),
        tag: String(row.tag ?? row.label ?? ""),
        lastTouch: String(row.lastTouch ?? row.last_touch ?? ""),
        allowed: row.allowed !== false,
        source: String(row.source ?? ""),
        syncedAt: String(row.syncedAt ?? row.synced_at ?? "")
      };
    })
    .filter(Boolean)
    .map((row, index) => ({ ...row, id: row.id || String(index + 1) }));
}

function customerSearchQuery(customer) {
  return String(customer?.wechatId || customer?.remark || customer?.nickname || customer?.name || "").trim();
}

function appendLog(baseDir, action, result) {
  const entry = {
    id: Date.now(),
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    action,
    result
  };
  fs.mkdirSync(baseDir, { recursive: true });
  fs.appendFileSync(logPath(baseDir), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

function output(ok, action, state, extra = {}) {
  return {
    ok,
    action,
    state,
    contacts: readContacts(extra.baseDir),
    logs: readLogs(extra.baseDir),
    ...extra
  };
}

function status(baseDir = __dirname) {
  const state = loadState(baseDir);
  return output(true, "status", state, { baseDir });
}

function calibrate(baseDir = __dirname) {
  const state = {
    ...loadState(baseDir),
    calibrated: true,
    dry_run: true,
    last_result: "calibrated",
    blocked_reason: ""
  };
  saveState(baseDir, state);
  appendLog(baseDir, "窗口校准", "dry-run 校准完成，未操作微信窗口");
  return output(true, "calibrate", state, { baseDir });
}

function focusWechatWindowDryRun(baseDir = __dirname, driver = focusWechatWindow) {
  const state = loadState(baseDir);
  const result = driver();
  if (!result.ok) {
    const reason = wechatWindowReason(result);
    return block(baseDir, "窗口拉起", state, reason, wechatWindowBlockText(reason));
  }

  const nextState = {
    ...state,
    located_window_title: result.title ?? state.located_window_title,
    last_result: "wechat_window_focused",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "窗口拉起", `已拉起窗口：${result.processName || "微信"}`);
  return output(true, "focus-wechat-window", nextState, { baseDir });
}

function block(baseDir, action, state, reason, result, extra = {}) {
  const nextState = {
    ...state,
    last_result: "blocked",
    blocked_reason: reason
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, action, result);
  return output(false, action, nextState, { baseDir, blocked_reason: reason, ...extra });
}

function blockSendGate(baseDir, state, reason, result) {
  return block(
    baseDir,
    "发前安全检查 dry-run",
    {
      ...state,
      send_gate_status: "blocked",
      send_gate_reason: reason,
      real_send_armed: false,
      real_send_enabled: false,
      real_send_clicked: false,
      real_send_status: "blocked",
      real_send_reason: reason,
      message_bubble_verified: false,
      message_bubble_status: "not_checked",
      message_bubble_reason: ""
    },
    reason,
    result
  );
}

function blockPostSend(baseDir, state, reason, result) {
  return block(
    baseDir,
    "发送后验证 dry-run",
    { ...state, post_send_verified: false, post_send_status: "blocked", post_send_reason: reason },
    reason,
    result
  );
}

function blockMessageBubble(baseDir, state, reason, result) {
  return block(
    baseDir,
    "消息气泡验证",
    { ...state, message_bubble_verified: false, message_bubble_status: "blocked", message_bubble_reason: reason },
    reason,
    result
  );
}

function clearConversationState(state, reason, extra = {}) {
  return {
    ...state,
    conversation_located: false,
    conversation_verified: false,
    conversation_title: "",
    conversation_verification_mode: "",
    conversation_token: "",
    conversation_title_mode: "",
    located_window_title: "",
    message_input_done: false,
    message_draft: "",
    send_gate_status: "blocked",
    send_gate_reason: reason,
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "blocked",
    real_send_reason: reason,
    post_send_verified: false,
    post_send_status: "blocked",
    post_send_reason: reason,
    message_bubble_verified: false,
    message_bubble_status: "blocked",
    message_bubble_reason: reason,
    ...extra
  };
}

function wechatWindowReason(result) {
  const reason = String(result?.reason || "");
  if ([
    "wechat_login_required",
    "wechat_focus_failed",
    "wechat_window_not_ready",
    "wechat_window_ambiguous",
    "wechat_window_identity_mismatch",
    "personal_wechat_main_window_not_found",
    "powershell_timeout",
    "powershell_failed"
  ].includes(reason)) return reason;
  return "wechat_window_not_found";
}

function wechatWindowBlockText(reason) {
  if (reason === "wechat_login_required") return "已阻断：微信需要完成登录确认";
  if (reason === "wechat_focus_failed") return "已阻断：微信窗口未获得前台焦点";
  if (reason === "wechat_window_not_ready") return "已阻断：已找到微信窗口，但当前窗口尺寸不可操作";
  if (reason === "wechat_window_ambiguous") return "已阻断：检测到多个个人微信主窗口";
  if (reason === "wechat_window_identity_mismatch") return "已阻断：微信窗口在操作过程中发生变化";
  if (reason === "personal_wechat_main_window_not_found") return "已阻断：未识别到个人微信主窗口";
  if (reason === "powershell_timeout") return "已阻断：微信窗口适配程序执行超时";
  if (reason === "powershell_failed") return "已阻断：微信窗口适配程序启动失败，请检查权限或安全软件";
  return "已阻断：未找到微信窗口";
}

function send(baseDir = __dirname, options = {}) {
  const state = loadState(baseDir);
  const dryRun = options.dryRun !== false;
  const message = String(options.message ?? state.message_draft ?? "").trim();

  if (!state.calibrated) {
    return blockSendGate(baseDir, state, "not_calibrated", "已阻断：窗口未校准");
  }

  if (!state.target_selected && !options.target) {
    return blockSendGate(baseDir, state, "no_whitelist_customer", "已阻断：暂无白名单客户");
  }

  if (!state.conversation_verified) {
    return blockSendGate(baseDir, state, "conversation_not_verified", "已阻断：会话未验证");
  }

  if (!message) {
    return blockSendGate(baseDir, state, "empty_message", "已阻断：触达内容为空");
  }

  if (!state.message_input_done) {
    return blockSendGate(baseDir, state, "message_not_input", "已阻断：消息尚未输入到会话草稿");
  }

  if (String(state.message_draft ?? "").trim() !== message) {
    return blockSendGate(baseDir, state, "message_draft_changed", "已阻断：输入框内容与已校验草稿不一致");
  }

  if (!dryRun) return blockSendGate(baseDir, state, "real_send_unavailable", "已阻断：客户版不包含真实发送实验模块");

  const nextState = {
    ...state,
    dry_run: true,
    send_gate_status: "dry_run_passed",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "pending",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    last_result: "send_gate_dry_run_passed",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "发前安全检查 dry-run", "dry-run 通过，未发送真实消息");
  return output(true, "send", nextState, { baseDir });
}

function selectCustomer(baseDir = __dirname, customerId = "", contactsDir = baseDir) {
  const contacts = readContacts(contactsDir);
  const customer = contacts.find((row) => row.id === customerId);
  const state = loadState(baseDir);

  if (!customer) {
    return block(baseDir, "白名单选择", state, "customer_not_found", "已阻断：未找到联系人");
  }

  if (!customer.allowed) {
    return block(baseDir, "白名单选择", state, "customer_not_allowed", "已阻断：该客户不允许触达");
  }

  const nextState = {
    ...state,
    target_selected: true,
    conversation_located: false,
    conversation_verified: false,
    selected_customer: customer,
    conversation_title: "",
    conversation_verification_mode: "",
    conversation_token: "",
    conversation_title_mode: "",
    located_window_title: "",
    search_input_done: false,
    search_result_clicked: false,
    search_query: "",
    message_input_done: false,
    message_draft: "",
    send_gate_status: "blocked",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "not_checked",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    wechat_account_id: customer.wechatAccountId,
    window_pid: 0,
    window_handle: "",
    window_process_name: "",
    last_result: "customer_selected",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "白名单选择", `已选择：${customer.name}`);
  return output(true, "select-customer", nextState, { baseDir });
}

function clearCustomer(baseDir = __dirname) {
  const state = loadState(baseDir);
  const nextState = {
    ...DEFAULT_STATE,
    calibrated: state.calibrated,
    real_send_attempts: state.real_send_attempts ?? {},
    dry_run: true,
    last_result: "customer_cleared",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "白名单清空", "已清空当前客户和测试状态");
  return output(true, "clear-customer", nextState, { baseDir });
}

function verifyConversation(baseDir = __dirname, title = "") {
  const state = loadState(baseDir);
  const customerName = String(state.selected_customer?.name ?? "").trim();
  const conversationTitle = String(title).trim();

  if (!state.target_selected || !customerName) {
    return block(baseDir, "会话校验", state, "no_whitelist_customer", "已阻断：未选择白名单客户");
  }

  if (!conversationTitle) {
    return block(baseDir, "会话校验", state, "empty_conversation_title", "已阻断：会话标题为空");
  }

  if (!conversationTitle.includes(customerName)) {
    const nextState = clearConversationState(state, "conversation_mismatch", {
      conversation_title: conversationTitle,
      located_window_title: conversationTitle
    });
    return block(baseDir, "会话校验", nextState, "conversation_mismatch", "已阻断：会话标题不匹配");
  }

  const nextState = {
    ...state,
    conversation_located: true,
    conversation_verified: true,
    conversation_title: conversationTitle,
    located_window_title: conversationTitle,
    send_gate_status: "pending",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "not_checked",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    last_result: "conversation_verified",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "会话校验", `已验证：${conversationTitle}`);
  return output(true, "verify-conversation", nextState, { baseDir });
}

function locateConversation(baseDir = __dirname, titleReader = readWindowTitles) {
  const state = loadState(baseDir);
  const customerName = String(state.selected_customer?.name ?? "").trim();

  if (!state.target_selected || !customerName) {
    return block(baseDir, "会话定位", state, "no_whitelist_customer", "已阻断：未选择白名单客户");
  }

  const title = titleReader().find((item) => item.includes(customerName));
  if (!title) {
    return block(baseDir, "会话定位", clearConversationState(state, "conversation_window_not_found"), "conversation_window_not_found", "已阻断：未找到匹配会话窗口");
  }

  const nextState = {
    ...state,
    conversation_located: true,
    conversation_verified: true,
    conversation_title: title,
    located_window_title: title,
    send_gate_status: "pending",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "not_checked",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    last_result: "conversation_located",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "会话定位", `已定位：${title}`);
  return output(true, "locate-conversation", nextState, { baseDir });
}

function verifyWindowTitle(baseDir = __dirname, titleReader = readWindowTitles) {
  return locateConversation(baseDir, titleReader);
}

function openConversationDryRun(baseDir = __dirname, driver = focusWechatWindow, titleReader = readWindowTitles) {
  const state = loadState(baseDir);
  const customerName = String(state.selected_customer?.name ?? "").trim();

  if (!state.target_selected || !customerName) {
    return block(baseDir, "打开会话 dry-run", state, "no_whitelist_customer", "已阻断：未选择白名单客户");
  }

  const wechatWindow = driver();
  if (!wechatWindow.ok) {
    const reason = wechatWindowReason(wechatWindow);
    return block(baseDir, "打开会话 dry-run", clearConversationState(state, reason), reason, wechatWindowBlockText(reason));
  }

  const titles = [wechatWindow.title, ...titleReader()].filter(Boolean);
  const title = titles.find((item) => item.includes(customerName));
  if (!title) {
    const nextState = clearConversationState(state, "customer_conversation_not_found", { located_window_title: wechatWindow.title ?? "" });
    return block(baseDir, "打开会话 dry-run", nextState, "customer_conversation_not_found", "已阻断：未定位到客户会话");
  }

  const nextState = {
    ...state,
    conversation_located: true,
    conversation_verified: true,
    conversation_title: title,
    located_window_title: title,
    send_gate_status: "pending",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "not_checked",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    last_result: "conversation_opened_dry_run",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "打开会话 dry-run", `已定位：${title}`);
  return output(true, "open-conversation-dry-run", nextState, { baseDir });
}

function searchConversationDryRun(baseDir = __dirname, searchDriver = inputWechatSearchQuery, titleReader = readWindowTitles) {
  const state = loadState(baseDir);
  const customerName = String(state.selected_customer?.name ?? "").trim();
  const searchQuery = customerSearchQuery(state.selected_customer);

  if (!state.target_selected || !customerName || !searchQuery) {
    return block(baseDir, "搜索框输入 dry-run", state, "no_whitelist_customer", "已阻断：未选择白名单客户");
  }

  const inputResult = searchDriver(searchQuery);
  if (!inputResult.ok) {
    const reason = wechatWindowReason(inputResult);
    return block(baseDir, "搜索框输入 dry-run", clearConversationState(state, reason), reason, wechatWindowBlockText(reason));
  }

  const titles = [inputResult.title, ...titleReader()].filter(Boolean);
  const title = titles.find((item) => item.includes(customerName));
  const nextState = title ? {
    ...state,
    search_input_done: true,
    search_result_clicked: false,
    search_query: searchQuery,
    conversation_located: true,
    conversation_verified: true,
    conversation_title: title,
    located_window_title: title,
    send_gate_status: "pending",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "not_checked",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    last_result: title ? "search_conversation_located" : "search_input_done",
    blocked_reason: ""
  } : clearConversationState(state, "search_conversation_not_found", {
    search_input_done: true,
    search_result_clicked: false,
    search_query: searchQuery,
    located_window_title: inputResult.title ?? "",
    last_result: "search_input_done",
    blocked_reason: ""
  });
  saveState(baseDir, nextState);
  appendLog(baseDir, "搜索框输入 dry-run", title ? `已输入并定位：${title}` : `已输入搜索关键词：${searchQuery}，未点击结果`);
  return output(true, "search-conversation-dry-run", nextState, { baseDir });
}

function clickSearchResultDryRun(
  baseDir = __dirname,
  openResultDriver = openWechatSearchResult,
  titleReader = readWindowTitles,
  conversationVerifier = verifyWechatCurrentConversation
) {
  const operationStartedAt = Date.now();
  const state = loadState(baseDir);
  const customerName = String(state.selected_customer?.name ?? "").trim();
  const searchQuery = customerSearchQuery(state.selected_customer);

  if (!state.target_selected || !customerName || !searchQuery) {
    return block(baseDir, "点击搜索结果 dry-run", state, "no_whitelist_customer", "已阻断：未选择白名单客户");
  }

  const openStartedAt = Date.now();
  const inputResult = openResultDriver(searchQuery);
  const openResultMs = Date.now() - openStartedAt;
  if (!inputResult.ok) {
    const reason = wechatWindowReason(inputResult);
    return block(baseDir, "点击搜索结果 dry-run", clearConversationState(state, reason), reason, wechatWindowBlockText(reason));
  }

  const wechatId = String(state.selected_customer?.wechatId ?? "").trim();
  const exactWechatIdSearch = Boolean(wechatId)
    && searchQuery === wechatId
    && inputResult.exactSearchOpened === true
    && inputResult.searchQuery === searchQuery
    && ["Weixin", "WeChat"].includes(inputResult.processName)
    && Boolean(inputResult.pid)
    && Boolean(inputResult.hWnd);
  let titleReadMs = 0;
  let conversationVerifyMs = 0;
  let matchedTitle = "";
  let verifiedConversation;
  if (exactWechatIdSearch) {
    verifiedConversation = {
      ok: true,
      title: customerName,
      processName: inputResult.processName,
      pid: inputResult.pid,
      hWnd: inputResult.hWnd,
      verificationMode: "exact_wechat_id_search"
    };
  } else {
    const titleReadStartedAt = Date.now();
    const titles = [inputResult.title, ...titleReader()].filter(Boolean);
    titleReadMs = Date.now() - titleReadStartedAt;
    matchedTitle = titles.find((item) => item.includes(customerName)) || "";
    const verifyStartedAt = Date.now();
    verifiedConversation = matchedTitle ? { ok: true, title: matchedTitle } : conversationVerifier(customerName);
    conversationVerifyMs = Date.now() - verifyStartedAt;
  }
  const timings = {
    open_result_ms: openResultMs,
    title_read_ms: titleReadMs,
    conversation_verify_ms: conversationVerifyMs,
    total_ms: Date.now() - operationStartedAt
  };
  if (!verifiedConversation.ok) {
    const reason = verifiedConversation.reason === "contact_unavailable" ? "contact_unavailable" : "search_result_not_opened";
    const nextState = clearConversationState(state, reason, {
      search_input_done: true,
      search_result_clicked: true,
      search_query: searchQuery,
      located_window_title: verifiedConversation.title ?? inputResult.title ?? ""
    });
    return block(
      baseDir,
      "点击搜索结果 dry-run",
      nextState,
      reason,
      reason === "contact_unavailable" ? "联系人已停用，自动跳过" : "已阻断：未打开匹配客户会话"
    );
  }
  const title = matchedTitle ?? verifiedConversation.title ?? customerName;

  const nextState = {
    ...state,
    search_input_done: true,
    search_result_clicked: true,
    search_query: searchQuery,
    conversation_located: true,
    conversation_verified: true,
    conversation_title: title,
    conversation_verification_mode: verifiedConversation.verificationMode || "conversation_title",
    conversation_token: "",
    conversation_title_mode: "",
    located_window_title: title,
    window_pid: Number(verifiedConversation.pid ?? inputResult.pid ?? 0),
    window_handle: String(verifiedConversation.hWnd ?? inputResult.hWnd ?? ""),
    window_process_name: String(verifiedConversation.processName ?? inputResult.processName ?? ""),
    send_gate_status: "pending",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "not_checked",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    last_result: "search_result_opened",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "点击搜索结果 dry-run", `已打开并验证：${title}`);
  timings.total_ms = Date.now() - operationStartedAt;
  return output(true, "click-search-result-dry-run", nextState, { baseDir, diagnostics: { timings } });
}

function inputMessageDryRun(baseDir = __dirname, message = "", inputDriver = inputWechatMessageDraft) {
  const operationStartedAt = Date.now();
  const state = loadState(baseDir);
  const draft = String(message ?? "").trim();

  if (!state.target_selected) {
    return block(baseDir, "消息输入 dry-run", state, "no_whitelist_customer", "已阻断：未选择白名单客户");
  }

  if (!state.conversation_verified) {
    return block(baseDir, "消息输入 dry-run", state, "conversation_not_verified", "已阻断：会话未验证");
  }

  if (!draft) {
    return block(baseDir, "消息输入 dry-run", state, "empty_message", "已阻断：触达内容为空");
  }

  const inputStartedAt = Date.now();
  const inputResult = inputDriver(draft, {
    pid: state.window_pid,
    hWnd: state.window_handle
  });
  const timings = {
    input_driver_ms: Date.now() - inputStartedAt,
    total_ms: Date.now() - operationStartedAt,
    draft_attempts: Math.max(0, Number(inputResult.draftAttempts || 0))
  };
  if (!inputResult.ok || inputResult.draftVerified !== true) {
    const diagnostic = String(inputResult.draftCheck || inputResult.reason || "").trim();
    const safeDiagnostic = /^[a-z0-9_]+$/.test(diagnostic) ? diagnostic : "";
    const attempts = Number(inputResult.draftAttempts);
    const reason = safeDiagnostic
      ? `message_input_failed_${safeDiagnostic}${Number.isInteger(attempts) && attempts > 0 ? `_attempts_${attempts}` : ""}`
      : "message_input_failed";
    return block(baseDir, "消息输入 dry-run", state, reason, "已阻断：未能定位微信输入框");
  }
  const pointX = Number(inputResult.draftPoint?.xRatio);
  const pointY = Number(inputResult.draftPoint?.yRatio);
  const messageInputPoint = Number.isFinite(pointX) && Number.isFinite(pointY) && pointX > 0 && pointX < 1 && pointY > 0 && pointY < 1
    ? { xRatio: pointX, yRatio: pointY }
    : null;

  const nextState = {
    ...state,
    message_input_done: true,
    message_draft: draft,
    message_input_point: messageInputPoint,
    located_window_title: inputResult.title ?? state.located_window_title,
    send_gate_status: "pending",
    send_gate_reason: "",
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: "",
    post_send_verified: false,
    post_send_status: "not_checked",
    post_send_reason: "",
    message_bubble_verified: false,
    message_bubble_status: "not_checked",
    message_bubble_reason: "",
    last_result: "message_input_dry_run",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "消息输入 dry-run", "已输入草稿，未发送");
  timings.total_ms = Date.now() - operationStartedAt;
  return output(true, "input-message-dry-run", nextState, { baseDir, diagnostics: { timings } });
}

function queueDryRun(
  baseDir = __dirname,
  customerIds = [],
  message = "",
  openResultDriver = openWechatSearchResult,
  inputDriver = inputWechatMessageDraft,
  titleReader = readWindowTitles,
  conversationVerifier = verifyWechatCurrentConversation
) {
  const state = loadState(baseDir);
  const ids = (Array.isArray(customerIds) ? customerIds : String(customerIds).split(","))
    .map((id) => String(id).trim())
    .filter(Boolean);
  const draft = String(message ?? "").trim();

  if (!state.calibrated) {
    return block(baseDir, "小批量 dry-run 队列", state, "not_calibrated", "已阻断：窗口未校准");
  }

  if (!ids.length) {
    return block(baseDir, "小批量 dry-run 队列", state, "queue_empty", "已阻断：未选择队列客户");
  }

  if (ids.length > 3) {
    return block(baseDir, "小批量 dry-run 队列", state, "queue_limit_exceeded", "已阻断：小批量 dry-run 最多 3 人");
  }

  if (!draft) {
    return block(baseDir, "小批量 dry-run 队列", state, "empty_message", "已阻断：触达内容为空");
  }

  const contacts = readContacts(baseDir);
  const customers = ids.map((id) => contacts.find((row) => row.id === id));
  if (customers.some((customer) => !customer)) {
    return block(baseDir, "小批量 dry-run 队列", state, "queue_customer_not_found", "已阻断：队列里有未找到的客户");
  }

  if (customers.some((customer) => customer.allowed === false)) {
    return block(baseDir, "小批量 dry-run 队列", state, "queue_customer_not_allowed", "已阻断：队列里有非白名单客户");
  }

  const results = [];
  let nextState = { ...state, queue_dry_run_passed: false, queue_dry_run_results: [] };

  for (const [index, customer] of customers.entries()) {
    const searchQuery = customerSearchQuery(customer);
    if (!searchQuery) {
      return block(baseDir, "小批量 dry-run 队列", state, "queue_customer_search_query_missing", "已阻断：队列里有客户缺少可搜索字段");
    }

    const openResult = openResultDriver(searchQuery);
    if (!openResult.ok) {
      const reason = wechatWindowReason(openResult);
      const blockedState = clearConversationState(nextState, reason, {
        selected_customer: customer,
        target_selected: true,
        queue_dry_run_count: ids.length,
        queue_dry_run_results: results
      });
      return block(baseDir, "小批量 dry-run 队列", blockedState, reason, reason === "wechat_login_required" ? `已阻断：第 ${index + 1} 位需要完成微信登录确认` : `已阻断：第 ${index + 1} 位未找到微信窗口`);
    }

    const titles = [openResult.title, ...titleReader()].filter(Boolean);
    const matchedTitle = titles.find((item) => item.includes(customer.name));
    const verifiedConversation = matchedTitle ? { ok: true, title: matchedTitle } : conversationVerifier(customer.name);
    if (!verifiedConversation.ok) {
      const blockedState = clearConversationState(nextState, "queue_conversation_not_verified", {
        selected_customer: customer,
        target_selected: true,
        search_input_done: true,
        search_result_clicked: true,
        search_query: searchQuery,
        located_window_title: openResult.title ?? "",
        queue_dry_run_count: ids.length,
        queue_dry_run_results: results
      });
      return block(baseDir, "小批量 dry-run 队列", blockedState, "queue_conversation_not_verified", `已阻断：第 ${index + 1} 位未打开匹配会话`);
    }

    const inputResult = inputDriver(draft);
    if (!inputResult.ok || inputResult.draftVerified !== true) {
      const blockedState = {
        ...nextState,
        selected_customer: customer,
        target_selected: true,
        conversation_located: true,
        conversation_verified: true,
        conversation_title: matchedTitle ?? verifiedConversation.title ?? customer.name,
        located_window_title: inputResult.title ?? matchedTitle ?? verifiedConversation.title ?? customer.name,
        queue_dry_run_count: ids.length,
        queue_dry_run_results: results
      };
      return block(baseDir, "小批量 dry-run 队列", blockedState, "queue_message_input_failed", `已阻断：第 ${index + 1} 位未能输入草稿`);
    }

    results.push({ id: customer.id, name: customer.name, ok: true, result: "dry_run_passed" });
    nextState = {
      ...nextState,
      dry_run: true,
      target_selected: true,
      selected_customer: customer,
      conversation_located: true,
      conversation_verified: true,
      conversation_title: matchedTitle ?? verifiedConversation.title ?? customer.name,
      located_window_title: inputResult.title ?? matchedTitle ?? verifiedConversation.title ?? customer.name,
      search_input_done: true,
      search_result_clicked: true,
      search_query: searchQuery,
      message_input_done: true,
      message_draft: draft,
      send_gate_status: "dry_run_passed",
      send_gate_reason: "",
      real_send_armed: false,
      real_send_enabled: false,
      real_send_clicked: false,
      real_send_status: "not_sent",
      real_send_reason: "",
      post_send_verified: false,
      post_send_status: "pending",
      post_send_reason: "",
      message_bubble_verified: false,
      message_bubble_status: "not_checked",
      message_bubble_reason: "",
      queue_dry_run_count: ids.length,
      queue_dry_run_passed: true,
      queue_dry_run_results: results,
      last_result: "queue_dry_run_item_passed",
      blocked_reason: ""
    };
    saveState(baseDir, nextState);
    appendLog(baseDir, "小批量 dry-run 队列", `第 ${index + 1}/${ids.length} 位通过：${customer.name}`);
  }

  const finalState = {
    ...nextState,
    last_result: "queue_dry_run_passed",
    blocked_reason: ""
  };
  saveState(baseDir, finalState);
  appendLog(baseDir, "小批量 dry-run 队列", `已完成 ${results.length}/${ids.length}，未真实发送`);
  return output(true, "queue-dry-run", finalState, { baseDir, queue_results: results });
}


function verifySendResultDryRun(baseDir = __dirname, titleReader = readWindowTitles) {
  const state = loadState(baseDir);
  const customerName = String(state.selected_customer?.name ?? "").trim();

  if (state.send_gate_status !== "dry_run_passed") {
    return blockPostSend(baseDir, state, "send_gate_not_passed", "已阻断：发送门禁 dry-run 未通过");
  }

  if (!customerName) {
    return blockPostSend(baseDir, state, "no_whitelist_customer", "已阻断：未选择白名单客户");
  }

  const visibleTitles = titleReader().filter(Boolean);
  const titles = visibleTitles.length ? visibleTitles : [state.conversation_title, state.located_window_title].filter(Boolean);
  if (!titles.some((item) => item.includes(customerName))) {
    return blockPostSend(baseDir, state, "post_send_conversation_mismatch", "已阻断：发送后会话不匹配");
  }

  const nextState = {
    ...state,
    post_send_verified: true,
    post_send_status: "dry_run_verified",
    post_send_reason: "",
    last_result: "post_send_verified_dry_run",
    blocked_reason: ""
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "发送后验证 dry-run", "dry-run 验证通过：仍在目标会话，未验证真实消息气泡");
  return output(true, "verify-send-result-dry-run", nextState, { baseDir });
}

module.exports = {
  calibrate,
  clickSearchResultDryRun,
  clearCustomer,
  focusWechatWindowDryRun,
  inputMessageDryRun,
  locateConversation,
  loadState,
  openConversationDryRun,
  queueDryRun,
  readContacts,
  readLogs,
  searchConversationDryRun,
  selectCustomer,
  send,
  saveState,
  status,
  verifyConversation,
  verifySendResultDryRun,
  verifyWindowTitle,
  appendLog,
  block,
  blockMessageBubble,
  blockSendGate,
  output
};
