const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');

function createBusinessAi({ dataDir, client }) {
  const file = path.join(dataDir, 'ai-requests.json');
  const approvalFile = path.join(dataDir, 'budget-approval.json');
  let ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  for (const entry of ledger) if (entry.status === 'executing') entry.status = 'outcome_unknown';
  let busy = false;
  const persist = () => writeJsonAtomic(file, ledger);
  if (ledger.length) persist();
  const policy = () => {
    if (!fs.existsSync(approvalFile)) return { approved: false, maxCalls: 0 };
    let value;
    try { value = JSON.parse(fs.readFileSync(approvalFile, 'utf8')); }
    catch { return { approved: false, maxCalls: 0, reason: '预算批准记录无法读取，付费请求保持关闭。' }; }
    return { approved: value.approved === true && typeof value.approvedAt === 'string' && Number.isSafeInteger(value.maxCalls) && value.maxCalls > 0,
      maxCalls: Number.isSafeInteger(value.maxCalls) ? value.maxCalls : 0 };
  };
  async function request(input) {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (ledger.some(entry => entry.hash === hash && entry.status === 'outcome_unknown')) throw Error('相同请求结果待核对，未重复调用。');
    const cached = ledger.find(entry => entry.hash === hash && entry.status === 'completed');
    if (cached) return cached.result;
    const budget = policy();
    if (!budget.approved || ledger.length >= budget.maxCalls) throw Error('新增 AI 预算未批准或调用上限已到，未发起请求。');
    if (busy) throw Error('已有 AI 请求正在处理，请先等待结果。');
    if (!client?.businessContent) throw Error('AI 服务尚未连接，未发起请求。');
    const entry = { id: randomUUID(), hash, kind: input.kind || 'business', status: 'executing', startedAt: new Date().toISOString(), usage: null, amount: null };
    ledger.push(entry); persist(); busy = true;
    try {
      const result = await client.businessContent(input);
      entry.result = result; entry.usage = result.usage || null; entry.status = 'completed'; entry.finishedAt = new Date().toISOString(); persist();
      return result;
    } catch (error) { entry.status = 'outcome_unknown'; entry.finishedAt = new Date().toISOString(); persist(); throw error; }
    finally { busy = false; }
  }
  return { request, policy, snapshot: () => ({ budget: policy(), ledger: ledger.map(({ result, hash, ...entry }) => entry) }) };
}
module.exports = { createBusinessAi };
