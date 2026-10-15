const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const Lead = require('../models/Lead');
const { STATUSES } = require('../models/Lead');
const { protect, allow } = require('../middleware/auth');
const { normalizeMobile, toNumber, toDate } = require('../utils/validate');

const router = express.Router();
router.use(protect);

// Files are kept in memory only and never written to disk (confidential data).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildFilter(req) {
  const { q, status, location, minScore, maxScore, from, to, assignedTo, followUp } = req.query;
  const filter = {};

  // Callers only see leads assigned to them.
  if (req.user.role === 'caller') filter.assignedTo = req.user._id;
  else if (assignedTo) filter.assignedTo = assignedTo;

  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ mobile: rx }, { location: rx }];
  }
  if (status) filter.status = status;
  if (location) filter.location = new RegExp(escapeRegex(location), 'i');
  if (minScore || maxScore) {
    filter.score = {};
    if (minScore) filter.score.$gte = Number(minScore);
    if (maxScore) filter.score.$lte = Number(maxScore);
  }
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      filter.date.$lte = end;
    }
  }
  if (followUp === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    filter.followUpDate = { $gte: start, $lte: end };
  }
  return filter;
}

// List with pagination
router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, parseInt(req.query.limit) || 25);
  const filter = buildFilter(req);

  const [items, total] = await Promise.all([
    Lead.find(filter)
      .populate('assignedTo', 'name')
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Lead.countDocuments(filter),
  ]);

  res.json({ items, total, page, pages: Math.ceil(total / limit) });
});

router.get('/meta', (req, res) => res.json({ statuses: STATUSES }));

// Export current filter to Excel
router.get('/export', allow('admin', 'manager'), async (req, res) => {
  const leads = await Lead.find(buildFilter(req)).populate('assignedTo', 'name').sort({ date: -1 });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Mobile', key: 'mobile', width: 14 },
    { header: 'Score', key: 'score', width: 10 },
    { header: 'Income', key: 'income', width: 14 },
    { header: 'Location', key: 'location', width: 18 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Follow-up', key: 'followUpDate', width: 14 },
    { header: 'Assigned To', key: 'assigned', width: 18 },
    { header: 'Remarks', key: 'remarks', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  leads.forEach((l) =>
    ws.addRow({
      date: l.date,
      mobile: l.mobile,
      score: l.score,
      income: l.income,
      location: l.location,
      status: l.status,
      followUpDate: l.followUpDate,
      assigned: l.assignedTo ? l.assignedTo.name : '',
      remarks: l.remarks,
    })
  );
  ws.getColumn('date').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('followUpDate').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('mobile').numFmt = '@';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// Step 1 of import: read the file and return a preview. Nothing is saved yet.
router.post('/import/preview', allow('admin', 'manager'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Please choose a file' });

  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(req.file.originalname)) {
      const { Readable } = require('stream');
      await wb.csv.read(Readable.from(req.file.buffer));
    } else {
      await wb.xlsx.load(req.file.buffer);
    }
  } catch (e) {
    return res.status(400).json({ message: 'Could not read this file. Use .xlsx or .csv' });
  }

  const ws = wb.worksheets[0];
  if (!ws) return res.status(400).json({ message: 'The file has no sheet' });

  const cellText = (c) => {
    const v = c.value;
    if (v && typeof v === 'object' && 'result' in v) return v.result;
    if (v && typeof v === 'object' && 'text' in v) return v.text;
    return v;
  };

  const headers = {};
  ws.getRow(1).eachCell((cell, col) => {
    headers[String(cellText(cell) || '').trim().toLowerCase()] = col;
  });
  const pick = (...names) => names.map((n) => headers[n]).find(Boolean);
  const cols = {
    date: pick('date'),
    mobile: pick('mobile', 'mob', 'mobile no', 'phone', 'mobile number'),
    score: pick('score', 'cibil', 'credit score'),
    income: pick('income', 'salary'),
    location: pick('location', 'city'),
  };
  if (!cols.mobile) {
    return res.status(400).json({ message: 'No Mobile column found in the first row' });
  }

  const rows = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const get = (c) => (c ? cellText(row.getCell(c)) : null);
    const raw = get(cols.mobile);
    if (raw === null || raw === undefined || raw === '') return;
    rows.push({
      date: toDate(get(cols.date)),
      mobile: String(raw).trim(),
      score: toNumber(get(cols.score)),
      income: toNumber(get(cols.income)),
      location: get(cols.location) ? String(get(cols.location)).trim() : '',
    });
  });

  res.json({ rows: await annotate(rows) });
});

// Image import: read a photo/screenshot of the vendor's sheet with local OCR.
// Nothing is saved yet; the review screen shows the photo next to the extracted rows.
// Several users can upload at once: images are read one after another in a queue
// (OCR is CPU-heavy), so each user simply waits their turn instead of getting an error.
let ocrQueue = Promise.resolve();
const inQueue = (job) => {
  const run = ocrQueue.then(job, job);
  ocrQueue = run.catch(() => {});
  return run;
};

