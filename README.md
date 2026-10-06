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
```

## データと fixture

純計算・境界値・fixture API のテストは固定データを使います。バックエンドの全量 `pytest` は Yahoo へのネットワーク接続が必要です。Task 4 の決定性 fixture は `backend/app/data/fixtures/task4_core.json` に同梱され、`app.data.fixtures.load_fixture("task4_core")` から provider-neutral な `DataSnapshot` と取引日、行情、宏观ケースを読み込めます。fixture の内容から SHA-256 指紋を計算し、`RunSnapshot.dataFingerprint` に保存できます。

外部 notebook の出典ハッシュと安定キーへの入力対応は [`docs/fixtures/notebook-mapping.md`](docs/fixtures/notebook-mapping.md) と JSON マニフェストに記録しています。アプリケーションの実行時に notebook パスを読み込むことはありません。実データの回帰は全量 `pytest` に含まれます。接続だけを確認する場合は `--live` を付けた単独 smoke も使えます。

アーキテクチャ、fixture の更新手順、live smoke と通常の検証コマンドは [`docs/development.md`](docs/development.md) を参照してください。通常のバックテスト実行では Yahoo から標的の日足データと有効な指数/金利データを取得します。外部ネットワーク接続はユーザーが実行を開始した後に行います。現在の製品版では PE/ETF 持分の評価と SEC データ取得を提供せず、SEC 連絡先の設定は不要です。

## License and publication

Copyright © 2026 Ronny Yang. This project is available under the [MIT License](LICENSE).
The hosted shared build sets `noindex, nofollow` and does not assume a public product hostname. Revisit the robots metadata, canonical URL, sitemap and translated metadata before a public launch.
The optional Render deployment is for a trusted shared audience: one Python web service in Singapore, one instance, in-memory runs, and shared HTTP Basic Auth. It does not provide per-user accounts or durable run storage. Follow [`docs/deploy/render.md`](docs/deploy/render.md) for the service settings, build/start commands, and limitations. Store the shared password as a Render secret; do not commit it.
The optional 20% tax model deducts tax on each profitable sale using average holding cost including fees. Losses do not offset gains, and unsold holdings are not taxed. It is a simplified simulation rather than a regional tax calculation.
