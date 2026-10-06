# Render deployment

The supported hosted setup is one Render Native Python Web Service. FastAPI serves the production React build from the same origin. The service uses one instance and the in-memory run store; each browser tab reconnects only to the run ID in its own `sessionStorage`.

## Service configuration

Create one service from this repository with:

| Setting | Value |
| --- | --- |
| Runtime | Python |
| Branch | `main` |
| Region | Singapore |
| Plan | Free |
| Instances | 1 |
| Health check path | `/health` |
| Auto-deploy | After CI Checks Pass |

Build command:

```sh
python -m pip install ./backend && cd frontend && npm ci --include=dev && npm run build
```

Start command:

```sh
uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'
```

Configure these environment variables:

| Key | Value |
| --- | --- |
| `STOCK_ETF_BACKTESTER_SERVE_FRONTEND` | `1` |
| `STOCK_ETF_BACKTESTER_FRONTEND_DIR` | `frontend/dist` |
| `APP_BASIC_AUTH_USERNAME` | Shared login name; set as a secret |
| `APP_BASIC_AUTH_PASSWORD` | Strong shared password; set as a secret |

Do not set `PORT`; Render supplies it. Never commit secret values.

## Deployment behavior and limits

Basic Auth protects the UI, assets, API, and documentation endpoints. Only `/health` is public for Render's health check. The app does not create individual accounts or isolate run access by authenticated identity; use this shared-password service only with a trusted audience.

Run state, idempotency records, and search candidates live in process memory. Keep exactly one instance and do not attach a database, Key Value, persistent disk, worker, or cron job. A deploy, restart, or Free service sleep clears active and completed server-side runs. A tab whose saved active run ID no longer exists receives a 404, clears that session entry, and can submit a new run. Last-run strategy configuration remains in that browser's existing local storage.

Free services can sleep after inactivity, so the first request after sleep may take longer. The filesystem is ephemeral; do not treat it as durable user storage.
The shared build includes `noindex, nofollow`; it does not need a sitemap or analytics.

## Checks

CI builds the app, starts the production-configured FastAPI app locally, and checks public health, protected catalog/UI/assets, and the built frontend. It also runs the normal API, Yahoo-data, unit, and browser suites.

After the first deployment, verify `/health`, then authenticate and check `/`, `/api/v1/catalog`, and the referenced JS/CSS assets. Run a QQQ backtest through completion and verify progress/SSE plus CSV and PNG export. Check logs and instance metrics for errors and memory pressure. Restart the service and confirm a previously active run ID returns 404 and the browser recovers to the empty state.

The Render service creation integration used for initial provisioning may not expose the health-check or CI-gated auto-deploy fields. If they are absent in the created service, set **Settings → Health Check Path** to `/health` and **Settings → Auto-Deploy** to **After CI Checks Pass** in the Render Dashboard. Keep auto-deploy disabled until both settings and the required secrets are configured.
