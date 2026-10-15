// Storefront: browse (public), product detail + reviews, cart, checkout (customers)
const user = Session.user;
const isCustomer = user?.role === 'customer';
renderTopbar('index.html', { cart: isCustomer || !user });

const grid = document.getElementById('productGrid');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
let activeCategory = '';
let searchTimer;

// ---------------- Catalogue ----------------
async function loadCategories() {
  const cats = await api('/categories');
  const chips = document.getElementById('categoryChips');
  const total = cats.reduce((s, c) => s + c.product_count, 0);
  chips.innerHTML = [`<button class="chip active" data-cat="">All<span class="n">${total}</span></button>`]
    .concat(cats.map(c => `<button class="chip" data-cat="${c.category_id}">${escapeHtml(c.name)}<span class="n">${c.product_count}</span></button>`))
    .join('');
  chips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
    activeCategory = chip.dataset.cat;
    loadProducts();
  });
}

async function loadProducts() {
  const params = new URLSearchParams({ sort: sortSelect.value });
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (activeCategory) params.set('category', activeCategory);
  try {
    const products = await api(`/products?${params}`);
    document.getElementById('sellerCount').textContent = new Set(products.map(p => p.vendor_id)).size || '–';
    const empty = document.getElementById('emptyState');
    empty.classList.toggle('hidden', products.length > 0);
    grid.classList.toggle('hidden', products.length === 0);
    grid.innerHTML = products.map(p => `
      <article class="product-card clickable" tabindex="0" data-id="${p.product_id}" aria-label="${escapeHtml(p.name)}">
        <div class="product-thumb">${thumb(p.image_url, p.name)}</div>
        <div class="product-body">
          <span class="category-tag">${escapeHtml(p.category_name)}</span>
          <div class="prod-name">${escapeHtml(p.name)}</div>
          <div class="sold-by">by ${escapeHtml(p.business_name)}</div>
          <div class="rating-row">${p.review_count ? `${stars(p.avg_rating)} ${Number(p.avg_rating).toFixed(1)} (${p.review_count})` : 'No reviews yet'}</div>
          <div class="price-row">
            <span class="price">${money(p.price)}</span>
            <span class="stock ${p.stock_quantity <= 5 ? 'low' : ''}">${p.stock_quantity === 0 ? 'Out of stock' : p.stock_quantity <= 5 ? `Only ${p.stock_quantity} left` : 'In stock'}</span>
          </div>
        </div>
      </article>`).join('');
  } catch (err) {
    toast(err.message, true);
  }
}

grid.addEventListener('click', e => { const c = e.target.closest('.product-card'); if (c) openProduct(c.dataset.id); });
grid.addEventListener('keydown', e => { if (e.key === 'Enter') { const c = e.target.closest('.product-card'); if (c) openProduct(c.dataset.id); } });
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadProducts, 300); });
sortSelect.addEventListener('change', loadProducts);

// ---------------- Product detail ----------------
async function openProduct(id) {
  try {
    const p = await api(`/products/${id}`);
    const images = p.images.length ? p.images : [{ image_url: null }];
    const max = p.stock_quantity;
    document.getElementById('productDetail').innerHTML = `
      <div class="pd">
        <div class="pd-gallery">
          <div class="main" id="pdMain">${thumb(images[0].image_url, p.name)}</div>
          ${images.length > 1 ? `<div class="pd-thumbs">${images.map((im, i) =>
            `<button type="button" class="${i === 0 ? 'active' : ''}" data-src="${escapeHtml(im.image_url)}" aria-label="Image ${i + 1}">${thumb(im.image_url)}</button>`).join('')}</div>` : ''}
        </div>
        <div>
          <span class="category-tag">${escapeHtml(p.category_name)}</span>
          <h2 id="pdName">${escapeHtml(p.name)}</h2>
          <div class="sold-by">Sold and shipped by <strong>${escapeHtml(p.business_name)}</strong></div>
          <div class="rating-row" style="margin:8px 0">${p.review_count ? `${stars(p.avg_rating)} ${Number(p.avg_rating).toFixed(1)} from ${p.review_count} review${p.review_count > 1 ? 's' : ''}` : 'No reviews yet'}</div>
          <div class="price">${money(p.price)}</div>
          <p class="pd-desc">${escapeHtml(p.description || '')}</p>
          ${max > 0 ? `
            <div class="pd-buy">
              <div class="qty">
                <button type="button" data-step="-1" aria-label="Decrease">−</button>
                <input type="number" id="pdQty" value="1" min="1" max="${max}" aria-label="Quantity">
                <button type="button" data-step="1" aria-label="Increase">+</button>
              </div>
              <button class="btn-primary" id="addToCartBtn" type="button">Add to cart</button>
            </div>
            <div class="stock ${max <= 5 ? 'low' : ''}">${max <= 5 ? `Only ${max} left` : `${max} in stock`}</div>`
          : '<p class="stock low">Out of stock</p>'}
        </div>
      </div>
      <div class="reviews-list">
        <h3>Reviews from buyers</h3>
        ${p.reviews.length ? p.reviews.map(r => `
          <div class="review">${stars(r.rating)}<div>${escapeHtml(r.comment || '')}</div>
            <div class="who">${escapeHtml(r.reviewer)} · verified purchase · ${dateStr(r.created_at)}</div></div>`).join('')
          : '<p class="muted small">Only customers who received this product can review it.</p>'}
      </div>`;

    const detail = document.getElementById('productDetail');
    detail.querySelectorAll('.pd-thumbs button').forEach(b => b.addEventListener('click', () => {
      detail.querySelectorAll('.pd-thumbs button').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('pdMain').innerHTML = thumb(b.dataset.src, p.name);
    }));
    detail.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
      const q = document.getElementById('pdQty');
      q.value = Math.min(max, Math.max(1, Number(q.value) + Number(b.dataset.step)));
    }));
    document.getElementById('addToCartBtn')?.addEventListener('click', () => addToCart(p.product_id, Number(document.getElementById('pdQty').value)));
    openModal('productModal');
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- Cart ----------------
function needCustomer() {
  if (!user) { location.href = 'login.html?next=index.html'; return false; }
  if (!isCustomer) { toast('Log in with a customer account to shop.', true); return false; }
  return true;
}

