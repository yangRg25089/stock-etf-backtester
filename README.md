# Stock ETF Backtester

本リポジトリは、ローカルで動作する株式・ETF の履歴バックテストアプリです。V1 は FastAPI バックエンドと React/TypeScript フロントエンドを別プロセスで起動します。アプリの起動と純計算の決定性テストは外部ネットワークへ接続しません。バックテストを実行すると Yahoo からデータを取得します。バックエンドの全量テストにも実際の QQQ/VIX 取得を検証する回帰テストが含まれます。証券口座や注文には接続しません。

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
npm run test:e2e
```

## データと fixture

純計算・境界値・fixture API のテストは固定データを使います。バックエンドの全量 `pytest` は Yahoo へのネットワーク接続が必要です。Task 4 の決定性 fixture は `backend/app/data/fixtures/task4_core.json` に同梱され、`app.data.fixtures.load_fixture("task4_core")` から provider-neutral な `DataSnapshot` と取引日・会社事実・ETF 持分ケースを読み込めます。fixture の内容から SHA-256 指紋を計算し、`RunSnapshot.dataFingerprint` に保存できます。

外部 notebook の出典ハッシュと安定キーへの入力対応は [`docs/fixtures/notebook-mapping.md`](docs/fixtures/notebook-mapping.md) と JSON マニフェストに記録しています。アプリケーションの実行時に notebook パスを読み込むことはありません。実データの回帰は全量 `pytest` に含まれます。接続だけを確認する場合は `--live` を付けた単独 smoke も使えます。

アーキテクチャ、fixture の更新手順、PE の既知制限、live smoke と通常の検証コマンドは [`docs/development.md`](docs/development.md) を参照してください。通常のバックテスト実行では Yahoo から標的の日足データと有効な指数/金利データを取得します。外部ネットワーク接続はユーザーが実行を開始した後に行います。個別株の履歴 PE は SEC 取得経路を接続済みで、MSFT の実データ検証に合格しています。ETF の履歴 PE は未接続で、証拠が不足する対象には正確なデータ不可診断を返します。SEC の利用には本機の連絡先設定が必要です。
