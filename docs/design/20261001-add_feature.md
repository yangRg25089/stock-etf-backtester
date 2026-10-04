可以。按照你现在最终确认的定位，我会把后续路线收敛成一个很明确的版本：

> **纯本地 Web 回测工具。**
> 不做账号、云端同步、运行历史数据库、收藏库等持久化功能。  
> 浏览器只用 `localStorage` 保存“上一次实际执行的策略配置”；回测结果默认只存在当前页面内存。需要长期保存时，通过 **Export / Import 文件** 完成。

你当前 `tasks/todo.md` 已经做到 Task 97，所以我建议直接从 **阶段 23 / Task 98** 继续。下面这版基本可以直接整理进后续 `tasks/plan.md`。

---

# 一、先冻结新的产品边界

目标运行架构调整为：

```text
Browser
│
├─ 当前编辑 Draft                 内存
├─ 当前 Run Result                内存
├─ Imported Result                内存
│
└─ localStorage
      └─ 仅保存 lastRunStrategy
           ├─ shared settings
           └─ strategies

                │
                ▼

FastAPI
│
├─ Catalog / Validation
├─ Yahoo / SEC Data
├─ Signals
├─ Ledger
├─ Metrics
├─ Grid Search
│
└─ InMemoryRunStore
      ├─ 当前运行
      ├─ SSE progress
      ├─ 临时候选结果
      └─ 进程结束全部消失


长期保存
│
├─ Strategy Export JSON
└─ Backtest Export JSON
```

明确不做：

```text
× SQLite
× Run History
× 历史结果列表
× 用户账号
× 云同步
× 收藏/Tag/备注数据库
× localStorage 保存回测结果
```

页面刷新后的规则也建议直接定死：

```text
普通刷新
→ 恢复“上一次实际运行的策略”
→ 不恢复上一次结果

运行过程中刷新
→ 如果 FastAPI 进程还活着，可重新连接当前 active run
→ 完成后的旧结果不主动恢复

后端重启
→ Run 全部消失
→ 浏览器仍保留上次运行策略
```

这个边界最干净。

---

# 二、阶段 23：本地 Web Tool 架构收敛

这是下一轮最先做的。

## Task 98：彻底移除 SQLite 持久化

### 删除

后端删除：

```text
backend/app/runs/sqlite_store.py
backend/tests/runs/test_sqlite_store.py
```

`backend/app/main.py` 删除：

```python
SQLiteRunStore
_run_store_path()
STOCK_ETF_BACKTESTER_RUN_STORE_PATH
```

从：

```python
RunManager(
    store=SQLiteRunStore(...),
)
```

改为：

```python
RunManager(
    store=InMemoryRunStore(),
)
```

同时删除文档中：

```text
SQLite restart recovery
服务重启恢复 Run
SQLite candidate persistence
run database path
```

相关说明与测试。

### 不删除

保留：

```text
InMemoryRunStore
Idempotency
GET /runs/{id}
SSE
Stop Run
Grid candidate temporary store
CSV export
```

这些本身和持久化没有冲突。

### 验收

```text
✓ FastAPI restart 后 run 不存在
✓ 页面运行期间结果正常
✓ SSE 正常
✓ Stop 正常
✓ Grid candidate 正常
✓ CSV 正常
✓ 不产生 .local/runs.sqlite3
```

---

# Task 99：删除「上一次结果恢复」机制

当前前端还有：

```text
fetchLatestRun()
GET /runs/latest
restoreLatestRun()
resultVisibility.ts
backtester.dismissedRunId
```

这些都是为了历史 Run 恢复而存在。

建议删除：

```text
GET /api/v1/runs/latest
RunService.get_latest_run()
RunStore.get_latest()
fetchLatestRun()
readDismissedRunId()
rememberDismissedRun()
frontend/src/features/runs/resultVisibility.ts
```

以及对应测试。

但是增加一个更精确的：

```text
GET /api/v1/runs/active
```

只返回：

```text
queued
loading
running
```

中的当前 Run。

用途只有一个：

> 浏览器在“运行过程中”被刷新后，可以重新连 SSE。

不会返回已经完成的历史结果。

这样：

```text
刷新完成结果页面
→ 结果消失

刷新正在执行页面
→ 自动重新连接当前运行
```

