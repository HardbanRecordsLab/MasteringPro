# MasteringPro — VPS deployment runbook

All-on-VPS: static frontend + API container + Postgres (shared `hbrl-postgres`),
behind the host nginx on `84.247.162.167` (hbrl-prod). No Vercel needed.

| | |
|---|---|
| Frontend | `https://masteringpro.hardbanrecordslab.online` — static SPA, nginx serves `/opt/masteringpro/dist` |
| API | `https://api.masteringpro.hardbanrecordslab.online` — `docker-compose.vps.yml`, container on `127.0.0.1:8787` |
| Database | `masteringpro` DB in the `hbrl-postgres` container (per `HBRL-VPS/DB-POLICY.md`) |

---

## 1. DNS (do first — certbot needs it)

Add two A records pointing at the VPS:

```
masteringpro       A   84.247.162.167
api.masteringpro   A   84.247.162.167
```

(Optional AAAA → `2a02:c207:2306:1455::1`.) The old `masterpro.` cert reservation
in `HBRL-VPS/VPS-ACTION-PLAN.md` can be dropped.

## 2. Get the code on the VPS

```sh
ssh -i ~/.ssh/vps_key root@84.247.162.167
git clone git@github.com:HardbanRecordsLab/MasteringPro.git /opt/masteringpro
cd /opt/masteringpro
```

## 3. Configure `server/.env`

```sh
cp server/.env.example server/.env
$EDITOR server/.env
```

Set:

```ini
AI_API_KEY=sk-or-v1-...                       # OpenRouter
ALLOWED_ORIGINS=https://masteringpro.hardbanrecordslab.online
DATABASE_URL=postgresql://hbrl_admin:HRL.ks.84@hbrl-postgres:5432/masteringpro
NODE_ENV=production
COOKIE_SECURE=true
```

> On the VPS, pull the secrets from Infisical (project `masteringpro`) instead of
> committing them — the deploy script reads whatever is in `server/.env`.

## 4. Run the deploy script

```sh
./deploy/vps-deploy.sh
```

It is idempotent and does:

1. `git pull`
2. creates the `masteringpro` database in `hbrl-postgres` if missing
3. `docker compose -f docker-compose.vps.yml up -d --build` (API; runs migrations on boot)
4. `npm ci && VITE_API_URL=… npm run build` → `dist/`
5. links `deploy/nginx/masteringpro.conf` into `sites-enabled/`
6. issues the Let's Encrypt cert (first run) and reloads nginx

## 5. Verify

```sh
curl -s https://api.masteringpro.hardbanrecordslab.online/health
# {"ok":true,"db":true,...}
curl -sI https://masteringpro.hardbanrecordslab.online | head -1
# HTTP/2 200
```

Then open the site, drop in a track, run One-Click Master, check the download and
the Loudness Penalty panel.

## 6. Backups

Add `masteringpro` to the database list in `/root/vps-scripts/db-backup-all.sh`
(the script the cron `15 3 * * *` runs).

## 7. Updates

```sh
cd /opt/masteringpro && ./deploy/vps-deploy.sh
```

## Notes / decisions still open (from the roadmap)

- **Auth**: email + password only for now. Magic-link / Google OAuth need the
  Resend / Google secrets wired — deferred.
- **Rate limiting** is in-memory (per container). Move to host Redis
  (`127.0.0.1:6379`) if you run more than one API replica.
- **FLAC export** uses `libflacjs` (asm.js) in the browser — smoke-test it on the
  live site; it falls back to WAV in the ZIP if the encoder fails to load.
- The API also runs fine **without** `DATABASE_URL` (AI proxy only, account
  endpoints return 501).
