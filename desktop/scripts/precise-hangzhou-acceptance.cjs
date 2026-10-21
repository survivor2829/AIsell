// Opt-in free, read-only source acceptance. Isolated data; no browser/account access.
const fs = require('node:fs'), path = require('node:path');
const { createPublicSources } = require('../src/main/precise-public-sources.cjs');
const { createPreciseAcquisitionController, EQUIPMENT } = require('../src/main/precise-acquisition.cjs');
async function main() {
  if (!process.argv.includes('--live')) throw Error('Use --live to read public catalogs; this does not contact customers or invoke paid services.');
  const directory = path.resolve(__dirname, '../.build/hangzhou-auto', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(directory, { recursive: true });
  const sources = createPublicSources(), calls = []; let earlyResults = false;
  const controller = createPreciseAcquisitionController({ dataDir: directory,
    gateway: async (action, body) => {
      calls.push({ action, at: new Date().toISOString(), ...(action === 'read' ? { url: body.url } : {}) });
      return action === 'status' ? sources.status() : action === 'search' ? sources.search(body) : sources.read(body.url, body);
    }, onChange: state => { if (state.batchPending && state.cards.length) earlyResults = true; }
  });
  try {
    await controller.dispatch('save-profile', { city: '杭州市', equipment: EQUIPMENT, services: ['sale', 'rental', 'repair', 'consumables'] });
    await controller.dispatch('start-task', { mapLimit: 2 });
    while (controller.snapshot().busy) await new Promise(r => setTimeout(r, 250));
    const state = controller.snapshot();
    const report = { verifiedAt: new Date().toISOString(), directory, entry: 'save-profile → start-task → public catalogs (no seeded URLs/facts)',
      earlyResults, paidCalls: 0, map: 'not-run: existing logged-in process is unavailable; no account opened or modified',
      task: state.tasks.at(-1), calls, cards: state.cards.map(c => ({ id: c.id, projectName: c.projectName, sourceUrl: c.sourceUrl,
        bucket: c.bucket, issues: c.issues, equipment: c.equipment, services: c.services, projectCity: c.projectCity, district: c.district,
        address: c.address, publishedAt: c.publishedAt, deadline: c.deadline, participationDeadline: c.participationDeadline,
        qualificationStatus: c.qualificationStatus, organizations: c.organizations, publicContactRoles: c.contacts.map(p => ({ role: p.role, organization: p.organization, sourceUrl: p.sourceUrl })),
        evidenceUrls: [...new Set(c.evidence.map(e => e.url))] })) };
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: path.join(directory, 'acceptance.json'), candidates: report.cards.length, recommended: report.cards.filter(c => c.bucket === 'recommended').length, earlyResults, map: report.map }));
    if (earlyResults || !report.cards.some(c => c.bucket === 'recommended')) process.exitCode = 2;
  } finally { await controller.dispose(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