正好符合 Web Tool 的定位。

---

# Task 100：localStorage 只保存「上一次运行策略」

建议 key：

```text
stock-etf-backtester.last-run-strategy.v1
```

数据：

```json
{
  "schemaVersion": 1,
  "catalogVersion": "catalog-v6",
  "savedAt": "2026-10-03T22:00:00+09:00",
  "draft": {
    "shared": {},
    "strategies": []
  }
}
```

注意一点：

### 不要在用户编辑时实时保存

应该：

```text
用户编辑
→ 不写 localStorage

点击 Run
→ Validation 成功
→ Run 被接受
→ 保存本次提交的 Frozen/Draft 配置
```

这样它才真正代表：

> **上一次运行的策略**

而不是：

> 上一次乱改到一半的 Draft。

页面初始化：

```text
Catalog 加载
       ↓
读取 last-run-strategy
       ↓
schema migration
       ↓
基本结构 validation
       ↓
成功 → 作为当前 Draft
失败 → Default Draft
```

不保存：

```text
× Result
× Run ID
× Chart selection
× dialog 开关
× tab
× zoom
× selected strategy
× language
```

---

# Task 101：策略 / 结果 Export & Import

我建议做两个文件类型。

### Strategy Package

```text
*.strategy.json
```

结构：

```json
{
  "format": "stock-etf-backtester",
  "schemaVersion": 1,
  "type": "strategy",
  "exportedAt": "...",
  "catalogVersion": "...",
  "draft": {}
}
```

用途：

```text
保存策略
分享策略
换电脑
以后重新加载
```

---

### Backtest Package

```text
*.backtest.json
```

结构：

```json
{
  "format": "stock-etf-backtester",
  "schemaVersion": 1,
  "type": "backtest",
  "exportedAt": "...",

  "engineVersion": "...",
  "catalogVersion": "...",

  "config": {},
  "result": {},
  "candidateDetails": {},
  "dataProvenance": {}
}
```

它必须使用**运行时冻结配置**，不能使用当前 Draft。

也就是说：

```text
运行时：
VIX = 25

运行完以后用户改成：
VIX = 30

Export Result
        ↓
必须仍然导出：
VIX = 25
```

保持你现在已有的 Draft / Result isolation。

---

# Task 102：Import 设计

右上角可以增加：

```text
⋯

策略をエクスポート
結果をエクスポート
インポート
```

Import 后先 Preview：

```text
インポート

QQQ
2020-01-01 ～ 2026-10-01

戦略
────────────────
VIX シグナル積立
MA トレンド

結果
保存済み結果あり

[キャンセル]       [読み込む]
```

Strategy Import：

```text
→ 替换当前 Draft
→ 清除当前 Result
```

Backtest Import：

```text
→ 加载被冻结的 strategy 为当前 Draft
→ 同时显示导入的 Result
→ Result 标记为 imported
```

例如顶部轻量提示：

```text
Imported Result
2026-10-03 に保存された結果
```

修改策略时：

```text
Imported Result 不改变
```

重新执行后：

```text
Imported Result → Live Result
```

---

# Task 103：Import schema migration 与安全校验

这个不要省。

不能直接：

```ts
JSON.parse();
setWorkspace();
```

需要：

```text
Import File
   ↓
文件尺寸检查
   ↓
format 检查
   ↓
schemaVersion 检查
   ↓
migration
   ↓
runtime validation
   ↓
Catalog compatibility
   ↓
加载
```

规则：

```text
schemaVersion < current
→ migration

schemaVersion == current
→ load

schemaVersion > current
→ 拒绝并提示版本过新
```

还需要限制：

```text
文件最大大小
strategies 最大数量
conditions 最大深度
candidate 数量
字符串长度
```

防止一个异常 JSON 把页面卡死。

---

# 三、阶段 24：运行流程和现有 UX 修正

## Task 104：Run 提交流程改成真正异步

当前 `RunManager.submit_run()` 最大的问题仍然存在：

```text
POST /runs
 ↓
先加载 Yahoo 数据
 ↓
建立 snapshot
 ↓
queue
 ↓
才返回 202
```

建议改成：

