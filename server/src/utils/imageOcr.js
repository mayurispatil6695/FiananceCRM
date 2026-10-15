// Reads a photo/screenshot of a lead table (Date, Mob, Score, Income, Location) fully on this machine.
// Steps: fix 90-degree rotation -> fix tilt -> OCR -> group words into rows -> parse each row.
// Nothing is sent anywhere and nothing is written to disk.
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

// English language data ships inside node_modules (@tesseract.js-data/eng), so no download is needed.
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int');

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, { langPath: LANG_PATH, cacheMethod: 'none', gzip: true }).catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

// Only one image is processed at a time (OCR is CPU heavy).
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function terminateWorker() {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    if (w) await w.terminate();
  }
}

/* ---------------------------------------------------------------- OCR ---- */

function extractWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const lines = data.lines || (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
  return lines.flatMap((l) => l.words || []);
}

async function ocrWords(buffer, psm = '6', { whitelist = '', dx = 0, dy = 0 } = {}) {
  const worker = await getWorker();
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    tessedit_char_whitelist: whitelist,
  });
  const { data } = await worker.recognize(buffer, {}, { blocks: true });
  return extractWords(data)
    .map((w) => ({
      text: String(w.text || '').trim(),
      conf: w.confidence ?? 0,
      x0: w.bbox.x0 + dx,
      x1: w.bbox.x1 + dx,
      yc: (w.bbox.y0 + w.bbox.y1) / 2 + dy,
      h: w.bbox.y1 - w.bbox.y0,
    }))
    .filter((w) => w.text);
}

// Group words into table rows by vertical position (works because the image is straightened first).
function clusterRows(words) {
  if (!words.length) return [];
  const hs = words.map((w) => w.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)] || 10;
  const sorted = [...words].sort((a, b) => a.yc - b.yc);

  const rows = [];
  let cur = [sorted[0]];
  let curY = sorted[0].yc;
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    if (w.yc - curY > medH * 0.6) {
      rows.push(cur);
      cur = [w];
      curY = w.yc;
    } else {
      cur.push(w);
      curY = cur.reduce((s, x) => s + x.yc, 0) / cur.length;
    }
  }
  rows.push(cur);
  return rows.map((r) => r.sort((a, b) => a.x0 - b.x0));
}

/* ------------------------------------------------------------ Parsing ---- */

const CONFUSABLE = { O: '0', o: '0', Q: '0', D: '0', l: '1', I: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };

// "98I2O..." -> digits, only if the token is mostly real digits already.
function numericForm(text) {
  const t = text.replace(/[,\s]/g, '');
  if (!t) return null;
  const real = (t.match(/\d/g) || []).length;
  if (real < t.length * 0.6) return null;
  const mapped = t.split('').map((c) => CONFUSABLE[c] ?? c).join('');
  return /^\d+$/.test(mapped) ? mapped : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const pad = (n) => String(n).padStart(2, '0');

function parseDateToken(text) {
  let m = text.match(/^([0-9OoIl]{1,2})[-–—._/]?([A-Za-z0]{3,4})[-–—._/]?([0-9OoIlS]{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().replace(/0/g, 'o').slice(0, 3)];
    const dayText = numericForm(m[1]);
    const yearText = numericForm(m[3]);
    if (mon !== undefined && dayText && yearText) {
      const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
      const day = Number(dayText);
      if (day >= 1 && day <= 31) return `${year}-${pad(mon + 1)}-${pad(day)}`;
    }
  }
  m = text.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31) {
      return `${year}-${pad(m[2])}-${pad(m[1])}`;
    }
  }
  return null;
}

const LOW_CONF = 65;

