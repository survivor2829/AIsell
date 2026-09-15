const fs = require('node:fs');
const path = require('node:path');
const { sanitizeFailureDiagnostics } = require('../shared/failure-diagnostics.cjs');

function readFailureEvidence(rootDir) {
  const directory = path.join(rootDir, 'failure-evidence');
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) return [];
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name))
      .map(name => {
        try {
          const file = path.join(directory, name);
          if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16384) return null;
          const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!Number.isFinite(Date.parse(entry.ts)) || !/^[a-z0-9_.:-]{1,120}$/i.test(entry.code)) return null;
          const id = name.slice(0, 32);
          if (entry.details?.evidence_id !== id) return null;
          return { v: 1, run_id: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`, seq: 0,
            ts: entry.ts, module: 'wechat_adapter', event: 'rule.rejected', level: 'error',
            code: entry.code, trace_id: /^[a-f0-9-]{36}$/.test(entry.trace_id) ? entry.trace_id : '',
            details: sanitizeFailureDiagnostics(entry.details) };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 50);
  } catch { return []; }
}
function collectFailureEvidenceFiles(rootDir) {
  const crypto = require('node:crypto');
  const result = [];
  let bytes = 0;
  for (const entry of readFailureEvidence(rootDir)) {
    const id = entry.details.evidence_id;
    const json = Buffer.from(JSON.stringify(entry));
    result.push({ name: `failure-evidence/${id}.json`, content: json, size_bytes: json.length,
      sha256: crypto.createHash('sha256').update(json).digest('hex') });
    if (entry.details.capture_status !== 'saved' || entry.details.redaction_mode !== 'full_content') continue;
    try {
      const filename = path.join(rootDir, 'failure-evidence', `${id}.png`);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || bytes + stat.size > 20 * 1024 * 1024) continue;
      const content = fs.readFileSync(filename);
      if (!content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) continue;
      bytes += content.length;
      result.push({ name: `failure-evidence/${id}.png`, content, size_bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex') });
    } catch {}
  }
  return result;
}
module.exports = { readFailureEvidence, collectFailureEvidenceFiles };
