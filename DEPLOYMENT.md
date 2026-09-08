# Deployment guide — Frontend on Vercel, Backend on a VPS

> **Deploying on the HBRL VPS?** Use **[DEPLOY.md](DEPLOY.md)** — the canonical
> all-on-VPS runbook (static frontend + API container + `hbrl-postgres`, one
> `./deploy/vps-deploy.sh`). This file below is the generic Vercel-frontend /
> standalone-API-host alternative.

This walks through a generic production deploy from zero (standalone API host).

- **Frontend:** static SPA on Vercel
- **Backend:** Node/Hono service on your VPS, behind Caddy (automatic HTTPS)
- **AI:** OpenRouter (start on free models, switch to a paid mid-tier model later
  by changing one env var)

You need: a domain you control, a VPS with Docker, a Vercel account, an
OpenRouter API key (<https://openrouter.ai/keys>).

---

## 1. DNS

Create one record now (before deploying the backend, so Caddy can get a cert):

| Type | Name  | Value                | Notes                         |
| ---- | ----- | -------------------- | ----------------------------- |
| A    | `api` | `<your VPS IPv4>`    | → `api.yourdomain.com`        |
| AAAA | `api` | `<your VPS IPv6>`    | optional, if the VPS has IPv6 |

The frontend domain (`app.yourdomain.com` or the free `*.vercel.app`) is set up
in step 3.

---

## 2. Backend on the VPS

### 2.1 Prerequisites (once per server)

```sh
# Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh
# open the firewall
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow OpenSSH && sudo ufw enable
```

### 2.2 Get the code

```sh
git clone <your repo url> masterpro && cd masterpro
```

### 2.3 Configure

Two env files — copy the examples and edit:

```sh
cp .env.example .env
cp server/.env.example server/.env
```

**`.env`** (used by `docker-compose.yml`):

```ini
API_DOMAIN=api.yourdomain.com
ACME_EMAIL=you@yourdomain.com
```

**`server/.env`** (used by the API container):

```ini
AI_API_KEY=sk-or-v1-...            # from openrouter.ai/keys  ← required
AI_MODEL=deepseek/deepseek-chat-v3-0324:free
ALLOWED_ORIGINS=https://app.yourdomain.com,https://masterpro.vercel.app
```

> Set `ALLOWED_ORIGINS` to your exact Vercel URL(s). You can come back and add
> the real domain after step 3, then re-run `docker compose up -d`.

### 2.4 Launch

```sh
docker compose up -d --build
docker compose logs -f caddy     # watch the TLS cert get issued
```

### 2.5 Verify

```sh
curl https://api.yourdomain.com/health
# {"ok":true,"model":"deepseek/deepseek-chat-v3-0324:free", ...}
```

If `ok` is `false`, the `problems` array tells you what env var is missing.

---

## 3. Frontend on Vercel

### 3.1 Import

Vercel → **Add New… → Project** → import this Git repo.
Framework preset **Vite** is auto-detected (`vercel.json` pins it anyway).

### 3.2 Environment variable

Project → **Settings → Environment Variables**:

| Key            | Value                          | Environments               |
| -------------- | ------------------------------ | -------------------------- |
| `VITE_API_URL` | `https://api.yourdomain.com`   | Production, Preview, Dev    |

> `VITE_*` vars are baked in at build time — after changing it, **redeploy**.

### 3.3 Deploy

Click **Deploy**. When it's live, note the URL (e.g. `masterpro.vercel.app` or
your custom domain).

### 3.4 Close the CORS loop

Put the real frontend URL into `server/.env` → `ALLOWED_ORIGINS` on the VPS, then:

```sh
docker compose up -d          # picks up the changed env, recreates the api container
```

---

## 4. Smoke test the whole path

1. Open the Vercel URL, drop in an audio file.
2. **One-Click Master** (Quick mode) or **AI Analyze & Master** (Smart/Pro).
3. Watch `docker compose logs -f api` on the VPS — you should see the request.
4. Browser dev tools → Network → the `POST /api/ai-mastering` call returns `200`.

---

## 5. Choosing an AI model

Edit `server/.env` → `AI_MODEL`, then `docker compose up -d`.

| Tier            | Example model IDs (verify at openrouter.ai/models)        |
| --------------- | -------------------------------------------------------- |
| Free            | `deepseek/deepseek-chat-v3-0324:free`, `meta-llama/llama-3.3-70b-instruct:free` |
| Balanced (paid) | `google/gemini-2.5-flash`, `openai/gpt-4o-mini`, `anthropic/claude-3.5-haiku` |
| Higher quality  | `anthropic/claude-3.7-sonnet`, `openai/gpt-4o`           |

Optional automatic fallback if the primary is down/limited:

```ini
AI_MODELS=deepseek/deepseek-chat-v3-0324:free,meta-llama/llama-3.3-70b-instruct:free
```

Free models sometimes reject strict JSON mode — if you see `AI_400` errors, set
`AI_JSON_MODE=false` (the server also auto-retries once without it).

---

## 6. Operations

```sh
# update to latest code
git pull && docker compose up -d --build

# logs
docker compose logs -f api
docker compose logs -f caddy

# restart / stop
docker compose restart api
docker compose down

# resource use
docker stats
```

**Rate limiting** is in-memory (per client IP): `RATE_LIMIT_MASTERING_MAX=20/h`,
`RATE_LIMIT_COPILOT_MAX=60/h` by default — tune in `server/.env`. Counters reset
when the container restarts. For multi-instance/HA you'd front it with Redis.

**Backups:** nothing to back up — the backend is stateless. The `caddy_data`
volume holds TLS certs (auto-renews; Caddy will re-issue if lost).

**Updating just the frontend:** push to the repo; Vercel auto-deploys.

---

## 7. Alternative backend host (no Docker)

If you'd rather run bare Node + nginx:

```sh
cd server && npm ci --omit=dev
cp .env.example .env && $EDITOR .env          # set AI_API_KEY, ALLOWED_ORIGINS, TRUST_PROXY=true
npm start                                      # or: pm2 start src/index.js --name masterpro-api
```

Then reverse-proxy `api.yourdomain.com` → `127.0.0.1:8787` in nginx and run
`certbot --nginx`. Keep `TRUST_PROXY=true` so client IPs (rate limiting) are read
from `X-Forwarded-For`.

---

## Troubleshooting

| Symptom                                        | Fix                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Frontend: "VITE_API_URL is not configured"     | Set `VITE_API_URL` in Vercel env, **redeploy**.                            |
| Browser CORS error on `/api/*`                 | Add the exact frontend origin to `ALLOWED_ORIGINS` in `server/.env`, `docker compose up -d`. |
| `/health` shows `AI_API_KEY is not set`        | Fill `server/.env`, `docker compose up -d`.                                |
| Caddy can't get a certificate                  | DNS not pointing at the VPS yet, or ports 80/443 blocked/in use.            |
| `AI_401` / `AI_403` from the API               | Bad or missing `AI_API_KEY`.                                               |
| `AI_402`                                       | OpenRouter credits exhausted — switch to a `:free` model or top up.        |
| `429` from the API                             | Rate limit hit — raise the limits in `server/.env` or wait.                |
