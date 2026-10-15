import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const pad = (n) => String(n).padStart(2, '0');

// Dates are shown as DD-MM-YYYY (the format the vendor sheet uses), not the browser's US format.
const showDate = (d) => {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(d.trim())) return d;
  const x = new Date(d);
  if (isNaN(x)) return String(d);
  return `${pad(x.getUTCDate())}-${pad(x.getUTCMonth() + 1)}-${x.getUTCFullYear()}`;
};

// Turn what the user typed back into a plain row before sending it to the server.
const clean = (rows) => rows.map(({ dateText, ...r }) => ({ ...r, date: dateText !== undefined ? dateText : r.date }));

const WARNING_NOTE = [
  ['date differs', 'Date is different from the other rows. Check it against the photo.'],
  ['location not recognised', 'Location looks unusual. Check it against the photo.'],
];

const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';

// Everything the user should know about one row, in plain words.
function notesFor(r) {
  const notes = [];

  if (r.issue === 'already_in_crm') return { level: 'skip', notes: ['Already in the CRM, so this row will be skipped.'] };
  if (r.issue === 'duplicate_in_file') {
    return { level: 'skip', notes: ['This number appears twice (in this image or another one), so this row will be skipped.'] };
  }
  if (r.issue === 'invalid_mobile') {
    notes.push(
      has(r.mobile)
        ? 'Mobile is not a valid 10-digit number. Fix it from the photo, or remove the row.'
        : 'Mobile number could not be read. Type it from the photo, or remove the row.'
    );
  }

  (r.warning || '').split(', ').filter(Boolean).forEach((w) => {
    const hit = WARNING_NOTE.find(([key]) => w.startsWith(key));
    if (hit) notes.push(hit[1]);
  });

  const missing = [];
  if (!has(r.date) && !has(r.dateText)) missing.push('Date');
  if (!has(r.score)) missing.push('Score');
  if (!has(r.income)) missing.push('Income');
  if (!has(r.location)) missing.push('Location');
  if (missing.length) notes.push(`Could not read: ${missing.join(', ')}. Type from the photo.`);

  if (r.issue) return { level: 'fix', notes };
  return { level: notes.length ? 'check' : 'ok', notes };
}

const MAX_FILES = 20;
const isAllowed = (f) => /^image\/(jpeg|png|webp)$/.test(f.type) || /\.(xlsx|csv)$/i.test(f.name);
const shortName = (n) => (n.length > 26 ? `${n.slice(0, 23)}…` : n);

