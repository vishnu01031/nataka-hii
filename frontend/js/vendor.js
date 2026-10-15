// Vendor portal: product CRUD with images, order fulfilment, sales report
requireRole('vendor');
renderTopbar('vendor.html');

// ---------------- Tabs ----------------
const tabs = document.querySelectorAll('.tab');
function showTab(name) {
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  ['products', 'orders', 'sales'].forEach(n => document.getElementById(`tab-${n}`).classList.toggle('hidden', n !== name));
  if (name === 'orders') loadOrders();
  if (name === 'sales') loadSales();
}
tabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------------- Products ----------------
const grid = document.getElementById('productGrid');
const searchInput = document.getElementById('searchInput');
let searchTimer;
let products = [];

async function loadCategories() {
  const cats = await api('/categories');
  document.getElementById('fieldCategory').innerHTML =
    cats.map(c => `<option value="${c.category_id}">${escapeHtml(c.name)}</option>`).join('');
}

async function loadProducts() {
  try {
    const q = searchInput.value.trim();
    products = await api(`/vendor/products${q ? `?search=${encodeURIComponent(q)}` : ''}`);
    const empty = document.getElementById('emptyState');
    empty.classList.toggle('hidden', products.length > 0);
    grid.classList.toggle('hidden', products.length === 0);
    document.getElementById('emptyTitle').textContent = q ? `No products match "${q}".` : 'No products yet.';
    document.getElementById('emptySub').textContent = q ? 'Try a different search.' : 'Add your first product to start selling.';
    grid.innerHTML = products.map(p => `
      <div class="product-card" data-id="${p.product_id}">
        <div class="product-thumb">${thumb(p.image_url, p.name)}</div>
        <div class="product-body">
          <span class="category-tag">${escapeHtml(p.category_name)}</span>
          <div class="prod-name">${escapeHtml(p.name)}</div>
          <div class="prod-desc">${escapeHtml(p.description || '')}</div>
          <div class="price-row">
            <span class="price">${money(p.price)}</span>
            <span class="stock ${p.stock_quantity <= 5 ? 'low' : ''}">${p.stock_quantity} in stock</span>
          </div>
          <div class="small muted">${p.image_count} photo${p.image_count === 1 ? '' : 's'}</div>
          <div class="card-actions">
            <button class="link-btn" type="button" data-action="edit">Edit</button>
            <button class="link-btn danger" type="button" data-action="delete">Delete</button>
          </div>
        </div>
      </div>`).join('');
  } catch (err) { toast(err.message, true); }
}

searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadProducts, 300); });

// Event delegation with data-attributes (safe for any product name)
let pendingDelete = null;
grid.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = Number(btn.closest('.product-card').dataset.id);
  if (btn.dataset.action === 'edit') openEdit(id);
  if (btn.dataset.action === 'delete') {
    pendingDelete = id;
    document.getElementById('deleteProductName').textContent = products.find(p => p.product_id === id)?.name || '';
    openModal('deleteModal');
  }
});

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  try {
    const r = await api(`/vendor/products/${pendingDelete}`, { method: 'DELETE' });
    closeModal('deleteModal');
    toast(r.message);
    loadProducts();
  } catch (err) { toast(err.message, true); }
});

// Add / edit modal
const form = document.getElementById('productForm');
const fImages = document.getElementById('fieldImages');
const preview = document.getElementById('imagePreview');
const hint = document.getElementById('imageHint');

function showPreviews(urls) {
  preview.innerHTML = urls.length
    ? urls.map(u => `<div class="image-preview"><img src="${escapeHtml(u)}" alt=""></div>`).join('')
    : '<div class="image-preview"><span class="placeholder">No photo</span></div>';
}

function hideFormError() { document.getElementById('formError').classList.add('hidden'); }
function showFormError(msg) { const el = document.getElementById('formError'); el.textContent = msg; el.classList.remove('hidden'); }

document.getElementById('openAddBtn').addEventListener('click', () => {
  form.reset();
  document.getElementById('productId').value = '';
  document.getElementById('modalTitle').textContent = 'Add product';
  showPreviews([]);
  hint.textContent = '';
  hideFormError();
  openModal('productModal');
});

async function openEdit(id) {
  try {
    const p = await api(`/vendor/products/${id}`);
    form.reset();
    document.getElementById('modalTitle').textContent = 'Edit product';
    document.getElementById('productId').value = p.product_id;
    document.getElementById('fieldName').value = p.name;
    document.getElementById('fieldCategory').value = p.category_id;
    document.getElementById('fieldPrice').value = p.price;
    document.getElementById('fieldStock').value = p.stock_quantity;
    document.getElementById('fieldDescription').value = p.description || '';
    showPreviews(p.images.map(i => i.image_url));
    hint.textContent = p.images.length ? 'Choosing new photos replaces the current ones.' : '';
    hideFormError();
    openModal('productModal');
  } catch (err) { toast(err.message, true); }
}

