# 开发与排障

## 当前运行边界

这是本机历史模拟应用。前端只消费 FastAPI 契约；`catalog` 和 `config` 提供目录与验证，`data` 负责供应商适配、规范化和快照，`signals`、`ledger`、`metrics` 与 `search` 负责计算，`runs` 冻结配置并协调独立结果，`export` 只从保存的结果快照导出。

应用启动不访问外部网络。纯计算确定性测试使用固定数据；后端的默认 Yahoo provider 回归测试会实际请求 Yahoo 和交易所日历，覆盖 QQQ 与 `^VIX`、`^VXN`、`^VXD`。用户提交回测后，默认 API provider 调用 Yahoo 获取标的日线及已启用的指数/利率序列；数据先经过现有适配器规范化，再进入快照和回测。当前交易所日历映射覆盖美国 NASDAQ、NYSE、AMEX/ARCA 与 OTC 常用代码；未知交易所会返回未支持诊断。Yahoo 请求失败会返回限流、超时或请求错误诊断。浏览器 E2E 仍使用仓库 fixture provider，`live smoke` 继续作为独立的只读连通性检查。

已提交的 `RunSnapshot.dataProvenance` 冻结来源列表、日历截止日和行情最新报价日。汇总、每日资产、交易、搜索结果四类 CSV 都从这个保存快照附带 `dataSources`、`calendarAsOf`、`marketDataThrough`，导出不读取当前草稿或重新请求数据。`marketDataThrough` 表示行情报价覆盖，不代表宏观或 SEC 数据也更新到该日；这些数据的观察日/公开时间保留在数据快照和诊断中。运行完成日志以结构化字段记录相同来源与日期，不输出配置值或供应商响应。

运行记录由本机 SQLite `RunStore` 保存，默认路径为仓库根目录 `.local/runs.sqlite3`，该目录已加入 Git 忽略规则。可通过 `STOCK_ETF_BACKTESTER_RUN_STORE_PATH` 指定另一文件路径。运行响应、冻结快照和幂等键均持久化；SQLite 私有版本化编码保留冻结参数中的 `Decimal` 类型，旧格式记录依照对应 catalog 参数类型恢复，API 快照 JSON 仍以十进制字符串对外。页面启动时读取最近一次已保存运行；未完成作业经单条 `/api/v1/runs/{runId}/events` SSE 连接恢复进度，结束后只读取一次完整结果。断开页面订阅不会终止服务端运行。服务重启时，仍处于 `queued/loading/running` 的策略会转成带 `runs.interrupted_by_restart` 诊断的 `failed`，已经结束的策略和部分结果保留。

结束日期为“最近完整行情”时，供应商若暂未提供最新已收盘日的有效行情，运行快照将落到最后完整报价日并附来源质量警告；有效回测区间中的缺失 session 仍会报错，系统不会将缺失行情前填或忽略。计算失败诊断包含日中本地化的安全阶段和运行/策略标识；异常消息、内部路径和异常类型仅写入受限服务日志或不写入，不返给前端。

备份时优先使用 SQLite 在线备份接口，例如：

```python
import sqlite3

with sqlite3.connect(".local/runs.sqlite3") as source:
    with sqlite3.connect("runs-backup.sqlite3") as backup:
        source.backup(backup)
```

清除全部运行历史前停止 API 服务，再删除 `.local/runs.sqlite3` 及其 SQLite `-wal`、`-shm` 辅助文件；下次启动会创建空数据库。规范化数据缓存仍只在进程内，最多保留 128 个结果，不保存供应商响应；成功且无错误诊断的快照才会缓存，`refresh=True` 会绕过现有项，自动识别单位的利率不走缓存。缓存键包含供应商、代码、日期、频率、版本、价格口径和上下文指纹，服务重启后缓存会清空。

## 环境与常用命令

Python 需为 3.11（3.11 以上、3.13 以下），Node.js 需为 22 以上，npm 需为 12 以上。

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
python -m pytest
ruff check .
ruff format --check .
mypy app
```

前端检查：

```bash
cd frontend
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

E2E 会自行启动本机 fixture API 和 Vite 临时进程，结束后应释放端口。不要把 E2E 临时服务当作平时启动的 API。

后端全量 `pytest` 包含 `tests/runs/test_yahoo_data_live.py`，需要外网访问 Yahoo 和 Yahoo Finance 的交易所元数据。该回归检查真实 QQQ 和所选波动率指数的日期、来源、信号可用状态及完整 API 运行结果，不断言实时行情数值；网络或 Yahoo 服务不可用时全量 pytest 会失败。纯账本、信号边界和 fixture API 测试仍保持确定性。

## 显式 live smoke

后端标准安装已包含 Yahoo 与交易所日历依赖。运行 API 前在后端虚拟环境安装/更新项目依赖：

```bash
cd backend
.venv/bin/python -m pip install -e '.[dev]'
```

提交回测时联网获取 Yahoo 行情；若只需要单独检查连通性，也可执行显式 live smoke：

```bash
cd backend
.venv/bin/python -m app.data.smoke --source yahoo --symbol QQQ \
  --start-date 2024-01-01 --end-date 2024-01-31 --live
```

