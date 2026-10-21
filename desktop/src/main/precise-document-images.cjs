// Free, local-only OCR. Unknown/critical images remain review items; no model fallback.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
function boundedEntry(entry, limit) {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream(), chunks = []; let count = 0;
    stream.on('data', chunk => { count += chunk.length; if (count > limit) stream.destroy(Error('PUBLIC_ATTACHMENT_TOO_LARGE')); else chunks.push(chunk); });
    stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
async function localOcr(bytes) {
  if (process.platform !== 'win32' || bytes.length > 2 * 1024 * 1024) return { status: 'unavailable' };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'precise-document-'));
  try {
    const file = path.join(directory, 'image.bin'); await fs.writeFile(file, bytes);
    return await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'precise-document-ocr.ps1'), '-ImagePath', file],
      { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => {
        try { resolve(error ? { status: 'unavailable' } : JSON.parse(stdout.trim())); } catch { resolve({ status: 'unavailable' }); }
      }));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function imageClassification(context, result) {
  const nearby = context.replace(/\s/g, ''), recognized = String(result.text || '').replace(/\s/g, '');
  // Only a positively identified tax-portal illustration can be non-critical.
  // This is document structure + independent OCR, never a file/project allowlist.
  const taxExample = /(?:示例|样例|举例)[：:]?$/.test(nearby)
    && /(?:纳税规模查询|一般纳税人资格查询)/.test(nearby)
    && /税务局/.test(recognized) && /纳税人/.test(recognized) && /资格类型/.test(recognized) && /认定有效/.test(recognized)
    && !/采购数量|交货地点|投标截止|报名截止|技术参数|采购需求/.test(recognized);
  return result.status === 'completed' && taxExample ? 'tax-portal-example' : 'needs-review';
}
async function inspectDocumentImages(zip, xml, toText, { ocr = localOcr } = {}) {
  const imageTags = [...xml.matchAll(/<(?:w:drawing|w:pict)\b[^]*?<\/(?:w:drawing|w:pict)>/g)];
  const incompleteMarkup = /<w:altChunk\b/.test(xml) || (xml.match(/<w:(?:drawing|pict)\b/g) || []).length !== imageTags.length;
  if (!imageTags.length) return { parseIncomplete: incompleteMarkup, images: [] };
  const relEntry = zip.file('word/_rels/document.xml.rels');
  if (!relEntry || relEntry._data.uncompressedSize > 256 * 1024) return { parseIncomplete: true, images: [{ status: 'needs-review', reason: 'image-relationship-unavailable' }] };
  const relationships = (await boundedEntry(relEntry, 256 * 1024)).toString('utf8'), images = [];
  for (const match of imageTags.slice(0, 3)) {
    const id = match[0].match(/(?:r:embed|r:id)="([^"]+)"/)?.[1];
    const relation = [...relationships.matchAll(/<Relationship\b[^>]+>/g)].find(m => m[0].match(/\bId="([^"]+)"/)?.[1] === id)?.[0];
    const target = relation?.match(/\bTarget="([^"]+)"/)?.[1];
    const imagePath = target && path.posix.normalize(path.posix.join('word', target));
    const entry = imagePath?.startsWith('word/media/') && !/TargetMode="External"/.test(relation) && zip.file(imagePath);
    const context = toText(xml.slice(0, match.index)).slice(-600);
    let result = { status: 'unavailable' };
    if (entry && entry._data.uncompressedSize <= 2 * 1024 * 1024) result = await ocr(await boundedEntry(entry, 2 * 1024 * 1024));
    const status = imageClassification(context, result);
    images.push({ status, context, ocrStatus: result.status, ocrText: String(result.text || '').slice(0, 16000), method: 'local-windows-ocr' });
  }
  return { parseIncomplete: incompleteMarkup || imageTags.length > 3 || images.some(i => i.status === 'needs-review'), images };
}
module.exports = { inspectDocumentImages, imageClassification, localOcr };