fImages.addEventListener('change', () => {
  const files = [...fImages.files].slice(0, 5);
  if (fImages.files.length > 5) hint.textContent = 'Only the first 5 photos will be uploaded.';
  showPreviews(files.map(f => URL.createObjectURL(f)));
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  hideFormError();
  const id = document.getElementById('productId').value;
  const fd = new FormData();
  fd.append('name', document.getElementById('fieldName').value.trim());
  fd.append('category_id', document.getElementById('fieldCategory').value);
  fd.append('price', document.getElementById('fieldPrice').value);
  fd.append('stock_quantity', document.getElementById('fieldStock').value);
  fd.append('description', document.getElementById('fieldDescription').value.trim());
  [...fImages.files].slice(0, 5).forEach(f => fd.append('images', f));

  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await api(id ? `/vendor/products/${id}` : '/vendor/products', { method: id ? 'PUT' : 'POST', form: fd });
    closeModal('productModal');
    toast(r.message);
    loadProducts();
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save product';
  }
});

// ---------------- Orders ----------------
const orderList = document.getElementById('orderList');

async function loadOrders() {
  try {
    const orders = await api('/vendor/orders');
    const toShip = orders.filter(o => o.status === 'pending').length;
    const countEl = document.getElementById('toShipCount');
    countEl.textContent = toShip;
    countEl.classList.toggle('hidden', !toShip);
    if (document.getElementById('tab-orders').classList.contains('hidden')) return;

    orderList.innerHTML = orders.length ? orders.map(o => `
      <article class="order-card" data-order="${o.order_id}">
        <div class="order-head">
          <div><div class="id">Order #${o.order_id}</div>
            <div class="meta">${dateStr(o.order_date)} · ${escapeHtml(o.customer_name)}</div></div>
          ${badge(o.status === 'pending' ? 'to ship' : o.status, o.status)}
        </div>
        <div class="order-body">
          ${o.items.map(i => `
            <div class="order-line">
              <div>${escapeHtml(i.product_name)} <span class="muted">× ${i.quantity} @ ${money(i.unit_price)}</span></div>
              <div class="status-cell">${badge(i.item_status)}</div>
              <div class="num">${money(i.subtotal)}</div>
            </div>`).join('')}
        </div>
        <div class="order-foot">
          <div class="address-block">${escapeHtml(o.address)}
            ${o.shipment ? `<br>${escapeHtml(o.shipment.courier_name)} · ${escapeHtml(o.shipment.tracking_number)}` : ''}</div>
          <div style="display:flex;gap:10px;align-items:center">
            <strong>${money(o.vendor_total)}</strong>
            ${o.status === 'pending' ? '<button class="btn-primary btn-sm" type="button" data-ship>Ship</button>' : ''}
            ${o.status === 'shipped' ? '<button class="btn-ghost btn-sm" type="button" data-deliver>Mark delivered</button>' : ''}
          </div>
        </div>
      </article>`).join('')
      : '<div class="empty-state"><p>No orders yet.</p><p class="empty-sub">Orders for your products will show up here.</p></div>';
  } catch (err) { toast(err.message, true); }
}

let shipOrderId = null;
orderList.addEventListener('click', async e => {
  const card = e.target.closest('[data-order]');
  if (!card) return;
  const id = Number(card.dataset.order);
  if (e.target.hasAttribute('data-ship')) {
    shipOrderId = id;
    document.getElementById('shipOrderId').textContent = `#${id}`;
    document.getElementById('shipForm').reset();
    openModal('shipModal');
  }
  if (e.target.hasAttribute('data-deliver')) {
    try {
      const r = await api(`/vendor/orders/${id}/deliver`, { method: 'POST' });
      toast(r.message);
      loadOrders();
    } catch (err) { toast(err.message, true); }
  }
});

document.getElementById('shipForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const r = await api(`/vendor/orders/${shipOrderId}/ship`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    closeModal('shipModal');
    toast(r.message);
    loadOrders();
  } catch (err) { toast(err.message, true); }
});

// ---------------- Sales ----------------
async function loadSales() {
  try {
    const s = await api('/vendor/stats');
    document.getElementById('salesStats').innerHTML = `
      <div class="stat accent"><div class="label">Revenue</div><div class="value">${money(s.summary.revenue)}</div></div>
      <div class="stat"><div class="label">Orders</div><div class="value">${s.summary.total_orders}</div></div>
      <div class="stat"><div class="label">Units sold</div><div class="value">${s.summary.units_sold}</div></div>
      <div class="stat"><div class="label">Items to ship</div><div class="value">${s.summary.items_to_ship}</div></div>`;
    const max = Math.max(1, ...s.top_products.map(p => Number(p.revenue)));
    document.getElementById('topProducts').innerHTML = s.top_products.length
      ? s.top_products.map(p => `
          <div class="bar-row"><span>${escapeHtml(p.name)}</span>
            <span class="bar"><span style="width:${(Number(p.revenue) / max) * 100}%"></span></span>
            <span class="amt">${money(p.revenue)}</span></div>`).join('')
      : '<p class="muted small">No sales yet.</p>';
    document.getElementById('lowStock').innerHTML = s.low_stock.length
      ? s.low_stock.map(p => `<div class="total-row" style="font-size:14px;margin-bottom:8px"><span>${escapeHtml(p.name)}</span>
          <span class="stock low">${p.stock_quantity} left</span></div>`).join('')
      : '<p class="muted small">Every product has more than 5 in stock.</p>';
  } catch (err) { toast(err.message, true); }
}

// ---------------- Init ----------------
loadCategories().catch(err => toast(err.message, true));
loadProducts();
loadOrders(); // fills the "to ship" counter
