// Offline OCR for the vendor's lead photo. Nothing leaves this machine:
// tesseract.js runs locally and the English model is bundled via @tesseract.js-data/eng.
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

async function newWorker() {
  return createWorker('eng', 1, { langPath: LANG_PATH, gzip: true, cacheMethod: 'none' });
}

// Rotate, flatten colour, boost contrast and upscale so small photo text is readable.
const VARIANTS = {
  norm: (i) => i.grayscale().normalise().sharpen(),
  clahe: (i) => i.grayscale().clahe({ width: 64, height: 64, maxSlope: 3 }),
  plain: (i) => i.grayscale(),
};

async function prepare(buffer, angle, targetWidth, variant = 'norm') {
  let img = sharp(buffer).rotate(); // apply EXIF orientation first
  if (angle) img = img.rotate(angle);
  img = img.resize({ width: targetWidth, withoutEnlargement: false });
  return VARIANTS[variant](img).png().toBuffer();
}

// Photos of a screen are noisy and each setting misreads different rows,
// so we read the image several ways and let the passes fill each other's gaps.
const PASSES = [
  { width: 1920, variant: 'norm' },
  { width: 1920, variant: 'clahe' },
  { width: 2200, variant: 'plain' },
];

// How "table-like" is this text? Used to pick the right rotation.
function orientationScore(text) {
  const dates = (text.match(/\d{1,2}\s*[-–]\s*[A-Za-z]{3}\s*[-–]\s*\d{2}/g) || []).length;
  const mobiles = (text.match(/\b[6-9]\d{9}\b/g) || []).length;
  const heads = (text.match(/\b(date|mob|score|income|location)\b/gi) || []).length;
  return dates * 2 + mobiles * 3 + heads;
}

async function detectAngle(worker, buffer) {
  let best = { angle: 0, score: -1 };
  for (const angle of [0, 90, 270, 180]) {
    const small = await prepare(buffer, angle, 1000);
    const { data } = await worker.recognize(small);
    const score = orientationScore(data.text);
    if (score > best.score) best = { angle, score };
    if (score >= 15) break; // clearly the right way up
  }
  return best.angle;
}

// Common OCR mix-ups inside a token that is mostly digits.
function fixDigits(token) {
  const digits = (token.match(/\d/g) || []).length;
  if (token.length < 3 || digits / token.length < 0.6) return token;
  return token.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
}

function parseDate(m) {
  const monthText = m[2].toLowerCase().replace(/0/g, 'o').replace(/1/g, 't').replace(/5/g, 's');
  const mon = MONTHS[monthText];
  if (mon === undefined) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(year, mon, Number(m[1])));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// One OCR line -> one lead. Parsing by content (not column position) copes with
