const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBusinessAi } = require('./business-ai.cjs');
const { registerBusinessWorkbenchIpc } = require('./business-workbench-ipc.cjs');

async function main() {
  const framework = fs.readFileSync(path.join(__dirname, '../renderer/BusinessAssistantPage.tsx'), 'utf8');
  for (const key of ['business-map', 'business-keyword', 'business-geo']) {
    assert.ok(framework.includes(`"${key}"`), `The acquisition framework exposes ${key}`);
  }
  assert.doesNotMatch(framework, /PreciseAcquisitionPanel|GeoWorkbenchPanel/, 'planned entries do not restore retired execution');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'business-workbench-check-'));
  let service;
  try {
    let calls = 0;
    const aiDir = path.join(directory, 'billing');
    const client = { businessContent: async input => { calls++;
      if (input?.prompt.includes('[force-timeout]')) throw Error('isolated provider timeout');
      return { content: '{"leads":[]}', usage: { promptTokens: null, completionTokens: 7 } }; } };
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
    const invoke = handlers.get('map-acquisition:invoke');
    assert.equal(handlers.has('precise-acquisition:invoke'), false);
    assert.equal(handlers.has('geo-workbench:invoke'), false);
    assert.equal((await invoke({ sender, senderFrame: {} }, 'status')).code, 'BUSINESS_IPC_FORBIDDEN');
    assert.equal((await invoke({ sender: {}, senderFrame: frame }, 'status')).ok, false);
    const trusted = { sender, senderFrame: frame };
    assert.equal((await invoke(trusted, 'save-settings', { budgetApproved: true })).ok, true);
    assert.equal((await invoke(trusted, 'status')).state.ai.budget.approved, false, 'renderer settings cannot grant an AI budget');
    const map = await invoke(trusted, 'save-task', { city: '嘉兴市', device: '洗地机', keywords: ['保洁公司'] });
    assert.equal(map.ok, true);
    assert.equal(map.state.tasks[0].rangeMeters, null);
    // Shared model protections survive the retirement of the procurement panel.
    const unknownDir = path.join(directory, 'unknown'); fs.mkdirSync(unknownDir);
    fs.writeFileSync(path.join(unknownDir, 'budget-approval.json'), JSON.stringify({ approved: true, approvedAt: new Date().toISOString(), maxCalls: 5 }));
    const unknown = createBusinessAi({ dataDir: unknownDir, client });
    await assert.rejects(unknown.request({ prompt: '[force-timeout]' }), /timeout/);
    assert.equal(calls, 2);
    await assert.rejects(unknown.request({ prompt: '[force-timeout]' }), /结果待核对/);
    assert.equal(calls, 2, 'unknown outcome is never repurchased');
    const reopened = createBusinessAi({ dataDir: unknownDir, client });
    await assert.rejects(reopened.request({ prompt: '[force-timeout]' }), /结果待核对/);
    assert.equal(calls, 2);
    console.log('business workbench self-check passed: IPC identity, closed gates, billing, cache and recovery');
  } finally {
    await service?.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
