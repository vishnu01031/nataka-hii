# Final review demo script (about 10 minutes)

Open these tabs before you start:
1. The live site `https://<app>.azurewebsites.net` (or `http://localhost:8080`)
2. Azure portal → resource group `rg-nataka-hii`
3. Azure portal → SQL database → **Query editor** (logged in), with `db/queries.sql` pasted
4. Application Insights → **Live metrics**
5. GitHub → Actions tab

Use a second browser (or an incognito window) so two roles can be logged in at once.

## Part A: the platform (3 min)

1. **Customer (Anita)**: browse, filter by *Electronics*, search "kurti", open a product → photos, verified-purchase reviews.
2. Add *Cotton Kurti* × 2 and *Power Bank* × 1 (from two different stores) to the cart → checkout → choose address → **Cash on delivery** → Place order.
3. **My orders**: the order shows two store groups, both "Not shipped yet".
4. **Vendor (Rahul)**, in the other window: Orders tab → the new order shows **only Rahul's items** → Ship → courier + tracking number.
5. Back as Anita: refresh **My orders** → status is now **Partially shipped**.
6. Rahul: Mark delivered → Anita can now post a review for the kurti.
7. **Vendor portal → Products**: add a product with photos; edit; delete one.
8. **Admin**: Vendors tab → approve *Meena Home Decor* → log in as meena@example.com to show she can now sell.

## Part B: DBMS (4 min)

1. Show the ER diagram (`docs/er-diagram.png`) and explain the multi-vendor design: item-level status, one shipment per (order, vendor).
2. Query editor: run queries 1, 3, 4, 7, 8 from `db/queries.sql` (join, GROUP BY/HAVING, correlated subquery, view, stored procedure).
3. **Constraints**: uncomment and run the CHECK (negative stock) and UNIQUE (duplicate email) examples; show the errors.
4. **Transaction**: explain the checkout transaction (DBMS_NOTES section 5), then run the transaction block at the bottom of `queries.sql`. It tries to remove 999 units, finds there isn't enough stock, rolls back, and the stock is unchanged.
5. Run `SELECT * FROM orders; SELECT * FROM order_items;` to show the order placed in Part A, with the computed `subtotal`.

## Part C: Cloud (3 min)

1. Resource group: App Service, SQL server + database, storage account, container registry, Application Insights.
2. Architecture diagram (`docs/architecture.png`).
3. Storage account → Containers → `product-images` → the photo uploaded in Part A.
4. Container registry → Repositories → `nataka-hii` → image tags (commit SHAs from CI/CD).
5. **CI/CD live**: edit the hero text in `frontend/index.html`, commit, push → Actions run → refresh the site after it finishes (≈3–4 min, so start this at the beginning of Part B).
6. Application Insights → Live metrics while clicking the site; Application map showing App Service → SQL and Blob.
7. Identity: explain why Entra External ID replaces Azure AD B2C (see the end of `AZURE_DEPLOYMENT.md`).

## If something breaks during the demo

- Site shows "database unreachable": Portal → App Service → Restart, wait 1 minute.
- Need fresh demo data locally: `docker compose exec app npm run db:reset`.
- Need fresh demo data on Azure: in Query editor, run only the DROP statements at the top of `db/schema.sql` (everything before the first `GO`), then restart the App Service. With `INIT_DB=true` it finds no tables and recreates the schema and demo data.
