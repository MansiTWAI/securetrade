# SecureTrade Platform
Production-style starter monorepo for a multi-asset exchange + P2P marketplace.

## Important
This repository implements the application architecture, authentication, RBAC, ledger/escrow foundations, APIs and Flutter UI. Blockchain custody, fiat processors, KYC/AML providers and market-data providers are adapter-based and require real credentials and legal/compliance approval before production use.

## Live deployment
| App | URL |
|---|---|
| User web | https://securetrade-user-web.vercel.app |
| Vendor panel | https://securetrade-vendor-panel.vercel.app |
| Admin panel | https://securetrade-admin-panel.vercel.app |
| API (Render) | https://securetrade-api.onrender.com |

## How a P2P trade works
1. A vendor posts an ad (vendor panel → My Ads). The ad's quantity is reserved as orders are placed and returned if they are cancelled.
2. A user takes the ad (user web → P2P Market). For a SELL ad the vendor is the seller.
3. The seller locks the crypto in escrow — this moves it from their available balance to locked.
4. The buyer pays off-platform and clicks **I've paid**.
5. The seller confirms receipt and clicks **Release** — the crypto moves to the buyer's wallet.
6. Either party can open a dispute while funds are in escrow; an admin resolves it by releasing to the buyer or refunding the seller.

Wallets are funded by an admin (admin panel → Credit Wallet) until a custody/deposit provider is connected.

## Run API
1. `cd services/api`
2. `cp .env.example .env`
3. `npm install`
4. `npx prisma migrate dev`
5. `npm run seed` — assets, fiat currencies, markets, and a SUPER_ADMIN if `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set
6. `npm run dev`

API: `http://localhost:4000` · End-to-end check: `API_URL=http://localhost:4000 ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/smoke.mjs`

## Web panels
Each web app is a Vite React TypeScript app: `npm install && npm run dev`. They talk to `VITE_API_URL` (defaults to the Render API); for local work create `.env.development.local` with `VITE_API_URL=http://localhost:4000`.

`src/lib/` (API client + UI kit) and `src/style.css` are identical in all three apps — edit one and copy to the others.

## Flutter
`cd apps/mobile && flutter pub get && flutter run`

## Deploy the API on Render
`render.yaml` is a Render Blueprint that creates the API web service and a Postgres database.
1. Render dashboard → **New → Blueprint** → select this repo.
2. Enter `CORS_ORIGIN` when prompted (comma-separated frontend URLs; leave empty to allow all).
3. Apply. `DATABASE_URL`, `JWT_SECRET` and `ADMIN_PASSWORD` are wired/generated automatically. Migrations run during each build; the seed runs on each start.

Admin login: `ADMIN_EMAIL` from `render.yaml`, password from the service's **Environment** tab in Render.

## Deploy the web apps on Vercel
Create one Vercel project per app (framework preset: Vite), setting **Root Directory** to `apps/user-web`, `apps/vendor-panel` or `apps/admin-panel`.

## Production checklist
- Use a managed secret/KMS service.
- Configure real KYC/AML, custody, blockchain, fiat and market-data providers.
- Complete jurisdiction-specific legal/compliance review.
- Enable TLS, backups, monitoring, WAF and external security testing.
