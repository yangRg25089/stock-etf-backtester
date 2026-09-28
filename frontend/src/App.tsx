function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="eyebrow">LOCAL BACKTESTER</p>
        <h1>Stock ETF Backtester</h1>
        <p className="intro">
          FastAPI と React/TypeScript で動く、ローカル専用のバックテストワークスペースです。
        </p>
      </header>

      <section className="status-card" aria-labelledby="status-heading">
        <div>
          <p className="eyebrow">SYSTEM STATUS</p>
          <h2 id="status-heading">準備完了</h2>
          <p>バックエンドとフロントエンドの開発環境を起動できます。</p>
        </div>
        <span className="status-pill" role="status">
          READY
        </span>
      </section>
    </main>
  );
}

export default App;
