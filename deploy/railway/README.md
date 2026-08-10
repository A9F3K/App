# TDLib gateway on Railway

Long-running MTProto sidecar for Vercel (`TDLIB_GATEWAY_URL`). Not deployable on Vercel serverless.

## Quick deploy

Dashboard: [railway.app/dashboard](https://railway.app/dashboard)

One-time: `npx railway login` and `npx railway link` (select project → **tdlib-gateway** service).

```bash
npm run deploy:railway:tdlib-gateway
```

Verify: `curl https://YOUR-SERVICE.up.railway.app/v1/health` → `"ok": true`.

See sections below for env vars, volume, and Vercel wiring.

## Build

The Docker image uses **`deploy/railway/package.json`** (6 runtime deps only), not the root Expo lockfile. That keeps Railway builds fast and avoids monorepo `npm ci` sync failures.

### 1. Install CLI (local)

```bash
npm install
npx railway login
npx railway link
```

Select your project and the **tdlib-gateway** service (or create an empty service first in the dashboard).

### 2. Railway service settings (dashboard)

| Section | Setting | Value |
|---------|---------|--------|
| **Source** | Connect Repo | This GitHub repo |
| **Source** | Root Directory | `/` (repo root) |
| **Config-as-code** | File path | *(optional)* `railway.toml` at repo root is auto-detected |
| **Build** | Builder | **Dockerfile** (via root `railway.toml` — not Railpack/Expo) |
| **Networking** | Public Networking | **Generate Domain** (HTTPS) |
| **Networking** | TCP Proxy | **Off** (use HTTP domain only) |
| **Scale** | Region | US West (or nearest to users) |
| **Scale** | Replicas | **1** |
| **Scale** | CPU / Memory | **2 vCPU / 1 GB** minimum; bump memory if connect/sync OOMs |
| **Deploy** | Custom Start Command | *(empty — Dockerfile CMD)* |
| **Deploy** | Healthcheck Path | `/v1/health` |
| **Deploy** | Serverless | **Off** (must stay always-on) |
| **Deploy** | Restart Policy | **On Failure**, max retries 10 |
| **Volume** | Mount path | `/data` |
| **Volume** | Env | `TDLIB_DB_ROOT=/data/tdlib` |

**Volume (required):** Settings → **Volumes** → Add volume → mount **`/data`**. Without it, TDLib session DB is wiped on every deploy.

### 3. Environment variables (Railway service)

| Variable | Required | Example / notes |
|----------|----------|-----------------|
| `DATABASE_URL` | Yes | Same Neon URL as Vercel |
| `TELEGRAM_API_ID` | Yes | From https://my.telegram.org/apps |
| `TELEGRAM_API_HASH` | Yes | From https://my.telegram.org/apps |
| `TDLIB_GATEWAY_SECRET` | Yes | Long random string; **same value on Vercel** |
| `TDLIB_DB_ROOT` | Yes | `/data/tdlib` |
| `TDLIB_STORAGE_MODE` | No | `slim` (default) = auth-only on disk, fetch chats from Telegram; `full` = classic multi-GB local TDLib DB |
| `TDLIB_RESTORE_MODE` | No | `lazy` (default) = open clients on demand; `eager` = restore all sessions at boot |
| `TDLIB_CLIENT_IDLE` | No | `auto` (default) / `off` — unload idle in-memory clients |
| `TDLIB_CLIENT_IDLE_MS` | No | `900000` (15m) — close unused clients; auth stays on disk |
| `TDLIB_CLIENT_IDLE_CHECK_MS` | No | `60000` — idle sweeper interval |
| `TDLIB_GATEWAY_HOST` | Yes | `0.0.0.0` |
| `NODE_ENV` | Yes | `production` |

Do **not** set `TDLIB_GATEWAY_PORT` on Railway — the app listens on Railway’s injected `PORT` automatically.

Optional: `RAILWAY_RUN_UID=0` if TDLib hits permission errors writing to the volume.

### 4. Vercel (hsbexpo) — after first deploy

Copy the Railway **public domain** (e.g. `https://tdlib-gateway-production-xxxx.up.railway.app`):

| Variable | Value |
|----------|--------|
| `TDLIB_GATEWAY_URL` | `https://YOUR-SERVICE.up.railway.app` (no trailing slash) |
| `TDLIB_GATEWAY_SECRET` | Same as Railway |
| `TELEGRAM_API_ID` | Same as Railway |
| `TELEGRAM_API_HASH` | Same as Railway |

Redeploy Vercel (`vercel --prod`).

### 5. Deploy

```bash
npm run deploy:railway:tdlib-gateway
```

Or push to the connected branch (Railway auto-deploys).

### 6. Verify

```bash
curl https://YOUR-SERVICE.up.railway.app/v1/health
```

Expect JSON with `"ok": true`.

Then in the app: Welcome → sign in → **Connect Telegram** (QR flow).

## CLI shortcuts

```bash
npx railway variables set DATABASE_URL="..." TELEGRAM_API_ID="..." TELEGRAM_API_HASH="..." TDLIB_GATEWAY_SECRET="..." TDLIB_DB_ROOT="/data/tdlib" TDLIB_GATEWAY_HOST="0.0.0.0" NODE_ENV=production
npx railway volume add --mount-path /data
npx railway domain
npx railway logs
```

## Troubleshooting

### `Failed to upload code with status code 404 Not Found`

Usually means **no valid service is linked** for this folder.

Check:

```bash
npx railway status
```

If **Linked service: None**, fix it:

1. Railway dashboard → project **accomplished-flexibility** → **+ New** → **Empty Service** (name it e.g. `tdlib-gateway`)
2. Locally:

   ```bash
   npx railway link
   ```

   Select: project → **production** → **tdlib-gateway** (do not skip the service step)

3. Confirm:

   ```bash
   npx railway status
   # Linked service: tdlib-gateway   ← must not be None
   npx railway service list          ← must list your service
   ```

4. Deploy again:

   ```bash
   npm run deploy:railway:tdlib-gateway
   ```

**Alternative (often easier):** connect GitHub in the Railway service **Source** tab and deploy from a git push — no `railway up` upload needed.

Upgrade CLI if 404 persists after linking: `npm i -D @railway/cli@latest` (v5.x).

### `npm ci` / lock file out of sync (graphql, @tonconnect, …)

The gateway Dockerfile installs from **`deploy/railway/package.json`**, not the repo root. If you still see root lockfile errors, redeploy after pulling the latest `deploy/railway/package-lock.json`.

Root `package.json` / `package-lock.json` can be out of sync on npm 10.9+ without affecting the gateway build.

### Build runs `expo export` / `Cannot resolve entry file`

Railway defaulted to **Railpack** (Node auto-detect) instead of the TDLib **Dockerfile**. That runs `npm run build` → Expo web export, which this service does not need.

Fix:

1. Ensure **`railway.toml`** exists at the **repo root** (committed) with `builder = "DOCKERFILE"`.
2. Redeploy. Build logs should show a Docker build, not `Railpack 0.x` / `npm run build`.
3. If it still uses Railpack: service **Settings → Build → Builder** → **Dockerfile**, or set variable `RAILWAY_DOCKERFILE_PATH=deploy/railway/Dockerfile.tdlib-gateway`.

### Other issues

- **502 / health check fails:** Service not listening on `$PORT` — ensure latest code (uses `PORT` fallback).
- **Connect works once then breaks after redeploy:** Volume missing or wrong mount path; data must live under `/data/tdlib`.
- **Vercel still uses localhost:** `TDLIB_GATEWAY_URL` not set on Vercel Production or not redeployed.
- **OOM / restarts under load:** Increase Railway memory to 2 GB.