function parseRow(tokens) {
  const toks = tokens.map((t) => ({ ...t, num: numericForm(t.text) }));

  // Mobile: a 10-digit token (or two tokens that together make 10 digits).
  let mi = toks.findIndex((t) => t.num && t.num.length === 10);
  let mobile = mi >= 0 ? toks[mi].num : null;
  let mobileConf = mi >= 0 ? toks[mi].conf : 0;
  let mobileEnd = mi;
  if (mi < 0) {
    for (let i = 0; i < toks.length - 1; i++) {
      if (toks[i].num && toks[i + 1].num && toks[i].num.length + toks[i + 1].num.length === 10) {
        mi = i;
        mobileEnd = i + 1;
        mobile = toks[i].num + toks[i + 1].num;
        mobileConf = Math.min(toks[i].conf, toks[i + 1].conf);
        break;
      }
    }
  }
  if (mi < 0) {
    const t12 = toks.findIndex((t) => t.num && /^(91\d{10}|0\d{10})$/.test(t.num));
    if (t12 >= 0) {
      mi = mobileEnd = t12;
      mobile = toks[t12].num.slice(-10);
      mobileConf = toks[t12].conf;
    }
  }
  if (mi < 0) return null;

  const warn = [];
  if (!/^[6-9]/.test(mobile) || mobileConf < LOW_CONF) warn.push('mobile');

  // Date: nearest date-like token before the mobile (drops the row-number column on the far left).
  let date = null;
  let dateConf = 100;
  for (let i = mi - 1; i >= 0 && !date; i--) {
    const d = parseDateToken(toks[i].text);
    if (d) {
      date = d;
      dateConf = toks[i].conf;
    }
  }
  if (!date || dateConf < LOW_CONF) warn.push('date');

  // After the mobile: score, income, then location words.
  const after = toks.slice(mobileEnd + 1);
  let score = null;
  let scoreIdx = -1;
  for (let i = 0; i < after.length; i++) {
    const n = after[i].num;
    if (n && n.length === 3) {
      score = Number(n);
      scoreIdx = i;
      if (score >= 300 && score <= 900) break;
    }
  }
  if (score === null || score < 300 || score > 900 || after[scoreIdx].conf < LOW_CONF) warn.push('score');

  let income = null;
  let incomeIdx = -1;
  for (let i = scoreIdx + 1; i < after.length; i++) {
    const n = after[i].num;
    if (n && n.length >= 4 && n.length <= 8) {
      income = Number(n);
      incomeIdx = i;
      break;
    }
  }
  if (income === null || after[incomeIdx].conf < LOW_CONF) warn.push('income');

  const locTokens = after.slice(Math.max(scoreIdx, incomeIdx) + 1).filter((t) => /[A-Za-z]/.test(t.text));
  const location = locTokens
    .map((t) => t.text.replace(/[^A-Za-z .&-]/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (locTokens.length && Math.min(...locTokens.map((t) => t.conf)) < 50) warn.push('location');

  const locConf = locTokens.length ? Math.min(...locTokens.map((t) => t.conf)) : 0;
  return {
    date,
    mobile,
    score,
    income,
    location,
    warn,
    conf: { mobile: mobileConf, date: dateConf, score: after[scoreIdx]?.conf ?? 0, income: after[incomeIdx]?.conf ?? 0, location: locConf },
  };
}

// imgHeight lets rows from differently-scaled passes be compared by relative vertical position.
function parseRows(words, imgHeight = 1) {
  return clusterRows(words)
    .map((r) => {
      const row = parseRow(r.map((w) => ({ text: w.text, conf: w.conf })));
      if (row) row.ry = r.reduce((s, w) => s + w.yc, 0) / r.length / imgHeight;
      return row;
    })
    .filter(Boolean);
}

/* ------------------------------------------------------- Image fixing ---- */

async function loadBase(buffer) {
  const meta = await sharp(buffer).metadata();
  const long = Math.max(meta.width || 0, meta.height || 0);
  let img = sharp(buffer).rotate().flatten({ background: '#ffffff' }); // honour EXIF rotation if present
  if (long > 3200) img = img.resize({ width: meta.width >= meta.height ? 3200 : undefined, height: meta.height > meta.width ? 3200 : undefined });
  return img.png().toBuffer();
}

async function rotate90(buf, quarterTurns) {
  if (!quarterTurns) return buf;
  return sharp(buf).rotate(quarterTurns * 90).png().toBuffer();
}

// Finds the small tilt (in degrees) that makes text rows perfectly horizontal.
async function estimateSkew(buf) {
  const { data, info } = await sharp(buf).greyscale().resize({ width: 900 }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  // integral image for a local-contrast threshold (keeps text, ignores shadows)
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += data[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
    }
  }
  const win = 10;
  const xs = [];
  const ys = [];
  for (let y = win; y < h - win; y++) {
    for (let x = win; x < w - win; x++) {
      const x0 = x - win, x1 = x + win, y0 = y - win, y1 = y + win;
      const sum =
        integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((2 * win + 1) * (2 * win + 1));
      if (data[y * w + x] < mean * 0.78) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  if (xs.length < 500) return 0;

  const stride = Math.max(1, Math.floor(xs.length / 120000));
  const sharpness = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const off = Math.abs(w * s) + 2;
    const hist = new Float64Array(Math.ceil(h * c + Math.abs(w * s)) + 6);
    for (let i = 0; i < xs.length; i += stride) {
      hist[Math.round(xs[i] * s + ys[i] * c + off)]++;
    }
    let score = 0;
    for (let i = 0; i < hist.length; i++) score += hist[i] * hist[i];
    return score;
  };

  let best = 0;
  let bestScore = -1;
  for (let d = -12; d <= 12; d += 0.5) {
    const sc = sharpness(d);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  const centre = best;
  for (let d = centre - 0.5; d <= centre + 0.5; d += 0.05) {
    const sc = sharpness(d);
    if (sc > bestScore) { bestScore = sc; best = d; }
  }
  return Math.round(best * 100) / 100;
}

async function deskew(buf, deg) {
  if (Math.abs(deg) < 0.15) return buf;
  return sharp(buf).rotate(deg, { background: '#ffffff' }).png().toBuffer();
}

// Pure black-on-white using a local threshold, so shadows and uneven lighting in a photo don't matter.
function adaptiveBinarize(grey, w, h, radius, offset) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += grey[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + rowSum;
    }
  }
  const out = Buffer.alloc(w * h, 255);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const sum =
        integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      if (offset === null) {
        // Soft version: divide by the local background so lighting evens out but grey edges are kept.
        const ratio = grey[y * w + x] / (mean + 1);
        const v = ((ratio - 0.5) / 0.5) * 255;
        out[y * w + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      } else if (grey[y * w + x] < mean - offset) {
        out[y * w + x] = 0;
      }
    }
  }
  return out;
}

// Final cleanup for OCR: enlarge small photos, then either a local threshold ('adaptive') or plain contrast stretch ('plain').
async function enhance(buf, variant = 'adaptive', targetLong = 2600) {
  const meta = await sharp(buf).metadata();
  const long = Math.max(meta.width, meta.height);
  const scale = Math.min(3.5, Math.max(1, targetLong / long));
  let img = sharp(buf).greyscale();
  if (scale > 1.05) img = img.resize({ width: Math.round(meta.width * scale), kernel: 'lanczos3' });

  if (variant === 'plain') return img.normalise().sharpen().png().toBuffer();

  const { data, info } = await img.blur(0.6).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const radius = Math.max(12, Math.round(w / 110));
  const hard = adaptiveBinarize(data, w, h, radius, 10);
  const out = variant === 'hard' ? hard : adaptiveBinarize(data, w, h, radius, null);

  // Wipe out the table's own gridlines (long straight runs) so they don't glue cells together.
  const mask = lineMask(hard, w, h, Math.round(w / 45), Math.round(w / 60));
  for (let i = 0; i < out.length; i++) if (mask[i]) out[i] = 255;
  return sharp(out, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

// Marks black pixels that belong to a long horizontal or vertical run (a gridline), thickened by one pixel.
function lineMask(bin, w, h, minH, minV) {
  const raw = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && bin[y * w + x] === 0) run++;
      else {
        if (run >= minH) for (let i = 1; i <= run; i++) raw[y * w + x - i] = 1;
        run = 0;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && bin[y * w + x] === 0) run++;
      else {
        if (run >= minV) for (let i = 1; i <= run; i++) raw[(y - i) * w + x] = 1;
        run = 0;
      }
    }
  }
  const mask = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (raw[i] || raw[i - 1] || raw[i + 1] || raw[i - w] || raw[i + w]) mask[i] = 1;
    }
  }
  return mask;
}

