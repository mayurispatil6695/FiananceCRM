// Usage: node scripts/ocr-test.js <image-file> [out-straightened.png]
// Prints a summary only (mobile numbers are masked) so you can check accuracy without exposing data.
const fs = require('fs');
const { extractLeadsFromImage, terminateWorker } = require('../src/utils/imageOcr');

const mask = (m) => (m ? m.slice(0, 2) + '******' + m.slice(-2) : '');

(async () => {
  const file = process.argv[2];
  if (!file) return console.log('Usage: node scripts/ocr-test.js <image-file> [out.png]');
  const res = await extractLeadsFromImage(fs.readFileSync(file));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], res._debug.straight);

  console.log(JSON.stringify(res.meta, null, 2));
  const bad = res.rows.filter((r) => r.warn.length);
  console.log(`rows: ${res.rows.length}, clean: ${res.rows.length - bad.length}, need check: ${bad.length}`);
  res.rows.forEach((r, i) =>
    console.log(String(i + 1).padStart(2), r.date, mask(r.mobile), r.score, r.income, r.location, r.warn.length ? `WARN:${r.warn.join(',')}` : '')
  );
  await terminateWorker();
})().catch((e) => { console.error(e); process.exit(1); });