```text
POST /runs
 ↓
验证配置
 ↓
冻结提交配置
 ↓
生成 runId
 ↓
保存 queued
 ↓
立即 202

后台 worker
 ↓
loading
 ↓
Yahoo Data
 ↓
冻结 Data Context
 ↓
running
 ↓
completed
```

这样点击：

```text
▶ Run
```

以后 UI 可以立刻：

```text
Queued
↓
Loading market data
↓
Running 1 / 5
```

Stop 也真正从最开始就有效。

### Contract 建议

把当前：

```text
RunSnapshot
├ config
├ catalogVersion
├ engineVersion
├ dataFingerprint
└ dataProvenance
```

拆开：

```text
RunSnapshot
├ config
├ catalogVersion
├ engineVersion
├ submissionFingerprint
└ createdAt

RunDataContext
├ dataFingerprint
└ dataProvenance
```

因为数据还没下载之前，不能要求 `dataFingerprint` 已经存在。

---

# Task 105：运行按钮提前知道“能不能运行”

目前运行按钮的 availability 太浅，真正 Validation 主要发生在点击以后。

改为：

```text
Draft change
   ↓
300ms debounce
   ↓
POST /config/validate
   ↓
RunAvailability
```

例如直接：

```text
▶ Run
```

不可执行时 disabled，并 tooltip：

```text
VIX threshold が必要です
```

或者：

```text
PE data source is unavailable
```

点击诊断可以直接：

```text
打开对应 Strategy Dialog
→ 聚焦错误字段
```

你现有 `fieldActionForDiagnostic()` 已经有基础。

---

# Task 106：Run lifecycle 全状态统一

明确统一：

```text
queued
loading
running
completed
completed_with_warning
unavailable
failed
cancelled
```

禁止 frontend/backend 再各自发明新的状态。

UI：

```text
Run button
queued/loading/running → spinner

Stop
queued/loading/running → available

completed
→ 不显示成功大卡片

warning/error
→ Result Details 内显示
```

维持你现在已经收敛后的低噪声设计。

---

# 四、阶段 25：回测可解释性

这是我认为下一批最有价值的产品功能。

# Task 107：Trade Explain 数据契约

现在 `Trade` 已经有：

```text
date
side
reason
quantity
price
cashAmount
signalId
```

`SignalEvaluation` 已经有：

```text
conditionId
conditionKind
observedValue
observedUnit
sourceSymbol
triggeredSignalIds
sellRatio
```

基础很好。

建议 Trade 再增加可选：

```text
cashBefore
cashAfter

quantityBefore
quantityAfter

executionBasePrice
executionPrice
```

以后交易成本加进来以后会非常有用。

---

# Task 108：交易解释 UI

点击：

```text
图上的 BUY / SELL marker
```

或者交易表行：

```text
2025-04-07 BUY
```

打开侧边 Popover / Drawer：

```text
2025-04-07
BUY $1,200

触发条件
──────────────────

VIX
31.42 ≥ 25
✓ TRUE

RSI
27.8 ≤ 30
✓ TRUE

组合
VIX AND RSI
✓ TRUE

成交
──────────────────

基准价格      $445.20
成交价格      $445.20
数量          2.695

现金
$1,450 → $250

持仓
4.20 → 6.895
```

卖出：

```text
卖出比例       50%
```

也显示。

---

# Task 109：Unexecuted Signal Explain

你现在已经保存：

```text
UnexecutedSignal
```

也应该能解释：

```text
2025-12-31
VIX signal triggered

未执行：
回测期间内没有下一交易日
```

这对确认“为什么没买”同样重要。

---

# Task 110：Data Information Dialog

不做大型新页面。

右上角：

```text
ⓘ Data
```

打开 Dialog：

```text
QQQ

Provider
Yahoo Finance

Currency
USD

Requested
2020-01-01 → 2026-10-03

Actual
2020-01-02 → 2026-10-02

Market sessions
1,702

Price basis
Simulation   Adjusted Close
Valuation    Close
```

指标来源：

```text
VIX
^VIX
Coverage 100%

Rate
^TNX
Coverage 99.8%
```

异常：

```text
PE
Unavailable
SEC live source is not configured
```

保持“信息工具”，而不是数据管理系统。

---

# 五、阶段 26：Performance Analysis