// the slight skew you get when photographing a screen.
function parseLine(line) {
  const text = line.replace(/[|_~]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const dm = text.match(/(\d{1,2})\s*[-–.]\s*([A-Za-z0-9]{3})\s*[-–.]\s*(\d{2,4})/);
  const date = dm ? parseDate(dm) : null;
  // Drop the sheet's row number (and anything else) before the date.
  let rest = dm ? text.slice(dm.index + dm[0].length) : text;

  const tokens = rest.split(' ').filter(Boolean).map(fixDigits);

  // Mobile: a 10-digit token, or two adjacent numeric tokens that add up to 10 digits.
  let mobile = null;
  let used = new Set();
  for (let i = 0; i < tokens.length && !mobile; i++) {
    if (/^\d{10}$/.test(tokens[i])) {
      mobile = tokens[i];
      used.add(i);
    } else if (/^\d+$/.test(tokens[i]) && /^\d+$/.test(tokens[i + 1] || '') && (tokens[i] + tokens[i + 1]).length === 10) {
      mobile = tokens[i] + tokens[i + 1];
      used.add(i).add(i + 1);
    }
  }

  // Nothing valid: keep the closest-looking token (7+ digits) so the reviewer only has to fix it.
  if (!mobile) {
    const i = tokens.findIndex((t) => (t.match(/\d/g) || []).length >= 7 && t.replace(/\D/g, '').length <= 12);
    if (i >= 0) {
      mobile = tokens[i].replace(/\D/g, '');
      used.add(i);
    }
  }

  const left = tokens.filter((_, i) => !used.has(i));
  const nums = left.filter((t) => /^\d+$/.test(t));
  const score = nums.find((t) => t.length === 3 && Number(t) >= 300 && Number(t) <= 900) || null;
  const income = nums.find((t) => t !== score && t.length >= 4 && t.length <= 8) || null;
  const location = left
    .filter((t) => !/^\d+$/.test(t) && /[A-Za-z]/.test(t))
    .join(' ')
    .replace(/[^A-Za-z .&-]/g, '')
    .trim();

  // Not a data row (header, footer, sheet tab name, stray noise)
  if (!mobile && !date && !score && !income) return null;

  return { date, mobile: mobile || '', score, income, location, rawText: text };
}

const DEFAULT_LOCATIONS = ['NO BRANCH', 'DELHI', 'MUMBAI', 'BANGALORE', 'CHENNAI', 'KOLKATA', 'HYDERABAD', 'PUNE', 'AHMEDABAD', 'SURAT', 'JAIPUR', 'LUCKNOW', 'KANPUR', 'NAGPUR', 'INDORE', 'BHOPAL', 'PATNA', 'VADODARA', 'GHAZIABAD', 'LUDHIANA', 'AGRA', 'NASHIK', 'FARIDABAD', 'MEERUT', 'RAJKOT', 'VARANASI', 'SRINAGAR', 'AMRITSAR', 'JAMMU', 'CHANDIGARH', 'BHUBANESWAR', 'RANCHI', 'RAIPUR', 'COIMBATORE', 'KOCHI', 'VISAKHAPATNAM', 'KURNOOL', 'PALAKKAD', 'PALAKAD', 'MYSORE', 'MADURAI', 'GURGAON', 'NOIDA', 'DEHRADUN', 'GUWAHATI', 'JODHPUR', 'UDAIPUR', 'THANE', 'VIJAYAWADA', 'TIRUPATI'];

const validMobile = (m) => /^[6-9]\d{9}$/.test(m || '');
const complete = (r) => validMobile(r.mobile) && r.date && r.score && r.income && r.location;

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// "NOBRANCH", "MUMBAL", "aMMu" -> the closest known location, if it is clearly close.
function snapLocation(text, known) {
  if (!text) return text;
  const norm = (t) => t.toUpperCase().replace(/[^A-Z]/g, '');
  const t = norm(text);
  let best = null;
  let bestD = Infinity;
  let tie = false;
  for (const k of known) {
    const d = editDistance(t, norm(k));
    if (d < bestD) { best = k; bestD = d; tie = false; }
    else if (d === bestD && best !== k) tie = true;
  }
  const limit = Math.max(1, Math.floor(t.length * 0.3));
  return best && !tie && bestD <= limit ? best : text.toUpperCase();
}

const isKnown = (loc, known) => known.includes(loc);

// Fill gaps in the best pass using rows from the other passes (matched by score + income).
function mergePasses(passes, known) {
  const ranked = [...passes].sort(
    (a, b) => b.filter(complete).length - a.filter(complete).length || b.length - a.length
  );
  const [primary, ...others] = ranked;
  const sameRow = (a, b) =>
    (validMobile(a.mobile) && a.mobile === b.mobile) ||
    (a.score && b.score && a.score === b.score && (!a.income || !b.income || a.income === b.income));

  const merged = primary.map((row) => {
    const out = { ...row };
    for (const pass of others) {
      const match = pass.find((r) => sameRow(out, r));
      if (!match) continue;
      if (!validMobile(out.mobile) && validMobile(match.mobile)) out.mobile = match.mobile;
      for (const f of ['date', 'score', 'income']) if (!out[f] && match[f]) out[f] = match[f];
      if ((!out.location || !isKnown(out.location, known)) && match.location && isKnown(match.location, known)) out.location = match.location;
    }
    return out;
  });

  // Rows only another pass found (e.g. a line the primary pass dropped)
  for (const pass of others)
    for (const r of pass) {
      if (!complete(r) && !validMobile(r.mobile)) continue;
      if (!merged.some((m) => sameRow(m, r) || (validMobile(r.mobile) && m.mobile === r.mobile))) merged.push({ ...r });
    }
  return merged;
}

async function extractLeadsFromImage(buffer, { knownLocations = [] } = {}) {
  const worker = await newWorker();
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const angle = await detectAngle(worker, buffer);

    const passes = [];
    for (const p of PASSES) {
      const png = await prepare(buffer, angle, p.width, p.variant);
      const { data } = await worker.recognize(png);
      passes.push(data.text.split('\n').map(parseLine).filter(Boolean));
    }

    const known = [...new Set([...DEFAULT_LOCATIONS, ...knownLocations.filter(Boolean).map((l) => l.toUpperCase())])];
    const snapped = passes.map((rows) => rows.map((r) => ({ ...r, location: snapLocation(r.location, known) })));
    const rows = mergePasses(snapped, known);

    // Flag rows whose date differs from most of the sheet (a misread digit is likely).
    const counts = {};
    rows.forEach((r) => r.date && (counts[r.date] = (counts[r.date] || 0) + 1));
    const [topDate, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
    rows.forEach((r) => {
      const notes = [];
      if (!r.date) notes.push('date missing');
      else if (topCount / rows.length >= 0.6 && r.date !== topDate) notes.push('date differs from most rows');
      if (r.location && !isKnown(r.location, known)) {
        // A real place name has proper words. Short fragments like "CAI AA TE" are OCR noise.
        const plausible = r.location.length >= 4 && r.location.split(/\s+/).every((w) => w.length >= 3);
        if (plausible) notes.push('location not recognised');
        else { r.location = ''; notes.push('location unreadable'); }
      }
      if (notes.length) r.warning = notes.join(', ');
    });

    // Smaller JPEG of the corrected photo so the review screen can show it next to the rows.
    const previewImage =
      'data:image/jpeg;base64,' +
      (await sharp(buffer).rotate().rotate(angle || 0).resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString('base64');

    return { rows, angle, previewImage, passes: passes.length };
  } finally {
    await worker.terminate();
  }
}

module.exports = { extractLeadsFromImage, parseLine, snapLocation };