async function addToCart(productId, quantity) {
  if (!needCustomer()) return;
  try {
    await api('/customer/cart', { method: 'POST', body: { product_id: productId, quantity } });
    closeModal('productModal');
    toast('Added to cart');
    refreshCartCount();
  } catch (err) { toast(err.message, true); }
}

async function refreshCartCount() {
  if (!isCustomer) return;
  try {
    const cart = await api('/customer/cart');
    document.getElementById('cartCount').textContent = cart.items.reduce((s, i) => s + i.quantity, 0);
  } catch { /* ignore */ }
}

document.getElementById('cartBtn')?.addEventListener('click', () => { if (needCustomer()) showCart().catch(err => toast(err.message, true)); });

const drawerBody = document.getElementById('drawerBody');
const drawerFoot = document.getElementById('drawerFoot');

async function showCart() {
  document.getElementById('drawerTitle').textContent = 'Your cart';
  openModal('cartDrawer');
  drawerBody.innerHTML = '<p class="muted">Loading…</p>';
  drawerFoot.innerHTML = '';
  const cart = await api('/customer/cart');
  document.getElementById('cartCount').textContent = cart.items.reduce((s, i) => s + i.quantity, 0);
  if (!cart.items.length) {
    drawerBody.innerHTML = '<div class="empty-state" style="margin-top:16px"><p>Your cart is empty.</p><p class="empty-sub">Open any product and choose Add to cart.</p></div>';
    return;
  }
  drawerBody.innerHTML = cart.items.map(i => `
    <div class="cart-line" data-id="${i.product_id}">
      <div class="thumb">${thumb(i.image_url)}</div>
      <div>
        <div class="name">${escapeHtml(i.name)}</div>
        <div class="meta">${escapeHtml(i.business_name)} · ${money(i.price)} each</div>
        <div class="qty" style="margin-top:6px">
          <button type="button" data-q="${i.quantity - 1}" ${i.quantity <= 1 ? 'disabled' : ''} aria-label="Decrease">−</button>
          <input type="number" value="${i.quantity}" readonly aria-label="Quantity">
          <button type="button" data-q="${i.quantity + 1}" ${i.quantity >= i.stock_quantity ? 'disabled' : ''} aria-label="Increase">+</button>
        </div>
      </div>
      <div style="text-align:right">
        <div>${money(i.line_total)}</div>
        <button class="link-remove" type="button" data-remove>Remove</button>
      </div>
    </div>`).join('');
  drawerFoot.innerHTML = `
    <div class="total-row"><span>Total</span><strong>${money(cart.total)}</strong></div>
    <button class="btn-primary btn-block" type="button" id="toCheckout">Continue to checkout</button>`;
  document.getElementById('toCheckout').addEventListener('click', () => showCheckout(cart));
}

drawerBody.addEventListener('click', async e => {
  const line = e.target.closest('.cart-line');
  if (!line) return;
  try {
    if (e.target.dataset.q) await api(`/customer/cart/${line.dataset.id}`, { method: 'PUT', body: { quantity: Number(e.target.dataset.q) } });
    else if (e.target.hasAttribute('data-remove')) await api(`/customer/cart/${line.dataset.id}`, { method: 'DELETE' });
    else return;
    showCart();
  } catch (err) { toast(err.message, true); }
});

