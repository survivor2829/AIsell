const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readFailureEvidence, collectFailureEvidenceFiles } = require('./failure-evidence.cjs');
const { createDiagnosticLogger } = require('./diagnostics.cjs');
const { reportEntry } = require('../shared/cloud-report.cjs');
const { FAILURE_EVIDENCE_SCRIPT } = require('../../rpa/active_touch/failure-evidence.cjs');
const catalog = require('../shared/wechat-rule-catalog.json');
const { createFeedbackController } = require('./feedback-controller.cjs');
const { FAILURE_CLASSIFICATIONS, workflowPolicies, classifyWechatFailure } = require('../shared/wechat-failure-policy.cjs');

async function main() {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-evidence-test-'));
try {
  const ids = new Set();
  const catalogPairs = new Set(catalog.map(row => `${row.id}\0${row.reason}`));
  for (const row of catalog) {
    assert(!ids.has(row.id), `duplicate rule ${row.id}`); ids.add(row.id);
    assert(["environment", "recoverable", "blocker"].includes(row.classification), `unclassified rule ${row.id}`);
    const source = fs.readFileSync(path.resolve(__dirname, '../..', row.file.replace(/^desktop\//, '')), 'utf8');
    assert(source.includes(`"${row.dynamic ? row.condition : row.id}"`), `missing source ${row.id}`);
  }
  for (const [reason, policy] of Object.entries(workflowPolicies)) {
    assert(FAILURE_CLASSIFICATIONS.includes(policy.classification), `unclassified workflow reason ${reason}`);
    assert(["task", "global"].includes(policy.attentionScope), `missing attention scope ${reason}`);
  }
  assert.deepEqual(classifyWechatFailure({ rule_id: 'image-r007', blocked_reason: 'brand_new_unclassified_reason' }), {
    reasonCode: 'brand_new_unclassified_reason', ruleId: 'image-r007', ruleMatchesReason: false,
    classification: 'blocker', attentionScope: 'global', known: false
  }, 'a known rule id must not hide an unclassified reason');
  for (const row of catalog) {
    const source = fs.readFileSync(path.resolve(__dirname, '../..', row.file.replace(/^desktop\//, '')), 'utf8');
    for (const match of source.matchAll(/Write-XiaoxiFailure\s+["']([a-z0-9.-]+)["']\s+["']([a-z][a-z0-9_]{1,79})["']/g)) {
      assert(catalogPairs.has(`${match[1]}\0${match[2]}`), `unclassified source rule/reason ${match[1]} -> ${match[2]}`);
    }
  }
  const trace = '12345678-1234-1234-1234-123456789012';
  const directory = path.join(root, 'failure-evidence');
  // A synthetic PrintWindow implementation draws red; no actual window is read.
  const program = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing;
public static class XiaoxiFailureCapture {
 public struct RECT { public int L,T,R,B; }
 public static IntPtr GetForegroundWindow() { return new IntPtr(1); }
 public static uint GetWindowThreadProcessId(IntPtr w,out uint p) { p=1; return 1; }
 public static bool GetWindowRect(IntPtr w,out RECT r) { r=new RECT{R=100,B=80}; return true; }
 public static bool PrintWindow(IntPtr w,IntPtr dc,uint flags) { using(var g=Graphics.FromHdc(dc)) g.Clear(Color.Red); return true; }
}
"@
function Get-Process { param($Id) return @{ProcessName='WeChat'} }
${FAILURE_EVIDENCE_SCRIPT}
$first=Write-XiaoxiFailure 'search-r003' 'search_result_identity_unverified'
$second=Write-XiaoxiFailure 'draft-read.copy' 'input_draft_read_failed'
if($first -cne 'search-r003' -or $second -cne 'draft-read.copy') { throw 'changed_result' }
$png=Get-ChildItem -LiteralPath $env:XIAOXI_FAILURE_DIR -Filter '*.png'
$bmp=[Drawing.Bitmap]::FromFile($png.FullName)
try { foreach($point in @(@(0,0),@($bmp.Width-1,0),@(0,$bmp.Height-1),@($bmp.Width-1,$bmp.Height-1),@(50,40))) { if($bmp.GetPixel($point[0],$point[1]).ToArgb() -ne [Drawing.Color]::DimGray.ToArgb()) { throw 'unmasked_pixels' } } } finally { $bmp.Dispose() }
`;
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))'],
  { input: Buffer.from(program).toString('base64'), encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, XIAOXI_FAILURE_DIR: directory, XIAOXI_FAILURE_TRACE: trace } });
  assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
  const entries = readFailureEvidence(root);
  assert.equal(entries.length, 2);
  assert.equal(entries.filter(e => e.details.capture_status === 'saved').length, 1);
  assert.equal(entries.filter(e => e.details.capture_status === 'throttled').length, 1);
  for (const entry of entries) {
    const report = reportEntry(entry, { installId: trace });
    assert(report, 'evidence must survive cloud report identity validation');
    assert.equal(report.traceId, trace);
    assert.equal(report.details.rule_id, entry.details.rule_id);
  }
  const logger = createDiagnosticLogger({ rootDir: root });
  logger.event('wechat_adapter', 'test', { rule_id: 'search-r003', input_read_exception_hresult: 'hresult_800401D0', message: 'PRIVATE', raw_text: 'PRIVATE' }, { level: 'error' });
  const logged = logger.readRecent(1)[0];
  assert.equal(logged.details.rule_id, 'search-r003');
  assert.equal(logged.details.input_read_exception_hresult, 'hresult_800401D0');
  logger.event('active_touch', 'image', { rule_id: 'image-r007', driver_stage: 'clipboard_image_write', error_line: 167,
    driver_error_id: 'SetImage', driver_exception_type: 'System.Runtime.InteropServices.ExternalException',
    driver_exception_hresult: 'hresult_800401D0' }, { level: 'error' });
  const imageLogged = logger.readRecent(1)[0];
  assert.equal(imageLogged.details.rule_id, 'image-r007');
  assert.equal(imageLogged.details.driver_stage, 'clipboard_image_write');
  assert.equal(imageLogged.details.error_line, 167);
  assert(!JSON.stringify(reportEntry(logged, { installId: trace })).includes('PRIVATE'));
  const bundle = collectFailureEvidenceFiles(root);
  assert.equal(bundle.filter(e => e.name.endsWith('.png')).length, 1);
  assert.equal(bundle.filter(e => e.name.endsWith('.json')).length, 2);
  const feedback = createFeedbackController({ rootDir: root, version: '1.1.33', buildId: 'diagnostic-test',
    config: { enabled: false },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value) },
    logger: { readRecent: () => Array.from({ length: 60 }, (_, seq) => ({ ...logged, seq, ts: new Date().toISOString() })) } });
  await feedback.submit({ ...feedback.status().draft, text: 'diagnostic test', includeDiagnostics: true });
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'feedback', 'state.json'), 'utf8')).items[0].payload.diagnostics;
  assert.equal(stored.length, 20);
  assert.equal(stored.filter(e => e.event === 'rule.rejected').length, 2, 'newer logs must not crowd out rejection evidence');
  feedback.stop();
  console.log(`failure evidence passed: ${catalog.length} unique rules, synthetic redaction, throttle, local/cloud transport and export`);
} finally {
  // Only the unique test directory created above; no production data.
  fs.rmSync(root, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