# Task 111：新增绩效指标

建议新增：

```text
Annualized Return
Annualized Volatility
Sharpe Ratio
Sortino Ratio
Calmar Ratio

Maximum Drawdown Duration
Recovery Duration

Buy Count
Sell Count
Turnover
Average Cash Ratio
```

这里需要注意：

### 定投策略不要直接拿普通 CAGR 算

因为存在持续注资。

你现在已经有：

```text
unitNav
```

所以：

```text
Annualized Return
Annualized Volatility
Sharpe
Sortino
```

全部基于：

> **cash-flow adjusted unit NAV**

而不是 raw totalAsset。

XIRR继续代表：

> 投资者真实现金流收益。

两者意义不同，不要混。

---

# Task 112：Risk-free Rate

Sharpe / Sortino 需要定义风险无风险收益。

新增共享 Analysis 参数：

```text
Risk-free annual rate

Default: 0%
```

不要偷偷假定一个用户不知道的值。

结果说明：

```text
Sharpe
Risk-free rate: 0.00%
```

---

# Task 113：年度收益表

增加：

```text
Performance
```

Tab。

例如：

| Year | Strategy |  Price |    DCA |
| ---- | -------: | -----: | -----: |
| 2021 |   +24.3% | +27.4% | +25.8% |
| 2022 |   -18.1% | -32.6% | -27.5% |
| 2023 |   +39.1% | +54.9% | +48.2% |

同样基于：

```text
unit NAV / benchmark return
```

---

# Task 114：月度收益 Heatmap

例如：

```text
       Jan    Feb    Mar    Apr   ...
2024  +2.1   +4.2   -1.3   +5.1
2025  -1.4   +3.8   +2.9   -2.2
```

功能：

```text
hover → exact %
positive / negative visual distinction
keyboard focus
```

不需要增加外部 chart dependency，CSS grid 就够。

---

# Task 115：Drawdown Episodes

不仅显示最大回撤数字。

显示：

```text
Worst Drawdowns

1.
Peak       2022-01-03
Bottom     2022-10-14
Drawdown   -34.51%
Recovered  2023-05-18
Duration   500 days

2.
...
```

这比只看：

```text
Max DD = 34.51%
```

有价值得多。

---

# 六、阶段 27：更加真实的交易模拟

# Task 116：Execution Assumptions 参数

Shared Settings 新增：

```text
Execution
────────────────────

Commission
0.00 USD / trade

Slippage
0.00 %

Bid-Ask Spread
0.00 %

Fractional Shares
ON
```

暂时不要做：

```text
× Tax
× Exchange-specific fee schedule
× Margin
× Leverage
```

避免迅速复杂化。

---

# Task 117：Ledger 真正使用交易成本

买入：

```text
executionPrice =
marketPrice
× (1 + slippage + spread/2)
```

卖出：

```text
executionPrice =
marketPrice
× (1 - slippage - spread/2)
```

再计算：

```text
commission
```

而且：

> Strategy 和 DCA / Lump Sum benchmark 必须使用同一套 execution assumptions。

否则比较不公平。

---

# Task 118：Fractional Share

ON：

```text
2.43821 shares
```

OFF：

```text
floor to integer quantity
```

剩余资金：

```text
留在 cash
```

必须反映在：

```text
DailyAsset
Trade
Metrics
CSV
Trade Explain
```

---

# Task 119：新增交易成本结果

Result 增加：

```text
Total Commission
Slippage Cost
Spread Cost
Total Trading Cost
```

Performance 可显示：

```text
Gross result
Net result
Cost impact
```

但主 KPI 仍然使用真实净值。

---

# 七、阶段 28：Robustness Lab

这是最大的分析功能扩展。

# Task 120：Train / Test Split

Grid Search 增加模式：

```text
Optimization

○ Full Period

● Train / Test
```

例如：

```text
Train
2010-01-01 → 2020-12-31

Test
2021-01-01 → 2026-10-01
```

参数搜索：

```text
只在 Train 排名
```

然后同一参数：

```text
在 Test 重跑
```

显示：

| Candidate | Train XIRR | Test XIRR |
| --------- | ---------: | --------: |
| VIX 25    |      18.2% |     16.1% |
| VIX 28    |      20.3% |     15.8% |
| VIX 30    |      22.1% |      8.4% |

