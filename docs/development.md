# 开发与排障

## 当前运行边界

这是本机历史模拟应用。前端只消费 FastAPI 契约；`catalog` 和 `config` 提供目录与验证，`data` 负责供应商适配、规范化和快照，`signals`、`ledger`、`metrics` 与 `search` 负责计算，`runs` 冻结配置并协调独立结果，`export` 只从保存的结果快照导出。

常规应用启动和确定性测试不访问外部网络。API 当前配置 `UnconfiguredRunDataProvider`，所以真实 API 运行会返回可见的“数据提供方未配置”诊断；Yahoo/SEC live smoke 是单独的只读连通性检查，不会把下载结果送进回测或保存为运行结果。E2E 使用仓库 fixture provider。

已提交的 `RunSnapshot.dataProvenance` 冻结来源列表、日历截止日和行情最新报价日。汇总、每日资产、交易、搜索结果四类 CSV 都从这个保存快照附带 `dataSources`、`calendarAsOf`、`marketDataThrough`，导出不读取当前草稿或重新请求数据。`marketDataThrough` 表示行情报价覆盖，不代表宏观或 SEC 数据也更新到该日；这些数据的观察日/公开时间保留在数据快照和诊断中。运行完成日志以结构化字段记录相同来源与日期，不输出配置值或供应商响应。

`RunStore` 与规范化数据缓存目前都在进程内：重启会清空运行记录和缓存。数据缓存最多保留 128 个规范化结果，不保存供应商响应；成功且无错误诊断的快照才会缓存，`refresh=True` 会绕过现有项，自动识别单位的利率不走缓存。缓存键包含供应商、代码、日期、频率、版本、价格口径和上下文指纹。

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

## 显式 live smoke

只在需要检查外部只读数据源时安装 Yahoo 可选依赖并执行命令：

```bash
cd backend
python -m pip install -e '.[dev,live]'
python -m app.data.smoke --source yahoo --symbol QQQ \
  --start-date 2024-01-01 --end-date 2024-01-31 --live
```

命令会打印 JSON，字段包括检查时刻 `asOf`、来源 `source`、数据截至日期 `dataThrough`、覆盖率 `coverage`、状态和 `failureReasons`。退出码 `0` 表示完整，`1` 表示部分数据或供应商失败，`2` 表示未显式启用或本地参数/配置不满足。Yahoo 覆盖率按工作日估算，不含交易所节假日；节假日可能被报告为缺失交易日。smoke 使用单次请求和 10 秒默认超时，可用 `--timeout-seconds` 修改；yfinance 固定版本为 1.7.0。

SEC CompanyFacts 需要 CIK 和你提供的联系标识：

```bash
cd backend
SEC_USER_AGENT='Stock ETF Backtester contact@example.com' \
  python -m app.data.smoke --source sec --symbol AAPL \
  --cik 0000320193 --live
```

没有 `SEC_USER_AGENT` 时命令会在发出请求前安全失败。检查只请求 SEC 官方 CompanyFacts JSON 地址一次；报告、日志和诊断不会包含 User-Agent、响应正文或请求 URL。SEC 要求使用可识别的 User-Agent，并要求遵守 fair-access 速率限制；这个单次 smoke 不会自动重试。

关闭 `--live` 时不会调用供应商。确定性测试通过 fake provider/HTTP opener 检查超时、限流、缺少配置、覆盖率和脱敏，不访问 Yahoo 或 SEC。

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

官方参考：[SEC EDGAR API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)、[SEC Developer Resources / fair access](https://www.sec.gov/about/developer-resources)、[SEC N-PORT 数据集](https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets)、[yfinance 1.7.0 history 实现与 timeout 参数](https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/history.py)。

## 本机日志与 V1 范围

Yahoo 失败诊断区分通用请求失败、超时和限流，并只记录异常类型等有限元数据。缓存日志只记录命中、未命中、刷新/绕过及 provider 名称；运行日志记录运行/策略 ID、状态、诊断码以及 `data_sources`、`calendar_as_of`、`market_data_through`。不记录配置金额、原始响应、异常消息或环境变量。后端还会通过稳定的 `messageKey` 返回可读诊断，由日中词典显示。

V1 不连接券商或提交真实订单，不提供投资建议，不做公网部署、账户/云端同步或跨进程并发保证；运行结果和缓存都不跨进程/重启保留。live smoke 只做显式的只读数据检查。
