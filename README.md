# Stock ETF Backtester

本リポジトリは、ローカルまたは公開の単一 Render Web Service で動作する株式・ETF の履歴バックテストアプリです。認証は不要です。ローカル開発では FastAPI バックエンドと React/TypeScript フロントエンドを別プロセスで起動し、Render では FastAPI が React の production build も配信します。アプリの起動と純計算の決定性テストは外部ネットワークへ接続しません。バックテストを実行すると Yahoo からデータを取得します。バックエンドの全量テストにも実際の QQQ/VIX 取得を検証する回帰テストが含まれます。証券口座や注文には接続しません。

## 前提環境

- Python 3.11（3.11 以上 3.13 未満）
- Node.js 22 以上、npm 12 以上

## 開発サーバー

バックエンド（`http://127.0.0.1:8000`）：

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
uvicorn app.main:app --reload
```

`GET /health` が `{"status":"ok"}` を返せば起動完了です。

フロントエンド（`http://127.0.0.1:5173`、別ターミナル）：

```bash
cd frontend
npm install
npm run dev
```

## 検証コマンド

バックエンドでは仮想環境を有効にした状態で実行します。

```bash
cd backend
pytest
ruff check .
ruff format --check .
mypy app
```

フロントエンドでは次を実行します。

```bash
cd frontend
npm test
npm run typecheck
npm run lint
npm run build
npm run test:production-smoke
npm run test:e2e
npm run test:e2e:live
```

## データと fixture

純計算・境界値・fixture API のテストは固定データを使います。バックエンドの全量 `pytest` は Yahoo へのネットワーク接続が必要です。Task 4 の決定性 fixture は `backend/app/data/fixtures/task4_core.json` に同梱され、`app.data.fixtures.load_fixture("task4_core")` から provider-neutral な `DataSnapshot` と取引日、行情、宏观ケースを読み込めます。fixture の内容から SHA-256 指紋を計算し、`RunSnapshot.dataFingerprint` に保存できます。

公開計算機との実データ校準値は `backend/tests/fixtures/`、ブラウザーの作業画面基準は `frontend/e2e/fixtures/` に含まれます。全量 `pytest` は実際の Yahoo QQQ/VIX データを検証します。アプリケーションの実行時に外部 notebook は読み込みません。

通常のバックテスト実行では Yahoo から標的の日足データと有効な指数/金利データを取得します。外部ネットワーク接続はユーザーが実行を開始した後に行います。現在の製品版では PE/ETF 持分の評価と SEC データ取得を提供せず、SEC 連絡先の設定は不要です。

## Render configuration

Use one **Python Native Web Service**, branch `main`, region **Singapore**, plan **Free**, and exactly **one instance**. No database, disk, worker or cron is required. Runs are held in one process and disappear on restart or deployment. Browser strategy preferences remain available; each tab restores only its own active run ID from sessionStorage.

Build command:

```bash
python -m pip install ./backend && cd frontend && npm ci --include=dev && npm run build
```

Start command:

```bash
uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $PORT --workers 1 --no-proxy-headers --limit-concurrency 64 --timeout-keep-alive 5
```

Set `STOCK_ETF_BACKTESTER_SERVE_FRONTEND=1`, `STOCK_ETF_BACKTESTER_FRONTEND_DIR=frontend/dist` and `STOCK_ETF_BACKTESTER_TRUST_RENDER_PROXY=1`. No authentication secrets are needed. The proxy flag takes effect only when Render also sets `RENDER=true`; the application uses the Cloudflare-overwritten `CF-Connecting-IP` and ignores `X-Forwarded-For`. Keep Uvicorn proxy rewriting disabled. Use exactly one process and instance so quotas are shared. Missing or malformed edge IPs share a conservative fallback quota. Local requests ignore forwarding headers.

The public build allows **5 run submission attempts per IP per rolling 60 seconds**, **240 API requests**, and **20 instrument metadata requests**. A service-wide quota of **20 run submissions per 60 seconds** also applies. Invalid submissions and idempotent retries count as attempts. A rejected request returns HTTP 429, `Retry-After`, and a localized waiting time without creating a run; saved results and ordinary controls remain accessible. API write bodies are capped at 1 MiB. Counters are bounded, expire lazily, and reset on restart. Robots directives discourage indexing, and user agents identifying themselves as bots, spiders, crawlers or Scrapy are refused; `/robots.txt` and `/health` remain available. The executor also admits at most **8 running and queued jobs combined**. When full, a new run receives a localized HTTP 503 without a run record; retries of an accepted idempotency key still return that run. Cancelled jobs occupy their slot until drained by the executor. These are basic abuse controls for one instance. Full results and search candidate details are stored in a process-owned temporary SQLite database, rather than retained as Python objects. Retention is limited to **128 run reservations** and **512 MiB total disk budget**, including rollback journal space and a reserve for failure/cancellation updates. At capacity, new submissions receive HTTP 503; existing results and idempotent retries remain available. An oversized running search fails with a localized storage diagnostic without evicting older results. Shutdown drains cancelled work and removes the temporary database; restart or deployment clears results. This disk budget does not cap the working memory of an active calculation.

Set the health check path to `/health`. Keep automatic deployment disabled and deploy manually after the verification commands above pass, including the real Yahoo and production browser flows. Repository-hosted Actions workflows are excluded by the publication policy. Runtime version files pin Python 3.11 and Node 22; Render supplies `PORT`.

## Themes

Appearance defaults to the operating system. One Light/Dark button saves a manual preference in localStorage; there is no Auto button or theme list. Light preserves the original Classic blue/orange palette. Shared semantic tokens define both appearances; strategy identity and return colors remain independent.

## Phone layout

The header keeps the brand, run/reset controls and a menu button on one row, with selected strategies on one scrolling row below. Stop appears beside run/reset during execution. The three-line menu unfolds export/import and labeled display preferences in vertical rows; Escape or an outside click closes it. Shortcuts also work while the menu is closed: import previews open separately, and file errors reveal the menu.

Click or use Enter/Space on a header strategy to choose its details; selected curves stay visible. Choices are disabled during execution and retain 44px touch targets.

The workbench uses 8px outer margins with settings above results on phones. Strategy lists grow with content up to a screen-dependent maximum, and boundary scrolling continues to the page. Result actions and chart controls stay compact; trade headings share a row with their expand button.

## License and publication

Copyright © 2026 Ronny Yang. This project is available under the [MIT License](LICENSE).
The hosted public build sets `noindex, nofollow` and disallows crawling. It does not provide per-user accounts or durable run storage. Local design notes, task records and agent instructions are excluded from the published repository.
The optional 20% tax model deducts tax on each profitable sale using average holding cost including fees. Losses do not offset gains, and unsold holdings are not taxed. It is a simplified simulation rather than a regional tax calculation.


## Result appearance and saved fills

Appearance follows the system until Light/Dark is clicked, then keeps the saved manual preference. Light retains the original Classic colors. Result details show performance and period tables first, optional costs/search next, and trades last. Expanded tables keep their controls and column headers visible. On phones, pinch within a chart to zoom the date range, drag horizontally to pan, or hold for one second to inspect saved daily readings. Vertical swipes scroll the page; there are no Inspect/Pan mode or magnifier controls.

Trade CSV appends `totalAssetAfter`: whole-account assets immediately after each fill, valued at that day's saved simulation price, with fees/tax already reflected in cash. Old missing values remain unavailable. Zero tax is shown as “—”; explicit all-zero costs and tax columns are hidden only in visible presentation. CSV retains raw zero values.

Run complete functional and UI acceptance locally. After deployment, confirm only the deployed revision and `/health`.
