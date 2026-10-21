const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { inspectDocumentImages, imageClassification } = require('./precise-document-images.cjs');
const { pageText } = require('./precise-public-sources.cjs');
const { procurementFacts } = require('./precise-procurement-facts.cjs');
async function main() {
  const context = '纳税规模查询，一般纳税人资格查询。示例：';
  const ocr = { status: 'completed', text: '电子税务局 纳税人名称 资格类型 认定有效期' };
  assert.equal(imageClassification(context, ocr), 'tax-portal-example');
  assert.equal(imageClassification('采购设备技术参数：', ocr), 'needs-review');
  assert.equal(imageClassification(context, { status: 'unavailable' }), 'needs-review');
  assert.equal(imageClassification(context, { ...ocr, text: ocr.text + ' 采购数量3台' }), 'needs-review');
  const zip = new JSZip();
  zip.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="r1" Target="media/image.png"/></Relationships>');
  zip.file('word/media/image.png', Buffer.from('fixture'));
  const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
  const xml = `<w:p><w:t>${context}</w:t></w:p><w:drawing><a:blip r:embed="r1"/></w:drawing>`;
  const result = await inspectDocumentImages(loaded, xml, pageText, { ocr: async () => ocr });
  assert.equal(result.parseIncomplete, false);
  assert.equal((await inspectDocumentImages(loaded, xml + '<w:altChunk/>', pageText, { ocr: async () => ocr })).parseIncomplete, true);
  const text = '项目名称：洗地机采购项目\n项目编号：P01\n采购单位甲公司\n发布时间：2026年10月15日\n递交截止时间：2026年10月23日10点30分\n二、供应商的资格要求：\n1.依法注册并提供营业执照。\n2.业绩要求：/。\n3.其他资格要求：/。\n三、获取询价采购文件\n1.时间：报价截止时间前。\n四、其他';
  const source = { id: 'main', text };
  const attachments = [{ id: 'attachment', text: 'P01\n洗地机采购项目\n交货地点：浙江省杭州市钱塘区某路1号\n采购人为采购单位甲公司。' }];
  const facts = procurementFacts(source, attachments);
  assert.equal(facts.qualificationStatus, 'basic');
  assert.equal(facts.participationDeadlineRaw, facts.deadlineRaw);
  assert.equal(procurementFacts({ ...source, text: text.replace('其他资格要求：/。', '其他资格要求：持有安全生产许可证。') }, attachments).qualificationStatus, 'unknown');
  assert.equal(procurementFacts({ ...source, text: text.replace('报价截止时间前。', '另行通知。') }, attachments).participationDeadlineRaw, '');
  for (const [phrase, expected] of [['洗地机', 'sale'], ['洗地机租赁', 'rental'], ['洗地机维修', 'repair'], ['洗地机耗材', 'consumables']]) {
    const changed = { ...source, text: text.replaceAll('洗地机', phrase) };
    assert.deepEqual(procurementFacts(changed, attachments.map(a => ({ ...a, text: a.text.replaceAll('洗地机', phrase) }))).services, [expected]);
  }
  for (const equipment of require('../shared/cleaning-equipment.json')) for (const alias of equipment.aliases) {
    const changed = { ...source, text: text.replaceAll('洗地机', alias) };
    assert(procurementFacts(changed, attachments.map(a => ({ ...a, text: a.text.replaceAll('洗地机', alias) }))).equipment.includes(equipment.name), `catalog alias ${alias}`);
  }
  console.log('precise document image + participation checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