命令会打印 JSON，字段包括检查时刻 `asOf`、来源 `source`、数据截至日期 `dataThrough`、覆盖率 `coverage`、状态和 `failureReasons`。退出码 `0` 表示完整，`1` 表示部分数据或供应商失败，`2` 表示未显式启用或本地参数/配置不满足。Yahoo 覆盖率按工作日估算，不含交易所节假日；节假日可能被报告为缺失交易日。smoke 使用单次请求和 10 秒默认超时，可用 `--timeout-seconds` 修改；yfinance 固定版本为 1.7.0。

SEC CompanyFacts 需要 CIK 和你提供的联系标识：

```bash
cd backend
SEC_USER_AGENT='Stock ETF Backtester contact@example.com' \
  .venv/bin/python -m app.data.smoke --source sec --symbol AAPL \
  --cik 0000320193 --live
```

没有 `SEC_USER_AGENT` 时命令会在发出请求前安全失败。检查只请求 SEC 官方 CompanyFacts JSON 地址一次；报告、日志和诊断不会包含 User-Agent、响应正文或请求 URL。SEC 要求使用可识别的 User-Agent，并要求遵守 fair-access 速率限制；这个单次 smoke 不会自动重试。

关闭 `--live` 时 smoke 命令不会调用供应商。provider 的超时、限流、缺少配置和脱敏边界通过 fake provider/HTTP opener 精确检查；另有真实 Yahoo API 回归保证默认 QQQ/VIX 数据链实际可用。回测本身在用户按下运行后会访问 Yahoo；VIX 不会前向填充。单个缺失行情日会从共享回测日历中跳过且不造价，连续缺失两日及以上仍作为行情不可用处理。

## Fixture 更新流程

固定数据放在 `backend/app/data/fixtures/`；当前核心 bundle 为 `task4_core.json`，notebook 来源与字段映射见 [`fixtures/notebook-mapping.md`](fixtures/notebook-mapping.md) 和同目录 JSON manifest。fixture loader 计算规范化快照指纹，运行结果会冻结该指纹。

更新 fixture 时：

1. 先确定测试要保护的领域规则和固定日期范围；live smoke 的结果不能直接成为测试期望值。
2. 只保存最小、可复核的 fixture 内容及来源/日期/版本说明，不提交认证信息或无关的供应商响应字段。
3. 保持原始公开/观测时间、币种、单位、价格口径和缺失状态；不要用前向填充、零值或当前 ETF 持仓补历史缺口。
4. 为新增/改变的场景加确定性测试，验证规范化结果和诊断；需要时同步更新 notebook manifest 与此文档。
5. 运行后端 pytest、Ruff、mypy 和前端契约/类型检查，复核 fixture diff 与 `git diff --check`。

目前没有 live 数据转 fixture 的自动导入器；导入和清理由维护者审阅完成。

## PE 与公开数据的已知限制

- SEC CompanyFacts 适合读取标准化 XBRL 事实，但不能单独证明每股 EPS 的拆股基准、准确上市类别和实际盘中公开时刻。没有可核验的时点/口径时，依赖 PE 的日期保持不可用。
- SEC N-PORT 是申报快照，不是逐日 ETF 持仓；ETF PE 是基于历史直接股票持仓的估算，并受申报滞后、发行人识别、EPS 和估值价格匹配及最低覆盖率影响，不代表基金公布的原生 PE。
- 免费来源无法保证所有标的和历史日期均有可用估值。个股非正 EPS、过期/未公开事实、价格口径或币种不一致都会导致 PE 不可用。
- CompanyFacts 和 N-PORT 解析适配器当前接收已取得的数据，不承担 HTTP 获取；SEC live smoke 只验证 CompanyFacts 读取和 EPS 规范化覆盖，不验证完整 PE 或 ETF 持仓估值链路。
- Yahoo 行情/指数/利率已接入回测运行；PE 仍依赖 SEC CompanyFacts/N-PORT 的获取、标识和公开时间链路，目前未接入普通回测 provider。启用 PE 的策略会显示专门的数据不可用诊断，其他策略照常运行。

官方参考：[SEC EDGAR API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)、[SEC Developer Resources / fair access](https://www.sec.gov/about/developer-resources)、[SEC N-PORT 数据集](https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets)、[yfinance 1.7.0 history 实现与 timeout 参数](https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/history.py)。

## 本机日志与 V1 范围

Yahoo 失败诊断区分通用请求失败、超时和限流，并只记录异常类型等有限元数据。缓存日志只记录命中、未命中、刷新/绕过及 provider 名称；运行日志记录运行/策略 ID、状态、诊断码以及 `data_sources`、`calendar_as_of`、`market_data_through`。不记录配置金额、原始响应、异常消息或环境变量。后端还会通过稳定的 `messageKey` 返回可读诊断，由日中词典显示。

V1 不连接券商或提交真实订单，不提供投资建议，不做公网部署、账户/云端同步或跨进程并发保证；运行结果保存在本机数据库，规范化数据缓存只在进程内。live smoke 只做显式的只读数据检查。