/* ------------------------------------------------ Reading + voting ---- */
// The photo is read several times with different clean-up treatments. Where the readings agree we trust the value;
// where they disagree the majority wins, and the cell is flagged so a person double-checks it.

const PASSES = [
  { variant: 'adaptive', size: 2600 },
  { variant: 'hard', size: 2600 },
  { variant: 'adaptive', size: 3400 },
];

async function readPass(straight, { variant, size }) {
  const img = await enhance(straight, variant, size);
  const meta = await sharp(img).metadata();
  return parseRows(await ocrWords(img, '6'), meta.height);
}

const normLoc = (t) =>
  String(t || '')
    .toUpperCase()
    .replace(/[^A-Z .&-]/g, '')
    .replace(/[ .]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^NOBRANCH$/, 'NO BRANCH');

function tally(cands) {
  const m = new Map();
  for (const c of cands) {
    if (c.v === null || c.v === undefined || c.v === '') continue;
    const e = m.get(c.v) || { v: c.v, n: 0, conf: 0 };
    e.n++;
    e.conf += c.conf;
    m.set(c.v, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || b.conf - a.conf);
}

// A field is "in doubt" when readings differ and no value has a clear majority.
const inDoubt = (list) => list.length > 1 && (list[0].n < 2 || list[0].n === list[1].n);

function voteMobile(cands) {
  const list = tally(cands);
  if (!list.length) return { value: '', doubt: true };
  let value = list[0].v;
  let doubt = inDoubt(list);
  const tens = cands.filter((c) => c.v && c.v.length === 10);
  if (list.length > 1 && tens.length >= 3) {
    // vote digit by digit
    let merged = '';
    let tie = false;
    for (let i = 0; i < 10; i++) {
      const d = tally(tens.map((c) => ({ v: c.v[i], conf: c.conf })));
      merged += d[0].v;
      if (d.length > 1 && d[0].n === d[1].n) tie = true;
    }
    value = merged;
    doubt = tie || list.length > 1 && merged !== list[0].v && list[0].n < 2;
  }
  return { value, doubt };
}

function mergePasses(passes) {
  const all = passes.flatMap((rows, pass) => rows.map((r) => ({ ...r, pass })));
  if (!all.length) return [];

  // typical row spacing, from the pass that found the most rows
  const best = passes.reduce((a, b) => (b.length > a.length ? b : a), []);
  const ys = best.map((r) => r.ry).sort((a, b) => a - b);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 0.003).sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.02;

  all.sort((a, b) => a.ry - b.ry);
  const clusters = [];
  for (const r of all) {
    const last = clusters[clusters.length - 1];
    if (last && r.ry - last.mean <= pitch * 0.45 && !last.rows.some((x) => x.pass === r.pass)) {
      last.rows.push(r);
      last.mean = last.rows.reduce((s, x) => s + x.ry, 0) / last.rows.length;
    } else {
      clusters.push({ rows: [r], mean: r.ry });
    }
  }

  return clusters.map(({ rows }) => {
    const field = (key, norm = (v) => v) => rows.map((r) => ({ v: norm(r[key]), conf: r.conf[key] ?? 0 }));
    const warn = [];

    const mob = voteMobile(field('mobile', (v) => (v && /^\d+$/.test(v) ? v : '')));
    if (mob.doubt || mob.value.length !== 10 || !/^[6-9]/.test(mob.value)) warn.push('mobile');

    const dateList = tally(field('date'));
    if (!dateList.length || inDoubt(dateList)) warn.push('date');

    const scoreList = tally(field('score'));
    const score = scoreList.length ? scoreList[0].v : null;
    if (score === null || score < 300 || score > 900 || inDoubt(scoreList)) warn.push('score');

    const incomeList = tally(field('income'));
    if (!incomeList.length || inDoubt(incomeList)) warn.push('income');

    const locList = tally(field('location', normLoc));
    if (!locList.length || inDoubt(locList)) warn.push('location');

    return {
      date: dateList.length ? dateList[0].v : null,
      mobile: mob.value,
      score,
      income: incomeList.length ? incomeList[0].v : null,
      location: locList.length ? locList[0].v : '',
      warn,
    };
  });
}

