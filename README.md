# MasteringPro — AI Audio Mastering

Browser-based mastering console by **Hardban Records Lab**. All DSP (EQ, multiband
compression, limiting, mid/side, saturation, metering, offline render) runs
**client-side** via the Web Audio API. A small backend service adds the AI
features: chain generation, QA validation, reference matching, and the
conversational Copilot.

```text
┌──────────────────────────┐       HTTPS POST /api/*        ┌───────────────────────────┐
│  Frontend (Vercel)       │  ──────────────────────────▶   │  API (VPS, Docker)        │
│  Vite + React + shadcn    │                                │  Node / Hono proxy        │
│  Web Audio DSP engine     │  ◀──────────────────────────   │  → OpenRouter (AI models) │
└──────────────────────────┘        JSON config              └───────────────────────────┘
   masteringpro.hardbanrecordslab.online    api.masteringpro.hardbanrecordslab.online
```

| Layer    | Tech                                  | Hosting                                     |
| -------- | ------------------------------------- | ------------------------------------------- |
| Frontend | Vite, React 18, TypeScript, shadcn/ui | **Vercel** (static SPA)                     |
| Backend  | Node 20, Hono                         | **VPS** (Docker; host nginx terminates TLS) |
| AI       | OpenRouter (OpenAI-compatible)        | free models first, cheap paid fallback      |

On the HBRL VPS, host nginx + certbot already handle TLS, so deploy the API with
`docker-compose.vps.yml` (API container only, published on `127.0.0.1:8787`).
`docker-compose.yml` + `Caddyfile` are for a standalone host. There is **no
database** — session history and presets live in the browser (`localStorage`).

## Repository layout

```text
/                          Frontend (Vite app)
├─ public/                 Brand assets: logo.png, favicons, PWA icons, manifest
├─ src/lib/aiApi.ts        Client for the backend API
├─ vercel.json             SPA rewrites + asset caching
├─ server/                 Backend service
│  ├─ src/                 Hono app: /api/ai-mastering, /api/ai-copilot
│  ├─ Dockerfile
│  └─ .env.example         Backend config (AI key, model chain, rate limits, CORS)
├─ docker-compose.vps.yml  API container only — for the HBRL VPS (nginx does TLS)
├─ docker-compose.yml      Standalone-host stack: api + Caddy (auto HTTPS)
├─ Caddyfile
├─ .env.example            Compose config for the Caddy variant (API_DOMAIN, ACME_EMAIL)
└─ DEPLOYMENT.md           Step-by-step deploy guide
```

## Local development

Two processes. **Backend first:**

```sh
cd server
cp .env.example .env          # set AI_API_KEY (get one at https://openrouter.ai/keys)
npm install
npm run dev                    # http://localhost:8787
```

**Frontend:**

```sh
npm install
npm run dev                    # http://localhost:8080  → auto-targets localhost:8787
```

No frontend `.env` is needed locally. Set `VITE_API_URL` only for deployed builds.

## Deploy

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the complete guide. On the HBRL VPS the
authoritative runbook is `HBRL-VPS/VPS-ACTION-PLAN.md` → "Wdrożenie MasterPRO".
Summary:

1. **VPS (API)** — point `api.masteringpro.hardbanrecordslab.online` at the
   server, fill `server/.env` (or Infisical), then
   `docker compose -f docker-compose.vps.yml up -d --build`. Add an nginx vhost +
   `certbot` for TLS.
2. **Vercel (frontend)** — import the repo, set
   `VITE_API_URL=https://api.masteringpro.hardbanrecordslab.online`, deploy. Add
   the final frontend URL to `ALLOWED_ORIGINS` in `server/.env` and re-run
   `docker compose -f docker-compose.vps.yml up -d`.

## Scripts

| Command                    | What it does                |
| -------------------------- | --------------------------- |
| `npm run dev`              | Frontend dev server (Vite)  |
| `npm run build`            | Production build → `dist/`   |
| `npm test`                 | Vitest unit tests           |
| `npm run lint`             | ESLint                      |
| `cd server && npm run dev` | Backend with `--watch`      |
