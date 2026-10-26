// 生成安装包自带的爆款文案库：读一份文案库（网关公开版或内部发布文件都行），校验后只留标题、真实数据和流图，
// 原口播全文不进安装包。用法：node scripts/export-viral-library-seed.cjs <文案库.json>
const fs = require('node:fs');
const path = require('node:path');
const { validateLibrary, publicDoc } = require('../src/main/viral-library.cjs');

const input = process.argv[2];
if (!input) { console.error('用法：node scripts/export-viral-library-seed.cjs <文案库.json>'); process.exit(1); }
const library = validateLibrary(JSON.parse(fs.readFileSync(input, 'utf8')));
const target = path.join(__dirname, '..', 'resources', 'viral-library', 'seed.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(publicDoc(library), null, 1)}\n`);
console.log(`seed.json: ${library.items.length} 条爆款，${library.strands.length} 条流图线`);
