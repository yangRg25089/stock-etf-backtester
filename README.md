# Stock ETF Backtester

本リポジトリは、ローカルで動作する株式・ETF の履歴バックテストアプリです。V1 は FastAPI バックエンドと React/TypeScript フロントエンドを別プロセスで起動します。外部ネットワークや証券口座への接続は行いません。

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
npm run lint
npm run typecheck
npm run build
```

## データと fixture

通常の起動・テストは外部ネットワークに依存しません。Task 4 の決定性 fixture は `backend/app/data/fixtures/task4_core.json` に同梱され、`app.data.fixtures.load_fixture("task4_core")` から provider-neutral な `DataSnapshot` と取引日・会社事実・ETF 持分ケースを読み込めます。fixture の内容から SHA-256 指紋を計算し、`RunSnapshot.dataFingerprint` に保存できます。

外部 notebook の出典ハッシュと安定キーへの入力対応は [`docs/fixtures/notebook-mapping.md`](docs/fixtures/notebook-mapping.md) と JSON マニフェストに記録しています。アプリケーションの実行時に notebook パスを読み込むことはありません。live データ確認は、後続の明示的な smoke 検査として決定性テストから分離します。
