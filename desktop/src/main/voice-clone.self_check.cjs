const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createVoiceCloneClient } = require('./voice-clone-client.cjs');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxi-voice-clone-'));
  let submitted = 0;
  let failOnce = false;
  let receiptsRead = 0;
  const sse = 'event: 352\ndata: {"code":0,"data":"YXVkaW8="}\n\nevent: 351\ndata: {"code":0,"data":null}\n\nevent: 152\ndata: {"code":20000000,"data":null}\n';
  const response = (text, status = 200) => ({ ok: status === 200, status, text: async () => text });
  const gatewayClient = {
    initialize: async () => {}, status: () => ({ capabilities: { volcengine_voice_clone: true } }), url: (value) => value,
    fetch: async (route) => {
      if (route.includes('/list')) return response(JSON.stringify({ inventory_configured: true, items: [{ speaker_id: 'S_owned', billing: 'prepaid', status: 2 }] }));
      if (route.includes('/status')) return response(JSON.stringify({ speaker_id: 'S_owned', billing: 'prepaid', status: 2 }));
      if (route.includes('/operations/')) { receiptsRead++; return response(sse); }
      submitted++;
      if (failOnce) { failOnce = false; throw new Error('simulated transport interruption'); }
      return response(sse);
    },
  };
  try {
    const client = createVoiceCloneClient({ gatewayClient, rootDir: root, ffmpegPath: 'unused', execFileImpl: async () => ({ stdout: '', stderr: '' }) });
    assert.equal((await client.list()).items[0].usable, true);
    const first = await client.synthesize({ speakerId: 'S_owned', text: '完整文案', operationId: 'voice-1' });
    assert.equal(first.voice_persona_id, 'S_owned');
    assert.equal((await fs.readFile(first.file)).toString(), 'audio');
    await client.synthesize({ speakerId: 'S_owned', text: '完整文案', operationId: 'voice-1' });
    assert.equal(submitted, 1, 'repackaging reuses already-paid audio');
    await assert.rejects(client.synthesize({ speakerId: 'S_owned', text: '另一份文案', operationId: 'voice-1' }), { code: 'voice_clone_operation_conflict' });
    failOnce = true;
    await assert.rejects(client.synthesize({ speakerId: 'S_owned', text: '中断恢复', operationId: 'voice-2' }));
    await client.synthesize({ speakerId: 'S_owned', text: '中断恢复', operationId: 'voice-2' });
    assert.equal(submitted, 2);
    assert.equal(receiptsRead, 1, 'unknown requests query original receipt instead of reposting');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('voice-clone self-check passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
