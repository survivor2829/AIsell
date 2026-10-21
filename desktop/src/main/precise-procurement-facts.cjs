// Conservative extraction for explicitly labelled procurement documents. No model calls.
const ALIASES = Object.fromEntries(require('../shared/cleaning-equipment.json').map(e => [e.name, e.aliases]));
function procurementFacts(source, attachments) {
  const main = source.text, name = main.match(/项目名称\s*[：:]\s*([^\n]+)/)?.[1]?.trim();
  const code = main.match(/项目编号\s*[：:]\s*([\w-]+)/)?.[1];
  if (!name || !code || main.length > 12000 || !/采购|询价/.test(name)) return null;
  const linked = attachments.filter(a => a.text.includes(code) && a.text.includes(name));
  if (!linked.length) return null;
  const rows = linked.flatMap(a => a.text.split('\n').map(quote => ({ sourceId: a.id, quote: quote.trim() })).filter(r => r.quote));
  const places = rows.filter(r => /(?:交付|交货|供货|项目)地点\s*[：:]/.test(r.quote));
  const addresses = [...new Set(places.map(r => r.quote.match(/(?:交付|交货|供货|项目)地点\s*[：:]\s*(.+)/)?.[1]?.trim()).filter(Boolean))];
  if (addresses.length !== 1) return null; // Conflicting or missing locations need review.
  const address = addresses[0], city = address.match(/(?:省|自治区)([^省区县\s，。]{2,8}市)/)?.[1];
  if (!city) return null;
  const buyerRow = rows.find(r => /采购人为[^，。；\n]+/.test(r.quote));
  const buyer = buyerRow?.quote.match(/采购人为([^，。；\n]+)/)?.[1]?.trim();
  if (!buyer || !main.includes(buyer)) return null;
  const datePattern = '\\d{4}\\s*[-年/.]\\s*\\d{1,2}\\s*[-月/.]\\s*\\d{1,2}\\s*日?';
  const published = main.match(new RegExp('发布时间[：:]\\s*(' + datePattern + ')'))?.[1]?.trim();
  const deadline = main.match(new RegExp('截止时间[^\\n：:]{0,50}[：:]\\s*(' + datePattern + '(?:\\s*\\d{1,2}\\s*[:时点]\\s*\\d{1,2}\\s*分?(?:\\s*\\d{2}\\s*秒)?)?)'))?.[1]?.trim();
  const business = main.match(/业务\s*联系方式\s*\n([^]*?)(?=\n[^\n]{0,12}监督|$)/)?.[1]?.trim();
  const phone = business?.match(/0\d{2,3}-\d{7,8}/)?.[0];
  const equipment = Object.keys(ALIASES).filter(e => ALIASES[e].some(a => name.includes(a)));
  if (!published || !deadline || !equipment.length) return null;
  // The title identifies the purchased service. Included accessories in the body
  // do not create a separate consumables opportunity.
  const services = Object.entries({ rental: /租赁|租用/, repair: /维修|维保|修理/, consumables: /耗材|刷盘|吸水胶条|尘袋|滤芯/ })
    .filter(([, pattern]) => pattern.test(name)).map(([service]) => service);
  if (!services.length) services.push('sale');
  // A download period explicitly running until quotation closes is the participation
  // window. Unknown registration conditions must not inherit the bid deadline.
  const acquisitionSection = main.match(/(?:获取|下载)[^\n]{0,40}(?:采购|招标|询价)[^\n]*文件[^]*?(?=\n\s*[四五六七八九十]+[、．.]|$)/)?.[0] || '';
  const explicitRegistration = main.match(new RegExp('(?:报名|登记|注册)[^\\n]{0,20}截止[^\\n：:]{0,20}[：:]\\s*(' + datePattern + '(?:\\s*\\d{1,2}\\s*[:时点]\\s*\\d{1,2}\\s*分?)?)'));
  const participationDeadlineRaw = explicitRegistration?.[1]?.trim()
    || (/时间\s*[：:]\s*(?:报价|响应|投标)截止时间前/.test(acquisitionSection) ? deadline : '');
  const qualificationQuote = main.match(/(?:供应商|投标人)的?资格要求\s*[：:][^]*?(?=\n\s*[三四五六七八九十]+[、．.]|$)/)?.[0] || '';
  const compactQualification = qualificationQuote.replace(/\s/g, '');
  const basicQualification = /依法注册/.test(compactQualification) && /营业执照/.test(compactQualification)
    && /业绩要求[：:](?:\/|无|不要求)[。.;；]/.test(compactQualification)
    && /其他资格要求[：:](?:\/|无|不要求)[。.;；]/.test(compactQualification)
    && !/资质|认证|许可证|制造商|生产厂家|经销商|代理商|注册资本|实缴资本|本地|本市|本省|营业额|净资产|服务网点|专利/.test(compactQualification);
  const quotes = [{ sourceId: source.id, quote: main }, ...places, buyerRow].filter(Boolean);
  return { projectName: name, projectCode: code, projectCity: city, address, eventDateRaw: published, publishedAtRaw: published, deadlineRaw: deadline,
    participationDeadlineRaw, qualificationQuote, qualificationStatus: basicQualification ? 'basic' : 'unknown',
    fieldEvidence: { projectName: { sourceId: source.id, quote: name }, projectLocation: places[0], buyer: buyerRow,
      deadline: { sourceId: source.id, quote: deadline }, participation: { sourceId: source.id, quote: explicitRegistration?.[0] || acquisitionSection },
      qualification: { sourceId: source.id, quote: qualificationQuote } },
    district: address.slice(address.indexOf(city) + city.length).match(/^([^区县\s]{1,8}[区县])/)?.[1] || '',
    signal: 'procurement', equipment, services, quote: main, quoteParts: quotes,
    organizations: [{ name: buyer, role: 'buyer', roleQuote: buyerRow.quote }],
    contacts: phone ? [{ organization: buyer, phone, role: 'buyer', roleQuote: business, organizationQuote: buyerRow.quote }] : [] };
}
module.exports = { procurementFacts, ALIASES };
