# SecureTrade Platform
Production-style starter monorepo for a multi-asset exchange + P2P marketplace.

## Important
This repository implements the application architecture, authentication, RBAC, ledger/escrow foundations, APIs and Flutter UI. Blockchain custody, fiat processors, KYC/AML providers and market-data providers are adapter-based and require real credentials and legal/compliance approval before production use.

## Run API
1. `cd services/api`
2. `cp .env.example .env`
3. `npm install`
4. `npx prisma migrate dev --name init`
5. `npm run dev`

API: `http://localhost:4000`

## Web panels
Each web app is a Vite React TypeScript app. Install dependencies in the app and run `npm run dev`.

## Flutter
`cd apps/mobile && flutter pub get && flutter run`

## Deploy the API on Render
`render.yaml` is a Render Blueprint that creates the API web service and a Postgres database.
1. Render dashboard → **New → Blueprint** → select this repo.
2. Enter `CORS_ORIGIN` when prompted (comma-separated frontend URLs; leave empty to allow all).
3. Apply. `DATABASE_URL` and `JWT_SECRET` are wired/generated automatically; migrations run during each build.

Health check: `https://<service>.onrender.com/health`

## Deploy the web apps on Vercel
Create one Vercel project per app (framework preset: Vite), setting **Root Directory** to `apps/user-web`, `apps/vendor-panel` or `apps/admin-panel`.

## Production checklist
- Use a managed secret/KMS service.
- Configure real KYC/AML, custody, blockchain, fiat and market-data providers.
- Complete jurisdiction-specific legal/compliance review.
- Enable TLS, backups, monitoring, WAF, rate limits and external security testing.
