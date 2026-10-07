# Stock ETF Backtester

本リポジトリは、ローカルまたは共有 Basic Auth で保護された単一 Render Web Service で動作する株式・ETF の履歴バックテストアプリです。ローカル開発では FastAPI バックエンドと React/TypeScript フロントエンドを別プロセスで起動し、Render では FastAPI が React の production build も配信します。アプリの起動と純計算の決定性テストは外部ネットワークへ接続しません。バックテストを実行すると Yahoo からデータを取得します。バックエンドの全量テストにも実際の QQQ/VIX 取得を検証する回帰テストが含まれます。証券口座や注文には接続しません。

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
uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'
```

Set `STOCK_ETF_BACKTESTER_SERVE_FRONTEND=1` and `STOCK_ETF_BACKTESTER_FRONTEND_DIR=frontend/dist`. Store `APP_BASIC_AUTH_USERNAME` and `APP_BASIC_AUTH_PASSWORD` as Render secrets. Both must be provided together; `/health` is public and the frontend, assets and API require authentication. Set the health check path to `/health`. Keep automatic deployment disabled and deploy manually after the verification commands above pass, including the real Yahoo and production browser flows. Repository-hosted Actions workflows are excluded by the publication policy. Runtime version files pin Python 3.11 and Node 22; Render supplies `PORT`.

## Themes

The dropdown offers **Classic**, **Wine**, **Navy**, **Blush** and **Forest**. Classic preserves the original blue/orange palette; the other four use palettes selected from [Color Hunt popular](https://colorhunt.co/palettes/popular). Semantic colors adapt text contrast while strategy identity colors and return colors remain independent. Theme preferences are saved locally.

On phones, the workbench uses 8px outer margins, separate configuration/results views, and a single scrolling row of selected strategies. Click or use Enter/Space on a header strategy to choose its details; the selected curves stay visible. These choices are disabled during execution and retain 44px touch targets. Charts and saved readings fit the screen; tables scroll within their own containers.

## License and publication

Copyright © 2026 Ronny Yang. This project is available under the [MIT License](LICENSE).
The hosted shared build sets `noindex, nofollow` and does not assume a public product hostname. Revisit the robots metadata, canonical URL, sitemap and translated metadata before a public launch.
The optional Render deployment is for a trusted shared audience. It does not provide per-user accounts or durable run storage. Store the shared password as a Render secret; do not commit it. Local design notes, task records and agent instructions are excluded from the published repository.
The optional 20% tax model deducts tax on each profitable sale using average holding cost including fees. Losses do not offset gains, and unsold holdings are not taxed. It is a simplified simulation rather than a regional tax calculation.