// ---------------- Checkout ----------------
async function showCheckout(cart) {
  document.getElementById('drawerTitle').textContent = 'Checkout';
  const addresses = await api('/customer/addresses');
  const vendors = new Set(cart.items.map(i => i.business_name));

  drawerBody.innerHTML = `
    <div class="checkout-step">
      <h3>Deliver to</h3>
      <div id="addressList">${addresses.map((a, i) => `
        <label class="option-card"><input type="radio" name="address" value="${a.address_id}" ${i === 0 ? 'checked' : ''}>
          <span><strong>${escapeHtml(a.full_name)}</strong> · ${escapeHtml(a.phone)}<br>
          ${escapeHtml([a.address_line1, a.address_line2, a.city, a.state, a.postal_code].filter(Boolean).join(', '))}</span></label>`).join('')}
      </div>
      <button type="button" class="text-btn" id="addAddrBtn">${addresses.length ? '+ Add another address' : '+ Add a delivery address'}</button>
      <form id="addrForm" class="form-stack ${addresses.length ? 'hidden' : ''}" style="margin-top:10px">
        <div class="field-row"><label>Full name<input name="full_name" required></label><label>Phone<input name="phone" required inputmode="tel"></label></div>
        <label>Address line 1<input name="address_line1" required></label>
        <label>Address line 2 (optional)<input name="address_line2"></label>
        <div class="field-row"><label>City<input name="city" required></label><label>State<input name="state" required value="Tamil Nadu"></label></div>
        <div class="field-row"><label>PIN code<input name="postal_code" required pattern="\\d{6}" inputmode="numeric"></label><span style="flex:1"></span></div>
        <button class="btn-ghost" type="submit">Save address</button>
      </form>
    </div>
    <div class="checkout-step">
      <h3>Pay with</h3>
      <div class="pay-grid">
        ${[['UPI', 'UPI'], ['CARD', 'Card'], ['NETBANKING', 'Net banking'], ['COD', 'Cash on delivery']].map(([v, l], i) =>
          `<label class="option-card"><input type="radio" name="pay" value="${v}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join('')}
      </div>
      <p class="muted small">Online payments are simulated for this project. Cash on delivery is marked paid when the order is delivered.</p>
    </div>
    <div class="checkout-step">
      <h3>Summary</h3>
      ${cart.items.map(i => `<div class="total-row" style="font-size:14px;margin-bottom:6px"><span>${escapeHtml(i.name)} × ${i.quantity}</span><span>${money(i.line_total)}</span></div>`).join('')}
      ${vendors.size > 1 ? `<p class="muted small">This order has items from ${vendors.size} stores. Each store ships its items separately.</p>` : ''}
    </div>
    <p class="form-error hidden" id="checkoutError"></p>`;

  drawerFoot.innerHTML = `
    <div class="total-row"><span>To pay</span><strong>${money(cart.total)}</strong></div>
    <div style="display:flex;gap:8px"><button class="btn-ghost" type="button" id="backToCart">Back</button>
    <button class="btn-primary btn-block" type="button" id="placeOrderBtn">Place order</button></div>`;

  document.getElementById('backToCart').addEventListener('click', showCart);
  document.getElementById('addAddrBtn').addEventListener('click', () => document.getElementById('addrForm').classList.toggle('hidden'));
  document.getElementById('addrForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/customer/addresses', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Address saved');
      showCheckout(cart);
    } catch (err) { toast(err.message, true); }
  });
  document.getElementById('placeOrderBtn').addEventListener('click', async e => {
    const btn = e.target;
    const errEl = document.getElementById('checkoutError');
    errEl.classList.add('hidden');
    const address = document.querySelector('input[name=address]:checked');
    if (!address) { errEl.textContent = 'Add a delivery address first.'; errEl.classList.remove('hidden'); return; }
    btn.disabled = true; btn.textContent = 'Placing order…';
    try {
      const r = await api('/customer/checkout', { method: 'POST', body: {
        address_id: Number(address.value),
        payment_method: document.querySelector('input[name=pay]:checked').value
      }});
      showPlaced(r.order_id);
      refreshCartCount();
      loadProducts(); // stock changed
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Place order';
    }
  });
}

function showPlaced(orderId) {
  document.getElementById('drawerTitle').textContent = 'Order placed';
  drawerBody.innerHTML = `
    <div class="empty-state" style="margin-top:16px;border-style:solid">
      <p style="font-family:Fraunces,serif;font-size:22px;color:var(--navy)">Order #${orderId} is confirmed</p>
      <p class="empty-sub">Each store will ship its items and add tracking details.</p>
    </div>`;
  drawerFoot.innerHTML = '<a class="btn-primary btn-block" style="text-align:center" href="orders.html">Track my orders</a>';
}

// ---------------- Init ----------------
loadCategories().catch(err => toast(err.message, true));
loadProducts();
refreshCartCount();
