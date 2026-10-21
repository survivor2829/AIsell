const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBusinessAi } = require('./business-ai.cjs');
const { registerBusinessWorkbenchIpc } = require('./business-workbench-ipc.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'business-workbench-check-'));
  let service;
  try {
    let calls = 0;
    const aiDir = path.join(directory, 'billing');
    const costQuote = '隔离成本项目 嘉兴市 2026-10-15 2099-01-01 洗地机采购';
    const client = { businessContent: async input => { calls++;
      if (input?.prompt.includes('[force-timeout]')) throw Error('isolated provider timeout');
      return { content: input?.kind === 'precise-facts' ? JSON.stringify({ quote: costQuote, projectName: '隔离成本项目', projectCity: '嘉兴市', eventDate: '2026-10-15', deadline: '2099-01-01', signal: 'procurement', equipment: ['洗地机'], services: ['sale'] }) : '{"answer":"事实"}', usage: { promptTokens: null, completionTokens: 7 } }; } };
    const ai = createBusinessAi({ dataDir: aiDir, client });
    await assert.rejects(ai.request({ prompt: '事实' }), /未批准/);
    assert.equal(calls, 0);
    fs.mkdirSync(aiDir, { recursive: true });
    fs.writeFileSync(path.join(aiDir, 'budget-approval.json'), JSON.stringify({ approved: true, approvedAt: new Date().toISOString(), maxCalls: 1 }));
    const result = await ai.request({ prompt: '事实' });
    assert.equal(result.usage.promptTokens, null);
    assert.deepEqual(await ai.request({ prompt: '事实' }), result, 'Cached result is reusable after the call limit');
    assert.equal(calls, 1);
    await assert.rejects(ai.request({ prompt: '新请求' }), /上限/);
    fs.writeFileSync(path.join(aiDir, 'ai-requests.json'), JSON.stringify([{ hash: 'pending', status: 'executing' }]));
    const recovered = createBusinessAi({ dataDir: aiDir, client });
    assert.equal(recovered.snapshot().ledger[0].status, 'outcome_unknown');

    const handlers = new Map();
    const frame = {}, sender = { mainFrame: frame, send() {} };
    const window = { webContents: sender, isDestroyed: () => false };
    service = registerBusinessWorkbenchIpc({ dataDir: path.join(directory, 'workspace'), ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel)
    }, getMainWindow: () => window, deepSeekClient: client, shell: { openExternal() { throw Error('Unexpected external navigation'); } }, dialog: {} });
    const invoke = handlers.get('geo-workbench:invoke');
    assert.equal((await invoke({ sender, senderFrame: {} }, 'status')).code, 'BUSINESS_IPC_FORBIDDEN');
    assert.equal((await invoke({ sender: {}, senderFrame: frame }, 'status')).ok, false);
    const trusted = { sender, senderFrame: frame };
    assert.equal((await invoke(trusted, 'save-brand', { name: '验收品牌', services: '清洁设备' })).ok, true);
    assert.equal((await invoke(trusted, 'save-settings', { budgetApproved: true })).ok, false);
    const status = await invoke(trusted, 'status');
    assert.equal(status.state.brand.name, '验收品牌');
    assert.ok(status.state.channels.every(channel => channel.publish === false));
    const map = await handlers.get('map-acquisition:invoke')(trusted, 'save-task', { city: '嘉兴市', device: '洗地机', keywords: ['保洁公司'] });
    assert.equal(map.ok, true);
    assert.equal(map.state.tasks[0].rangeMeters, null);
    const precise = handlers.get('precise-acquisition:invoke');
    assert.equal((await precise({ sender: {}, senderFrame: frame }, 'status')).code, 'BUSINESS_IPC_FORBIDDEN');
    const source = await precise(trusted, 'import-source', { text: costQuote, url: 'https://example.com/cost' });
    const sourceId = source.state.sources[0].id;
    assert.equal((await precise(trusted, 'organize-source', { sourceId })).ok, false);
    const priceDir = path.join(directory, 'workspace/precise-acquisition/billing'); fs.mkdirSync(priceDir, { recursive: true });
    const approval = { approved: true, approvedAt: new Date().toISOString(), maxCalls: 5, costPerCallCeilingMicros: 1, totalBudgetMicros: 1000000,
      pricing: { model: require('./deepseek-api.cjs').DEEPSEEK_MODEL, currency: 'CNY', verifiedAt: new Date().toISOString(), inputMicrosPerMillion: 1000000, outputMicrosPerMillion: 1000000 } };
    fs.writeFileSync(path.join(priceDir, 'budget-approval.json'), JSON.stringify(approval));
    const denied = await precise(trusted, 'organize-source', { sourceId });
    assert.equal(denied.ok, false); assert.match(denied.error, /金额上限/); assert.equal(calls, 1);
    approval.costPerCallCeilingMicros = 100000;
    fs.writeFileSync(path.join(priceDir, 'budget-approval.json'), JSON.stringify(approval));
    assert.equal((await precise(trusted, 'organize-source', { sourceId })).ok, true); assert.equal(calls, 2);
    assert.equal((await precise(trusted, 'organize-source', { sourceId })).ok, true); assert.equal(calls, 2, 'repeat must reuse the receipt');
    const timeout = await precise(trusted, 'import-source', { text: '[force-timeout] 原文', url: 'https://example.com/timeout' });
    const timeoutId = timeout.state.sources.at(-1).id;
    assert.equal((await precise(trusted, 'organize-source', { sourceId: timeoutId })).ok, false); assert.equal(calls, 3);
    assert.equal((await precise(trusted, 'organize-source', { sourceId: timeoutId })).ok, false); assert.equal(calls, 3, 'unknown outcome must not be repurchased');
    const reservations = JSON.parse(fs.readFileSync(path.join(priceDir, 'cost-reservations.json'), 'utf8'));
    assert.equal(reservations.length, 2); assert.equal(reservations[1].state, 'unknown');
    console.log('business workbench self-check passed: IPC identity, closed gates, billing, cache and recovery');
  } finally {
    await service?.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
