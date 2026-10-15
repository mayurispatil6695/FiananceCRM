import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const STATUS_LABEL = {
  new: 'New',
  interested: 'Interested',
  callback: 'Callback',
  not_interested: 'Not interested',
  not_reachable: 'Not reachable',
  converted: 'Converted',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');
const inputDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export default function Leads({ user }) {
  const isCaller = user.role === 'caller';
  const isAdmin = user.role === 'admin';

  const [filters, setFilters] = useState({
    q: '', status: '', location: '', minScore: '', maxScore: '', from: '', to: '', followUp: '',
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pages: 1 });
  const [users, setUsers] = useState([]);
  const [editing, setEditing] = useState(null); // lead object, or {} for new
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: 25 };
      Object.entries(filters).forEach(([k, v]) => v && (params[k] = v));
      setData(await api.leads(params));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    const t = setTimeout(load, 250); // small delay while typing in the search box
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!isCaller) api.users().then(setUsers).catch(() => {});
  }, [isCaller]);

  const setFilter = (k, v) => {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: v }));
  };

  const download = async () => {
    try {
      const params = {};
      Object.entries(filters).forEach(([k, v]) => v && (params[k] = v));
      const blob = await api.exportLeads(params);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'leads.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (lead) => {
    if (!window.confirm(`Delete lead ${lead.mobile}?`)) return;
    await api.deleteLead(lead._id);
    load();
  };

  return (
    <div>
      <div className="row">
        <h2>Leads <span className="muted">({data.total})</span></h2>
        <span className="spacer" />
        <button
          className={`btn ${filters.followUp ? 'primary' : 'ghost'}`}
          onClick={() => setFilter('followUp', filters.followUp ? '' : 'today')}
        >
          Today's follow-ups
        </button>
        {!isCaller && <button className="btn ghost" onClick={download}>Export Excel</button>}
        {!isCaller && <button className="btn primary" onClick={() => setEditing({})}>+ Add lead</button>}
      </div>

      <div className="filters card">
        <input placeholder="Search mobile or location" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} />
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input placeholder="Location" value={filters.location} onChange={(e) => setFilter('location', e.target.value)} />
        <input type="number" placeholder="Min score" value={filters.minScore} onChange={(e) => setFilter('minScore', e.target.value)} />
        <input type="number" placeholder="Max score" value={filters.maxScore} onChange={(e) => setFilter('maxScore', e.target.value)} />
        <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} title="From date" />
        <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} title="To date" />
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card tablewrap">
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Mobile</th><th>Score</th><th>Income</th>
              <th>Location</th><th>Status</th><th>Follow-up</th><th>Assigned</th><th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((l) => (
              <tr key={l._id}>
                <td>{fmtDate(l.date)}</td>
                <td>{l.mobile}</td>
                <td>{l.score ?? ''}</td>
                <td>{l.income != null ? l.income.toLocaleString('en-IN') : ''}</td>
                <td>{l.location}</td>
                <td><span className={`tag ${l.status}`}>{STATUS_LABEL[l.status]}</span></td>
                <td>{fmtDate(l.followUpDate)}</td>
                <td>{l.assignedTo?.name || ''}</td>
                <td className="actions">
                  <button className="btn small" onClick={() => setEditing(l)}>{isCaller ? 'Update' : 'Edit'}</button>
                  {isAdmin && <button className="btn small danger" onClick={() => remove(l)}>Delete</button>}
                </td>
              </tr>
            ))}
            {!data.items.length && !loading && (
              <tr><td colSpan="9" className="muted center-text">No leads found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="row pager">
        <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {data.page || page} of {data.pages || 1}</span>
        <button className="btn ghost" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>

      {editing && (
        <LeadForm
          lead={editing}
          isCaller={isCaller}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function LeadForm({ lead, isCaller, users, onClose, onSaved }) {
  const isNew = !lead._id;
  const [form, setForm] = useState({
    date: inputDate(lead.date) || inputDate(new Date()),
    mobile: lead.mobile || '',
    score: lead.score ?? '',
    income: lead.income ?? '',
    location: lead.location || '',
    status: lead.status || 'new',
    remarks: lead.remarks || '',
    followUpDate: inputDate(lead.followUpDate),
    assignedTo: lead.assignedTo?._id || '',
  });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (isNew) await api.createLead(form);
      else await api.updateLead(lead._id, form);
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <form className="card modal-card" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>{isNew ? 'Add lead' : `Lead ${lead.mobile}`}</h3>
        <div className="grid">
          <label>Date<input type="date" value={form.date} onChange={set('date')} disabled={isCaller} /></label>
          <label>Mobile<input value={form.mobile} onChange={set('mobile')} disabled={isCaller} /></label>
          <label>Score<input type="number" value={form.score} onChange={set('score')} disabled={isCaller} /></label>
          <label>Income<input type="number" value={form.income} onChange={set('income')} disabled={isCaller} /></label>
          <label>Location<input value={form.location} onChange={set('location')} disabled={isCaller} /></label>
          <label>Status
            <select value={form.status} onChange={set('status')}>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Follow-up date<input type="date" value={form.followUpDate} onChange={set('followUpDate')} /></label>
          {!isCaller && (
            <label>Assign to
              <select value={form.assignedTo} onChange={set('assignedTo')}>
                <option value="">Unassigned</option>
                {users.filter((u) => u.active).map((u) => <option key={u._id} value={u._id}>{u.name} ({u.role})</option>)}
              </select>
            </label>
          )}
        </div>
        <label>Remarks<textarea rows="3" value={form.remarks} onChange={set('remarks')} /></label>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </div>
  );
}