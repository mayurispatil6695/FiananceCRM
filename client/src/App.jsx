import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Leads from './pages/Leads.jsx';
import Import from './pages/Import.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!getToken()) return setReady(true);
    api
      .me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const logout = () => {
    setToken(null);
    setUser(null);
    navigate('/login');
  };

  if (!ready) return <div className="center">Loading…</div>;

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={setUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const canImport = user.role === 'admin' || user.role === 'manager';

  return (
    <div className="shell">
      <header className="topbar">
        <strong>Finance CRM</strong>
        <nav>
          <NavLink to="/leads">Leads</NavLink>
          {canImport && <NavLink to="/import">Import</NavLink>}
        </nav>
        <span className="spacer" />
        <span className="muted">
          {user.name} ({user.role})
        </span>
        <button className="btn ghost" onClick={logout}>
          Log out
        </button>
      </header>
      <main className="content">
        <Routes>
          <Route path="/leads" element={<Leads user={user} />} />
          {canImport && <Route path="/import" element={<Import />} />}
          <Route path="*" element={<Navigate to="/leads" replace />} />
        </Routes>
      </main>
    </div>
  );
}
