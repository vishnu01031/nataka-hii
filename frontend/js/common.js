// Shared helpers for every page. The API is served from the same origin, so no hard-coded URLs.
const API = '/api';

const Session = {
  get token() { return localStorage.getItem('nh_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('nh_user')); } catch { return null; } },
  save(token, user) { localStorage.setItem('nh_token', token); localStorage.setItem('nh_user', JSON.stringify(user)); },
  clear() { localStorage.removeItem('nh_token'); localStorage.removeItem('nh_user'); }
};

const HOME_FOR_ROLE = { customer: 'index.html', vendor: 'vendor.html', admin: 'admin.html' };

// fetch wrapper: adds the token, sends JSON or FormData, throws Error(message) on failure
async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (Session.token) headers.Authorization = `Bearer ${Session.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  const res = await fetch(API + path, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }

  if (res.status === 401 && Session.token) {
    Session.clear();
    location.href = 'login.html?expired=1';
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateStr = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const slug = s => String(s || '').toLowerCase().replace(/\s+/g, '-');
const badge = (text, kind) => `<span class="badge ${escapeHtml(kind || slug(text))}">${escapeHtml(text)}</span>`;

function stars(rating) {
  const r = Math.round(Number(rating) || 0);
  return `<span class="stars" aria-label="${r} out of 5">${'★'.repeat(r)}<span class="muted">${'★'.repeat(5 - r)}</span></span>`;
}

function thumb(url, alt = '') {
  return url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">` : '<span class="placeholder">No image</span>';
}

let toastTimer;
function toast(message, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

// Redirects away if the user isn't logged in with one of the allowed roles
function requireRole(...roles) {
  const u = Session.user;
  if (!Session.token || !u) { location.href = 'login.html'; return null; }
  if (!roles.includes(u.role)) { location.href = HOME_FOR_ROLE[u.role] || 'login.html'; return null; }
  return u;
}

function logout() { Session.clear(); location.href = 'login.html'; }

// Top bar shared by every signed-in page
function renderTopbar(active, { cart = false } = {}) {
  const u = Session.user;
  const links = {
    customer: [['index.html', 'Shop'], ['orders.html', 'My orders']],
    vendor: [['vendor.html', 'Vendor portal'], ['index.html', 'View store']],
    admin: [['admin.html', 'Admin'], ['index.html', 'View store']]
  }[u?.role] || [['index.html', 'Shop']];

  const sub = { vendor: 'Vendor portal', admin: 'Admin console', customer: 'Marketplace' }[u?.role] || 'Marketplace';
  const who = u ? (u.role === 'vendor' ? `Selling as <strong>${escapeHtml(u.businessName)}</strong>` : `Hi, <strong>${escapeHtml(u.name.split(' ')[0])}</strong>`) : '';

  document.getElementById('topbar').innerHTML = `
    <div class="brand">
      <div>
        <a class="logo" href="${u ? HOME_FOR_ROLE[u.role] : 'index.html'}"><span class="navy">Nataka</span> <span class="orange">Hii</span></a>
        <div class="brand-sub">${sub}</div>
      </div>
    </div>
    <nav class="topnav">${links.map(([href, label]) =>
      `<a href="${href}" class="${href === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
    <div class="topbar-right">
      <span class="status-pill" id="statusPill">checking…</span>
      ${u ? `<span class="vendor-chip">${who}</span>` : ''}
      ${cart ? '<button class="btn-cart" id="cartBtn" type="button">Cart<span class="cart-count" id="cartCount">0</span></button>' : ''}
      ${u ? '<button class="btn-logout" id="logoutBtn" type="button">Log out</button>'
          : '<a class="btn-primary" href="login.html">Log in</a>'}
    </div>`;
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
  checkHealth();
}

// Status pill shows whether the API + Azure SQL are reachable
async function checkHealth() {
  const pill = document.getElementById('statusPill');
  if (!pill) return;
  try {
    const h = await fetch(API + '/health').then(r => r.json());
    const ok = h.database === 'connected';
    pill.className = `status-pill ${ok ? 'ok' : 'err'}`;
    pill.textContent = ok ? 'database connected' : 'database unreachable';
    pill.title = `Image storage: ${h.storage}`;
  } catch {
    pill.className = 'status-pill err';
    pill.textContent = 'server unreachable';
  }
}

// Simple modal helpers: <div class="modal-backdrop hidden" id="...">
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop:not(.hidden), .drawer-backdrop:not(.hidden)')
    .forEach(m => m.classList.add('hidden'));
});
document.addEventListener('click', e => {
  if (e.target.classList?.contains('modal-backdrop') || e.target.classList?.contains('drawer-backdrop')) e.target.classList.add('hidden');
  const closer = e.target.closest?.('[data-close]');
  if (closer) document.getElementById(closer.dataset.close).classList.add('hidden');
});
