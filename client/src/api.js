const TOKEN_KEY = 'crm_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

async function request(path, { method = 'GET', body, form, raw } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });

  if (res.status === 401 && path !== '/auth/login') {
    setToken(null);
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (raw) {
    if (!res.ok) throw new Error('Download failed');
    return res.blob();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}

export const api = {
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),
  me: () => request('/auth/me'),
  users: () => request('/auth/users'),
  leads: (params) => request(`/leads?${new URLSearchParams(params)}`),
  meta: () => request('/leads/meta'),
  createLead: (body) => request('/leads', { method: 'POST', body }),
  updateLead: (id, body) => request(`/leads/${id}`, { method: 'PUT', body }),
  deleteLead: (id) => request(`/leads/${id}`, { method: 'DELETE' }),
  exportLeads: (params) => request(`/leads/export?${new URLSearchParams(params)}`, { raw: true }),
  importPreview: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/leads/import/preview', { method: 'POST', form });
  },
  importImage: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/leads/import/image', { method: 'POST', form });
  },
  importXlsx: (rows) => request('/leads/import/xlsx', { method: 'POST', body: { rows }, raw: true }),
  importCheck: (rows) => request('/leads/import/check', { method: 'POST', body: { rows } }),
  importCommit: (rows) => request('/leads/import/commit', { method: 'POST', body: { rows } }),
};