用户马上能发现：

```text
VIX 30
Train 很漂亮
Test 崩掉

→ overfitting
```

---

# Task 121：参数 Heatmap

当选择两个 search dimensions：

```text
X = VIX threshold
Y = RSI threshold
```

显示：

```text
          RSI
         25    30    35

VIX 20  13.2  14.1  13.6
    25  15.8  18.3  16.9
    30  14.6  16.8  12.2
```

可切：

```text
XIRR
Sharpe
Calmar
Max Drawdown
```

---

# Task 122：Parameter Stability

不要只突出：

```text
最佳参数 = VIX 28
```

同时显示相邻参数。

例如：

```text
25 → 17.9%
26 → 18.1%
27 → 18.2%
28 → 18.3%
29 → 18.1%
30 → 17.8%
```

这是：

> 稳定区域

而如果：

```text
27 → 11%
28 → 24%
29 → 10%
```

就是：

> 高度敏感 / 可能过拟合。

这个功能非常适合你已有 Grid Search。

---

# Task 123：Walk-forward

第二阶段再做真正 Walk-forward：

```text
Train 5Y
Test 1Y

2010-2014 → 2015
2011-2015 → 2016
2012-2016 → 2017
...
```

每一个窗口：

```text
重新选择参数
↓
只在下一段 Test 使用
```

最后拼成：

```text
Out-of-sample Equity Curve
```

这才是真正高级的 Robustness。

---

# 八、阶段 29：小 UX 功能

这些成本不高。

# Task 124：Strategy Duplicate

策略卡：

```text
⋯

编辑
复制
重置
删除
```

复制：

```text
Custom #1
→ Custom #2
```

所有条件深拷贝。

---

# Task 125：Reset Strategy

固定策略：

```text
恢复该 Preset 默认值
```

Custom：

```text
恢复初始 Custom Template
```

弹确认：

```text
現在の設定を初期値に戻しますか？
```

---

# Task 126：Keyboard Shortcut

建议：

```text
Ctrl/Cmd + Enter
→ Run

Ctrl/Cmd + E
→ Export

Ctrl/Cmd + I
→ Import

Escape
→ Close Dialog
```

输入框内需要正确避免冲突。

---

# Task 127：Desktop Advanced Inspector

这个我放低优先级。

目前：

```text
策略卡 → Dialog
```

继续作为默认。

可增加：

```text
Advanced editing
```

桌面 ≥1280：

```text
Strategies | Result | Inspector
```

用户不断：

```text
VIX 25
↓
VIX 28
↓
VIX 30
```

时不用反复打开 dialog。

手机仍然 Dialog。

这是专业用户效率功能，不需要马上做。

---

# 九、阶段 30：代码结构收敛

在加这么多功能以前，我建议安排一次明确的技术任务。

## Task 128：拆 `App.tsx`

当前 App 已经承担：

```text
Catalog
Run lifecycle
SSE
Stop
Validation
Responsive
Dialog
Diagnostics navigation
Result restore
Workspace
```

建议拆：

```text
app/
  App.tsx

hooks/
  useCatalog.ts
  useRunController.ts
  useActiveRunRecovery.ts
  useLastRunStrategy.ts

features/transfer/
  ImportExportMenu.tsx
  importModel.ts
  exportModel.ts
  migrations.ts
```

App 回归组合层。

---

# Task 129：拆 ResultsCharts.tsx

现在文件已经很大。

建议：

```text
results/chart/

ChartCanvas.tsx
ChartAxes.tsx
ChartDateAxis.tsx
ChartSeries.tsx
ChartMarkers.tsx
ChartCursor.tsx
ChartControls.tsx
chartScale.ts
chartModel.ts
useChartInteraction.ts
```

**不要换图表库。**

你现在自己的图已经有：

```text
同步 zoom
drag
cursor
keyboard
trade marker
multi-series
mobile
```

换 Recharts/ECharts 反而很可能退步。

只做内部拆分。

---

# Task 130：拆 CSS / i18n

当前大 CSS 和 messages 开始不方便维护。

建议：

