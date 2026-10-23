const fs = require('node:fs');
const path = require('node:path');
const { sanitizeFailureDiagnostics } = require('../shared/failure-diagnostics.cjs');
const { scrubInternalDetails } = require('../shared/internal-diagnostics.cjs');

function readFailureEvidence(rootDir, { manifest = {} } = {}) {
  const directory = path.join(rootDir, 'failure-evidence');
  Object.assign(manifest, { source_count: 0, invalid_count: 0, omitted_count: 0, issues: [] });
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) { manifest.issues.push({ code: 'symbolic_link_excluded' }); return []; }
    const names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name));
    manifest.source_count = names.length;
    const rows = names
      .map(name => {
        try {
          const file = path.join(directory, name);
          if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 65536) throw new Error('invalid_evidence_file');
          const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!Number.isFinite(Date.parse(entry.ts)) || !/^[a-z0-9_.:-]{1,120}$/i.test(entry.code)) return null;
          const id = name.slice(0, 32);
          if (entry.details?.evidence_id !== id) return null;
          return { v: 1, run_id: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`, seq: 0,
            ts: entry.ts, module: 'wechat_adapter', event: 'rule.rejected', level: 'error',
            code: entry.code, trace_id: /^[a-f0-9-]{36}$/.test(entry.trace_id) ? entry.trace_id : '',
            details: sanitizeFailureDiagnostics(entry.details) };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    manifest.invalid_count = names.length - rows.length;
    manifest.omitted_count = Math.max(0, rows.length - 50);
    manifest.included_events = Math.min(rows.length, 50);
    return rows.slice(0, 50);
  } catch (error) { manifest.issues.push({ code: error?.code || 'evidence_read_failed' }); return []; }
}
function collectFailureEvidenceFiles(rootDir, { manifest = {}, includeRaw = false } = {}) {
  const crypto = require('node:crypto');
  const result = [];
  let bytes = 0;
  for (const entry of readFailureEvidence(rootDir, { manifest })) {
    const id = entry.details.evidence_id;
    let exported = entry;
    if (includeRaw && entry.details.redaction_mode === 'internal_visible') {
      try {
        const detail = JSON.parse(fs.readFileSync(path.join(rootDir, 'failure-evidence', `${id}.json`), 'utf8'));
        const safe = scrubInternalDetails(detail);
        exported = { ...entry, details: safe.value.details,
          ...(safe.truncation ? { truncation: safe.truncation } : {}) };
      } catch (error) { manifest.issues.push({ evidence_id: id, code: error?.code || 'raw_evidence_read_failed' }); }
    }
    const json = Buffer.from(JSON.stringify(exported));
    result.push({ name: `failure-evidence/${id}.json`, content: json, size_bytes: json.length,
      sha256: crypto.createHash('sha256').update(json).digest('hex') });
    if (entry.details.capture_status !== 'saved') continue;
    if (entry.details.redaction_mode !== 'full_content' && !(includeRaw && entry.details.redaction_mode === 'internal_visible')) {
      manifest.issues.push({ evidence_id: id, code: 'raw_capture_excluded_by_profile' }); continue;
    }
    try {
      const filename = path.join(rootDir, 'failure-evidence', `${id}.png`);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (includeRaw ? 5 : 1) * 1024 * 1024 || bytes + stat.size > 20 * 1024 * 1024) {
        manifest.issues.push({ evidence_id: id, code: 'capture_size_or_type_excluded' }); continue;
      }
      const content = fs.readFileSync(filename);
      if (!content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { manifest.issues.push({ evidence_id: id, code: 'invalid_png' }); continue; }
      bytes += content.length;
      result.push({ name: `failure-evidence/${id}.png`, content, size_bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex') });
    } catch (error) { manifest.issues.push({ evidence_id: id, code: error?.code || 'capture_read_failed' }); }
  }
  manifest.capture_bytes = bytes;
  return result;
}
module.exports = { readFailureEvidence, collectFailureEvidenceFiles };