/* -------------------------------------------------------------- Main ---- */

const countGood = (rows) => rows.filter((r) => !r.warn.length).length;

async function pickRotation(base) {
  // Try all four orientations on a smaller copy; the right one reads many valid 10-digit mobiles.
  const small = await sharp(base).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: false }).png().toBuffer();
  const results = [];
  for (let q = 0; q < 4; q++) {
    const words = await ocrWords(await enhance(await rotate90(small, q), 'adaptive', 1800));
    const rows = parseRows(words);
    const avgConf = words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length : 0;
    results.push({ q, rows: rows.length, good: countGood(rows), avgConf });
  }
  results.sort((a, b) => b.rows - a.rows || b.good - a.good || b.avgConf - a.avgConf);
  return { quarterTurns: results[0].q, tried: results };
}

async function extractLeadsFromImage(buffer) {
  return exclusive(async () => {
    const started = Date.now();
    const base = await loadBase(buffer);

    const { quarterTurns, tried } = await pickRotation(base);
    const upright = await rotate90(base, quarterTurns);
    const skew = await estimateSkew(upright);
    const straight = await deskew(upright, skew);

    const passes = [];
    for (const cfg of PASSES) passes.push(await readPass(straight, cfg));
    const rows = mergePasses(passes);

    // A readable, upright copy so the person can compare it with the extracted table.
    const preview = await sharp(straight).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();

    return {
      rows,
      preview: `data:image/jpeg;base64,${preview.toString('base64')}`,
      meta: {
        rotatedDegrees: quarterTurns * 90,
        tiltCorrectedDegrees: skew,
        readings: PASSES.length,
        rowsPerReading: passes.map((p) => p.length),
        rowsFound: rows.length,
        rowsNeedingCheck: rows.length - countGood(rows),
        seconds: Math.round((Date.now() - started) / 100) / 10,
        orientationTried: tried,
      },
      _debug: { straight },
    };
  });
}

module.exports = { extractLeadsFromImage, terminateWorker, parseRow, parseRows, numericForm, parseDateToken };