export default function Import() {
  // One "batch" per file or image: { id, name, status, rows, photo, error }.
  // The ref always holds the latest list, so the background reading loop never works from stale data.
  const store = useRef([]);
  const idRef = useRef(0);
  const pasteCount = useRef(0);
  const [batches, setBatches] = useState([]);
  const [active, setActive] = useState(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState('combined'); // combined | sheets | files
  const [sourceColumn, setSourceColumn] = useState(false);

  const update = (fn) => {
    store.current = fn(store.current);
    setBatches(store.current);
  };
  const patch = (id, changes) => update((bs) => bs.map((b) => (b.id === id ? { ...b, ...changes } : b)));

  // Check every image together, so a number that appears in two images is noticed.
  const recheckAll = async () => {
    const done = store.current.filter((b) => b.status === 'done' && b.rows && b.rows.length);
    if (!done.length) return;
    const flat = [];
    done.forEach((b) => clean(b.rows).forEach((r) => flat.push({ ...r, _b: b.id })));
    const { rows } = await api.importCheck(flat);
    const by = {};
    rows.forEach(({ _b, ...r }) => {
      (by[_b] = by[_b] || []).push(r);
    });
    update((bs) => bs.map((b) => (by[b.id] ? { ...b, rows: by[b.id] } : b)));
  };

  // Files are read one after another (each photo takes about 30 seconds).
  const processItems = async (items) => {
    for (const it of items) {
      if (!store.current.some((b) => b.id === it.id)) continue; // removed while waiting
      patch(it.id, { status: 'reading' });
      try {
        const isImage = /^image\//.test(it.file.type);
        const res = isImage ? await api.importImage(it.file) : await api.importPreview(it.file);
        patch(it.id, { status: 'done', rows: res.rows, photo: res.previewImage || null, file: null });
      } catch (err) {
        patch(it.id, { status: 'error', error: err.message, file: null });
      }
    }
    try {
      await recheckAll();
    } catch (err) {
      setError(err.message);
    }
  };

  // One entry point for every way files arrive: Choose files, drag-and-drop, or Ctrl+V paste.
  const addFiles = (fileList, label) => {
    if (busy) return;
    const files = [...fileList];
    if (!files.length) return;

    const good = files.filter(isAllowed);
    let msg = good.length < files.length ? 'Some files were skipped. Use Excel (.xlsx), CSV, or JPG / PNG images.' : '';
    const room = Math.max(0, MAX_FILES - store.current.length);
    if (good.length > room) msg = `You can add up to ${MAX_FILES} files at a time. ${good.length - room} file(s) were not added.`;
    const take = good.slice(0, room);
    setError(msg);
    setResult(null);
    if (!take.length) return;

    const items = take.map((file) => ({
      id: ++idRef.current,
      file,
      name: label ? `${label} ${++pasteCount.current}` : file.name,
      status: 'queued',
      rows: null,
      photo: null,
      error: '',
    }));
    update((bs) => [...bs, ...items]);
    setActive((a) => (a === null ? items[0].id : a));
    processItems(items);
  };

  const onFiles = (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    addFiles(files);
  };

  // Ctrl+V anywhere on this screen: pasting a screenshot adds it straight away.
  const pasteHandler = useRef();
  pasteHandler.current = addFiles;
  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      const file = item && item.getAsFile();
      if (!file) return; // normal text pastes (e.g. into a cell) are left alone
      e.preventDefault();
      pasteHandler.current([file], 'Pasted image');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const removeBatch = (id) => {
    update((bs) => bs.filter((b) => b.id !== id));
    setActive((a) => (a === id ? null : a));
  };
  const clearAll = () => {
    update(() => []);
    setActive(null);
    setError('');
    setResult(null);
  };

  const doneBatches = batches.filter((b) => b.status === 'done');
  const pending = batches.filter((b) => b.status === 'queued' || b.status === 'reading').length;
  const cur = batches.find((b) => b.id === active) || doneBatches[0] || batches[0];

  const editRow = (i, key, value) =>
    update((bs) => bs.map((b) => (b.id === cur.id ? { ...b, rows: b.rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)) } : b)));
  const removeRow = (i) =>
    update((bs) => bs.map((b) => (b.id === cur.id ? { ...b, rows: b.rows.filter((_, idx) => idx !== i) } : b)));

  const run = async (job) => {
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const recheck = () => run(recheckAll);

  const downloadExcel = () =>
    run(async () => {
      const many = doneBatches.length > 1;
      const useMode = many ? mode : 'combined';
      const blob = await api.importXlsx({
        mode: useMode,
        sourceColumn,
        batches: doneBatches.map((b) => ({ name: b.name, rows: clean(b.rows) })),
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = useMode === 'files' ? 'leads-by-image.zip' : many ? 'leads-from-images.xlsx' : 'leads-from-image.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    });

  const commit = () =>
    run(async () => {
      const res = await api.importCommit(doneBatches.flatMap((b) => clean(b.rows)));
      setResult(res);
      update(() => []);
      setActive(null);
    });

  const allInfo = doneBatches.flatMap((b) => b.rows.map(notesFor));
  const count = (level) => allInfo.filter((x) => x.level === level).length;
  const ready = doneBatches.reduce((n, b) => n + b.rows.filter((r) => !r.issue).length, 0);
  const totalRows = doneBatches.reduce((n, b) => n + b.rows.length, 0);

  const curInfo = cur && cur.status === 'done' ? cur.rows.map(notesFor) : [];
  const visible = curInfo.map((x, i) => ({ r: cur.rows[i], i, ...x })).filter((x) => !onlyReview || x.level !== 'ok');
  const photo = cur && cur.photo;

  return (
    <div className="import">
      <h2>Import leads</h2>
      <p className="muted lead-text">
        Add one or many files: Excel, CSV, or photos / screenshots of the vendor's sheet. You can select several at once,
        drag them here, or paste a screenshot with Ctrl+V. Photos are read on this computer (no internet needed) and take about
        30 seconds each. Nothing is saved until you check the rows and click Save.
      </p>

      <div
        className={`card upload ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      >
        <label className={`btn primary filebtn ${busy ? 'disabled' : ''}`}>
          Choose files
          <input type="file" hidden multiple accept=".xlsx,.csv,.jpg,.jpeg,.png" onChange={onFiles} disabled={busy} />
        </label>
        <span className="muted">
          {batches.length
            ? `${batches.length} file${batches.length > 1 ? 's' : ''} added. You can add more at any time.`
            : 'Select several files, or drag them here, or press Ctrl+V to paste a screenshot'}
        </span>
        <span className="spacer" />
        {batches.length > 0 && <button className="btn small" onClick={clearAll} disabled={busy}>Clear all</button>}
      </div>

      {pending > 0 && (
        <div className="success">
          Reading… {batches.length - pending} of {batches.length} finished. Each photo takes about 30 seconds. If others are
          uploading too, you are next in line.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="success">
          Saved {result.inserted} lead(s).{result.skipped > 0 && ` Skipped ${result.skipped} row(s) with problems.`}
        </div>
      )}

      {batches.length > 1 && (
        <div className="tabs">
          {batches.map((b, n) => {
            const toReview = b.status === 'done' ? b.rows.map(notesFor).filter((x) => x.level !== 'ok').length : 0;
            return (
              <div key={b.id} className={`tab ${cur && cur.id === b.id ? 'active' : ''} st-${b.status}`}>
                <button className="tab-main" onClick={() => setActive(b.id)} title={b.name}>
                  <span className="tab-no">{n + 1}</span>
                  <span>{shortName(b.name)}</span>
                  {b.status === 'queued' && <span className="badge wait">waiting</span>}
                  {b.status === 'reading' && <span className="badge wait">reading…</span>}
                  {b.status === 'error' && <span className="badge bad">failed</span>}
                  {b.status === 'done' && (
                    <span className={`badge ${toReview ? 'warn' : 'good'}`}>
                      {b.rows.length} rows{toReview ? ` · ${toReview} to review` : ''}
                    </span>
                  )}
                </button>
                <button className="tab-x" title="Remove this image" onClick={() => removeBatch(b.id)}>✕</button>
              </div>
            );
          })}
        </div>
      )}

      {doneBatches.length > 0 && (
        <>
          <div className="summary">
            <div className="chips">
              <span className="chip ok">{count('ok')} ready</span>
              {count('check') > 0 && <span className="chip check">{count('check')} to double-check</span>}
              {count('fix') > 0 && <span className="chip fix">{count('fix')} need fixing</span>}
              {count('skip') > 0 && <span className="chip skip">{count('skip')} will be skipped</span>}
              {doneBatches.length > 1 && <span className="muted chip-note">in {doneBatches.length} images, {totalRows} rows</span>}
            </div>
            <span className="spacer" />
            <button className="btn ghost" onClick={recheck} disabled={busy || pending > 0}>Re-check rows</button>
            <button className="btn ghost" onClick={downloadExcel} disabled={busy || pending > 0 || !totalRows}>
              {doneBatches.length > 1 && mode === 'files' ? 'Download ZIP' : 'Download Excel'}
            </button>
            <button className="btn primary" onClick={commit} disabled={busy || pending > 0 || !ready}>Save {ready} lead(s) to CRM</button>
          </div>

          {doneBatches.length > 1 && (
            <div className="card layoutbox">
              <strong>How should the Excel file be made?</strong>
              <label className="opt">
                <input type="radio" name="mode" checked={mode === 'combined'} onChange={() => setMode('combined')} />
                <span><b>One sheet</b> with all images together<small> (a number that is in two images is listed once)</small></span>
              </label>
              <label className="opt">
                <input type="radio" name="mode" checked={mode === 'sheets'} onChange={() => setMode('sheets')} />
                <span><b>One Excel file</b>, with a separate sheet for each image</span>
              </label>
              <label className="opt">
                <input type="radio" name="mode" checked={mode === 'files'} onChange={() => setMode('files')} />
                <span><b>A separate Excel file</b> for each image<small> (downloaded together as one ZIP)</small></span>
              </label>
              {mode === 'combined' && (
                <label className="opt sub">
                  <input type="checkbox" checked={sourceColumn} onChange={(e) => setSourceColumn(e.target.checked)} />
                  <span>Add a "Source image" column so you can see which image each row came from</span>
                </label>
              )}
            </div>
          )}
        </>
      )}

      {cur && cur.status === 'error' && (
        <div className="card">
          <div className="n-fix">Could not read “{cur.name}”: {cur.error}</div>
          <button className="btn small" style={{ marginTop: 10 }} onClick={() => removeBatch(cur.id)}>Remove it</button>
        </div>
      )}
      {cur && (cur.status === 'queued' || cur.status === 'reading') && (
        <div className="card muted">“{cur.name}” is {cur.status === 'queued' ? 'waiting for its turn' : 'being read'}…</div>
      )}

      {cur && cur.status === 'done' && (
        <>
          {photo && (
            <p className="muted hint">
              Compare each row with the photo. The reader can misread digits, so check mobile numbers and income.
              Rows marked yellow or red need your eye.
            </p>
          )}
          <div className="summary compact">
            <strong>{doneBatches.length > 1 ? cur.name : 'Rows'}</strong>
            <span className="spacer" />
            <label className="toggle">
              <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
              Show only rows to review
            </label>
          </div>

          <div className={photo ? 'review withphoto' : 'review'}>
            {photo && (
              <div className="card photo">
                <img src={photo} alt="Uploaded sheet" onClick={() => setZoom(true)} />
                <button className="btn small" onClick={() => setZoom(true)}>Enlarge photo</button>
              </div>
            )}

            <div className="card tablewrap">
              <table className="review-table">
                <colgroup>
                  <col style={{ width: 38 }} />
                  <col style={{ width: 132 }} />
                  <col style={{ width: 128 }} />
                  <col style={{ width: 68 }} />
                  <col style={{ width: 92 }} />
                  <col style={{ width: 150 }} />
                  <col />
                  <col style={{ width: 44 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>#</th><th>Date</th><th>Mobile</th><th>Score</th><th>Income</th><th>Location</th><th>Note</th><th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ r, i, level, notes }) => (
                    <tr key={i} className={`row-${level}`}>
                      <td className="num">{i + 1}</td>
                      <td><input className="cell" placeholder="DD-MM-YYYY" value={r.dateText !== undefined ? r.dateText : showDate(r.date)} onChange={(e) => editRow(i, 'dateText', e.target.value)} /></td>
                      <td><input className="cell" inputMode="numeric" value={r.mobile || ''} onChange={(e) => editRow(i, 'mobile', e.target.value)} /></td>
                      <td><input className="cell" inputMode="numeric" value={r.score ?? ''} onChange={(e) => editRow(i, 'score', e.target.value)} /></td>
                      <td><input className="cell" inputMode="numeric" value={r.income ?? ''} onChange={(e) => editRow(i, 'income', e.target.value)} /></td>
                      <td><input className="cell" value={r.location || ''} onChange={(e) => editRow(i, 'location', e.target.value)} /></td>
                      <td className="note">
                        {level === 'ok' ? <span className="okmark">✓ OK</span> : notes.map((n, k) => <div key={k} className={`n-${level}`}>{n}</div>)}
                      </td>
                      <td><button className="x" title="Remove this row" onClick={() => removeRow(i)}>✕</button></td>
                    </tr>
                  ))}
                  {!visible.length && (
                    <tr><td colSpan="8" className="muted center-text">No rows to show</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {zoom && photo && (
        <div className="modal" onClick={() => setZoom(false)}>
          <div className="zoombox" onClick={(e) => e.stopPropagation()}>
            <button className="btn small zoomclose" onClick={() => setZoom(false)}>Close</button>
            <img src={photo} alt="Uploaded sheet, large" />
          </div>
        </div>
      )}
    </div>
  );
}