router.post('/import/image', allow('admin', 'manager'), upload.single('file'), async (req, res) => {
  if (!req.file || !/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) {
    return res.status(400).json({ message: 'Please choose a JPG or PNG image' });
  }
  try {
    const { rows, previewImage } = await inQueue(async () => {
      const { extractLeadsFromImage } = require('../utils/ocr');
      const knownLocations = await Lead.distinct('location');
      return extractLeadsFromImage(req.file.buffer, { knownLocations });
    });
    if (!rows.length) {
      return res.status(422).json({ message: 'No lead rows could be read from this image. Try a clearer photo.' });
    }
    res.json({ rows: await annotate(rows), previewImage });
  } catch (err) {
    console.error('OCR failed:', err.message);
    res.status(500).json({ message: 'Could not read this image' });
  }
});

// Turn the reviewed rows straight into an Excel file (nothing is saved in the CRM).
router.post('/import/xlsx', allow('admin', 'manager'), async (req, res) => {
  const rows = req.body.rows || [];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Mobile', key: 'mobile', width: 14 },
    { header: 'Score', key: 'score', width: 10 },
    { header: 'Income', key: 'income', width: 14 },
    { header: 'Location', key: 'location', width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) =>
    ws.addRow({
      date: toDate(r.date),
      mobile: normalizeMobile(r.mobile) || String(r.mobile || ''),
      score: toNumber(r.score),
      income: toNumber(r.income),
      location: r.location || '',
    })
  );
  ws.getColumn('date').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('mobile').numFmt = '@';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="leads-from-image.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// Re-check rows (used by the review screen after the user edits them)
router.post('/import/check', allow('admin', 'manager'), async (req, res) => {
  res.json({ rows: await annotate(req.body.rows || []) });
});

async function annotate(rows) {
  const seen = new Set();
  const normalized = rows.map((r) => ({ ...r, mobileClean: normalizeMobile(r.mobile) }));
  const valid = normalized.map((r) => r.mobileClean).filter(Boolean);
  const existing = new Set((await Lead.find({ mobile: { $in: valid } }).select('mobile')).map((l) => l.mobile));

  return normalized.map((r) => {
    let issue = null;
    if (!r.mobileClean) issue = 'invalid_mobile';
    else if (existing.has(r.mobileClean)) issue = 'already_in_crm';
    else if (seen.has(r.mobileClean)) issue = 'duplicate_in_file';
    if (r.mobileClean) seen.add(r.mobileClean);
    return { ...r, issue };
  });
}

// Step 2: save the reviewed rows. Only clean rows are inserted.
router.post('/import/commit', allow('admin', 'manager'), async (req, res) => {
  const checked = await annotate(req.body.rows || []);
  const good = checked.filter((r) => !r.issue);

  const docs = good.map((r) => ({
    date: toDate(r.date) || new Date(),
    mobile: r.mobileClean,
    score: toNumber(r.score),
    income: toNumber(r.income),
    location: r.location || '',
    createdBy: req.user._id,
  }));

  if (docs.length) await Lead.insertMany(docs, { ordered: false });
  res.json({ inserted: docs.length, skipped: checked.length - docs.length });
});

// Create / read / update / delete
router.post('/', allow('admin', 'manager'), async (req, res) => {
  const mobile = normalizeMobile(req.body.mobile);
  if (!mobile) return res.status(400).json({ message: 'Enter a valid 10-digit mobile number' });
  try {
    const lead = await Lead.create({
      date: toDate(req.body.date) || new Date(),
      mobile,
      score: toNumber(req.body.score),
      income: toNumber(req.body.income),
      location: req.body.location,
      assignedTo: req.body.assignedTo || null,
      createdBy: req.user._id,
    });
    res.status(201).json(lead);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'This mobile number already exists' });
    res.status(400).json({ message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const lead = await Lead.findById(req.params.id).populate('assignedTo', 'name');
  if (!lead) return res.status(404).json({ message: 'Lead not found' });
  if (req.user.role === 'caller' && String(lead.assignedTo?._id) !== String(req.user._id)) {
    return res.status(403).json({ message: 'This lead is not assigned to you' });
  }
  res.json(lead);
});

router.put('/:id', async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const isCaller = req.user.role === 'caller';
  if (isCaller && String(lead.assignedTo) !== String(req.user._id)) {
    return res.status(403).json({ message: 'This lead is not assigned to you' });
  }

  // Callers can only update call outcome fields.
  const b = req.body;
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return res.status(400).json({ message: 'Invalid status' });
    lead.status = b.status;
  }
  if (b.remarks !== undefined) lead.remarks = b.remarks;
  if (b.followUpDate !== undefined) lead.followUpDate = toDate(b.followUpDate);

  if (!isCaller) {
    if (b.mobile !== undefined) {
      const m = normalizeMobile(b.mobile);
      if (!m) return res.status(400).json({ message: 'Enter a valid 10-digit mobile number' });
      lead.mobile = m;
    }
    if (b.score !== undefined) lead.score = toNumber(b.score);
    if (b.income !== undefined) lead.income = toNumber(b.income);
    if (b.location !== undefined) lead.location = b.location;
    if (b.date !== undefined) lead.date = toDate(b.date) || lead.date;
    if (b.assignedTo !== undefined) lead.assignedTo = b.assignedTo || null;
  }

  try {
    await lead.save();
    res.json(lead);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'This mobile number already exists' });
    res.status(400).json({ message: err.message });
  }
});

router.delete('/:id', allow('admin'), async (req, res) => {
  await Lead.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;