const assert = require("node:assert/strict");
const { createAutoUpdate } = require("./update-auto.cjs");

(async () => {
  let clock = 0, idle = 0, busy = false, state = { stage: "ready", updateRequested: false }, requests = 0, cancels = 0, installs = 0, waiting = "";
  const auto = createAutoUpdate({
    controller: { status: () => state }, now: () => clock, idleSeconds: () => idle, busy: async () => busy,
    request: async () => { requests++; state = { ...state, updateRequested: true }; if (!waiting) { installs++; state = { stage: "waiting", updateRequested: true }; } return state; },
    cancel: async () => { cancels++; state = { stage: "ready", updateRequested: false }; return state; }
  });
  const reset = () => { state = { stage: "ready", updateRequested: false }; };

  // 刚打开软件：用户还在操作时不装，停手 20 秒就装。
  idle = 5; await auto.tick(); assert.equal(requests, 0, "用户正在操作时不自动更新");
  idle = 25; busy = true; await auto.tick(); assert.equal(requests, 0, "有任务在跑（含工作流开着）时不自动更新");
  busy = false; await auto.tick(); assert.equal(installs, 1, "启动后空闲、没有任务时自动安装");

  // 启动 3 分钟后要更长的空闲；没下载好的版本不装。
  reset(); clock = 4 * 60_000; idle = 60; await auto.tick(); assert.equal(requests, 1, "过了启动窗口，空闲 1 分钟不够");
  state = { stage: "downloading", updateRequested: false }; idle = 600; await auto.tick(); assert.equal(requests, 1, "还没校验完的版本不装");

  // 请求后一直在等任务（例如产品详情图在做）：20 秒后撤回，10 分钟内不再尝试。
  reset(); waiting = "正在等待图片和视频制作完成。";
  await auto.tick(); assert.equal(requests, 2);
  clock += 10_000; await auto.tick(); assert.equal(cancels, 0, "等待未超时不撤回");
  clock += 15_000; await auto.tick(); assert.equal(cancels, 1, "等待超时后撤回，释放占用");
  clock += 60_000; await auto.tick(); assert.equal(requests, 2, "撤回后 10 分钟内不再尝试");
  clock += 10 * 60_000; await auto.tick(); assert.equal(requests, 3, "退避结束后再次尝试");

  // 用户自己点了「立即更新」：自动逻辑不能撤回它。
  auto.userRequested(); clock += 60_000; await auto.tick(); assert.equal(cancels, 1, "用户点的更新不会被自动撤回");
  assert.equal(state.updateRequested, true);
  console.log("update auto self-check passed");
})().catch(error => { console.error(error); process.exit(1); });
