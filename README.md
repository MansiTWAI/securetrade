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

## Deploy on Vercel
Create one Vercel project per folder, setting **Root Directory** accordingly:

| Project | Root Directory | Framework preset |
|---|---|---|
| API | `services/api` | Express |
| User web | `apps/user-web` | Vite |
| Vendor panel | `apps/vendor-panel` | Vite |
| Admin panel | `apps/admin-panel` | Vite |

API environment variables: `DATABASE_URL` (hosted Postgres, e.g. Neon/Supabase), `JWT_SECRET`, `JWT_EXPIRES_IN`, `CORS_ORIGIN` (comma-separated frontend URLs). The API's `vercel-build` script runs `prisma migrate deploy` on each deploy.

## Production checklist
- Use a managed secret/KMS service.
- Configure real KYC/AML, custody, blockchain, fiat and market-data providers.
- Complete jurisdiction-specific legal/compliance review.
- Enable TLS, backups, monitoring, WAF, rate limits and external security testing.