```text
styles/
  tokens.css
  layout.css
  dialogs.css
  strategies.css
  results.css
  charts.css
  responsive.css
```

i18n：

```text
i18n/
  ja/
    common.ts
    strategies.ts
    results.ts
  zh/
    ...
```

Machine keys 不改变。

---

# 十、阶段 31：CI / 正式 V1 基线

这个是工程侧必须做。

## Task 131：GitHub Actions

PR：

```text
Backend deterministic
pytest -m "not live"
ruff
mypy

Frontend
npm test
typecheck
lint
build

Playwright critical
```

Yahoo live：

```text
workflow_dispatch
或 scheduled
```

不要让 Yahoo 网络波动阻塞每一个 PR。

---

# Task 132：清理 main / release

现在完整产品仍主要在：

```text
feature/remaining-v1-tasks
```

而默认 `main` 还是旧系统。

最终：

```text
feature
↓
完整 RV
↓
main
↓
tag v1.0.0
```

然后以后：

```text
v1.1
Import / Export + local runtime

v1.2
Explainability

v1.3
Performance

v1.4
Execution Cost

v1.5
Robustness
```

---

# 十一、最终“删除项”总表

为了开发时不会忘，单独列一次。

| 现有内容                              | 处理                       |
| ------------------------------------- | -------------------------- |
| `SQLiteRunStore`                      | **删除**                   |
| `sqlite_store.py`                     | **删除**                   |
| SQLite tests                          | **删除**                   |
| `STOCK_ETF_BACKTESTER_RUN_STORE_PATH` | **删除**                   |
| `.local/runs.sqlite3`                 | **删除**                   |
| 服务重启恢复历史结果                  | **删除**                   |
| `/runs/latest`                        | **删除**                   |
| `fetchLatestRun()`                    | **删除**                   |
| App `restoreLatestRun`                | **删除**                   |
| `resultVisibility.ts`                 | **删除**                   |
| `dismissedRunId` localStorage         | **删除**                   |
| SQLite restart E2E                    | **删除**                   |
| CSV Export                            | **保留**                   |
| SSE                                   | **保留**                   |
| Stop                                  | **保留**                   |
| Grid Search                           | **保留并扩展**             |
| InMemoryRunStore                      | **正式成为 runtime store** |
| Run active recovery                   | **改为 `/runs/active`**    |
| Draft/Result isolation                | **保留**                   |
| Frozen Result Snapshot                | **保留**                   |
| Catalog-driven parameters             | **保留**                   |
| Conditions AND/OR                     | **保留**                   |

---

# 十二、我建议实际执行顺序

不要同时开十几个方向。

我建议严格：

```text
Phase 23
98 → 99 → 100 → 101 → 102 → 103
本地无数据库 + Import/Export

          ↓

Phase 24
104 → 105 → 106
运行生命周期修正

          ↓

Phase 30
128 → 129 → 130
先拆大文件

          ↓

Phase 25
107 → 108 → 109 → 110
Explainability

          ↓

Phase 26
111 → 112 → 113 → 114 → 115
Performance

          ↓

Phase 27
116 → 117 → 118 → 119
Execution Reality

          ↓

Phase 28
120 → 121 → 122 → 123
Robustness

          ↓

Phase 29
124 → 127
UX Enhancement

          ↓

Phase 31
131 → 132
CI / Release
```

其中我会稍微调整一个点：**CI 最好实际上在 Phase 23 完成后就先建立，而不是等所有功能做完。** 上面 Task 131/132 是最终 release checkpoint，但基础 CI 可以提前建立。

---

## 最终产品形态

做完这一轮后，它不是一个有数据库的投资平台，而会是一个定位非常明确的：

> **Stock / ETF Strategy Backtesting Workbench**

核心流程保持极简单：

```text
打开
 ↓
自动恢复上一次运行策略
 ↓
改参数 / 建策略
 ↓
Run
 ↓
比较结果
 ↓
查看图表
 ↓
查看为什么买卖
 ↓
查看风险/绩效
 ↓
测试参数稳健性
 ↓
需要保存？
 ↓
Export JSON
```

我认为这个方向比继续加“历史管理、账号、数据库”更适合你现在这个项目。它会把复杂度集中在**回测正确性和研究能力**上，而不是 CRUD 和基础设施。
