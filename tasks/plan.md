# Implementation Plan: 股票与 ETF 回测器 V1

## 计划依据与当前基线

本计划基于以下项目内部资料：

- `docs/superpowers/specs/2026-09-28-stock-etf-backtester-design.md`：交易规则、数据口径、错误处理、测试与验收的唯一依据。
- `docs/design/reuse-and-organization.md`：策略目录、参数归属、状态模型、模块接口、组件边界与实施顺序。
- `docs/design/review-resolutions.md`：已确认问题及其唯一归属。
- `docs/design/backtest-ui.html`：静态 UI 视觉与响应式参考（不是应用实现）。

当前仓库已建立 `backend/`、`frontend/`、依赖配置和离线测试入口；Task 1–21 已完成。Task 8 的 API/运行诊断/CSV 稳定码跨层验收已随 Task 15 关闭；Task 8 后端实现提交 `af384f6` 早于 Task 9，延后的是跨层验收。Task 13 在检查点 C 关闭前完成并推送，顺序偏差如实保留，之后重新核验 C 并按序完成 Task 14 及后续任务。notebook 输入映射和确定性 fixture 已固化到仓库，运行时不得依赖外部 notebook 路径。用户于 2026-09-29 确认运行结果需在服务重启后恢复，Task 22 实现该要求。

## 目标与范围

交付一个仅本机运行的 FastAPI + React/TypeScript 应用：首次打开即能运行 QQQ 的 VIX 信号定投；可编辑、启停和组合七类策略；以统一注资日历、三态信号、账本、指标、基准、搜索和不可变运行快照保证结果一致；支持日文默认/中文切换、结果查看及四类 CSV 导出。PE、利率和 ETF 历史估值按设计稿真实参与信号，数据不可用必须透明报告。

不包含券商/实盘、账户系统、云端同步、期权/空头/完整税费滑点、多标的组合和公网部署。

## 架构决策

1. **分层**：`backend/` 使用 FastAPI 暴露目录、校验、运行状态、结果和导出；核心回测模块保持纯函数，不下载数据。`frontend/` 使用 React/TypeScript，仅消费后端契约。
2. **单一契约来源**：后端 `ParameterDefinition` 注册表维护默认值、类型、单位、边界、适用目录、依赖、可搜索性和翻译键；OpenAPI/生成流程提供前端类型，前端不复制默认值与范围。
3. **数据隔离**：Yahoo/SEC 适配器只负责供应商转换、缓存、时间对齐和诊断；内核只读取规范化 `MarketSnapshot`/`ValuationSnapshot`。fixture 适配器与 live 适配器接口相同，常规测试不访问网络。
4. **统一执行**：日历、信号、账本、指标是唯一入口；普通策略、基准和搜索候选都调用同一实现。信号在 t 形成、t+1 成交，全部规则遵守统一日内顺序。
5. **运行隔离与恢复**：提交时生成不可变 `RunSnapshot`，每条 `StrategyRun` 独立状态和诊断；`RunStore` 使用本机 SQLite 保存完整运行响应和幂等记录，服务重启后恢复已保存结果。重启时仍处于非终态的运行转为带明确诊断的失败，不假装继续执行。
6. **可验证性优先**：先建立确定性 fixture 和纯内核测试，再接网络适配器和 UI；live smoke 只作为可选检查，不进入默认测试门禁。

## 依赖图

```text
脚手架/领域契约
  ├── 参数目录与校验 ───────────┐
  ├── fixture 与数据规范化       │
  └── 交易日历/注资计划          │
          └── 信号（三态）───────┤
                  └── 统一账本 ──┤
                          └── 指标/基准/搜索
                                  └── FastAPI 作业与导出
                                          └── React 配置/状态/结果 UI
```

## 实施任务

### 阶段 0：脚手架与契约

#### Task 1：建立可运行的双端脚手架

**描述：** 建立 Python 后端、React/TypeScript 前端、统一格式化/静态检查/测试命令和本地启动入口；记录 Python/Node 版本及依赖选择。保持现有设计文件不动。

**验收标准：**
- [x] 后端健康检查和前端开发页可以分别启动。
- [x] `pytest`、后端类型/格式检查、前端 lint/typecheck/build 命令可执行。
- [x] README 或开发文档说明启动、测试和 fixture 模式；实时网络不是默认启动依赖。

**验证：** 运行后端测试与健康检查；运行 `npm run lint`、`npm run typecheck`、`npm run build`（命令名在本任务确定）。

**依赖：** 无。

**可能触及：** `backend/pyproject.toml`、`backend/app/main.py`、`frontend/package.json`、`frontend/src/`、`README.md`。

**范围：** 中（3–5 个入口/配置文件）。

#### Task 2：定义领域契约、状态和不可变快照

**描述：** 定义共享设置、策略实例、目录 ID、`RunSnapshot`、`StrategyRun`、标准化数据快照、交易/每日资产、指标、诊断和七类状态码。稳定键使用设计稿中的命名，不让 UI 字符串进入算法模型。

**验收标准：**
- [x] `queued | loading | running | completed | completed_with_warning | unavailable | failed` 及 `empty` 的语义与设计一致。
- [x] 运行快照冻结共享设置、实例参数、catalog/data/engine 指纹；结果能区分 `benchmark` 与 `strategy` 身份。
- [x] 领域类型能表达 `true/false/unavailable`、部分成功和零交易成功。

**验证：** 领域构造/序列化测试覆盖缺字段、旧草稿与快照分离、状态转换非法情况。

**依赖：** Task 1。

**可能触及：** `backend/app/domain/contracts.py`、`backend/app/domain/status.py`、`backend/tests/domain/`。

**范围：** 小至中。

#### Task 3：实现唯一参数注册表与七类目录

**描述：** 按复用规范建立 `ParameterDefinition` 注册表、七类预设及适用性/依赖/搜索维度元数据；将 `vix_dca`、`composite_dca`、两种 `ma`、`monthly_dca`、`lump_sum`、`grid_search` 映射到三个执行模块和一个搜索包装。

**验收标准：**
- [x] 所有 notebook 显式输入和新增硬编码字段均有唯一稳定键、默认值、单位、范围、翻译键。
- [x] 普通编辑器、搜索维度、服务端错误路径和导出快照引用同一注册表；不出现第二套搜索阈值。
- [x] 删除 VIX 后可从目录再次添加；基准使用同一参数/账本而非复制算法。

**验证：** catalog 契约测试；枚举目录、适用字段、边界/步长和预设默认值；检查生成的 OpenAPI 类型与前端类型一致。

**依赖：** Task 2。

**可能触及：** `backend/app/catalog/definitions.py`、`backend/app/catalog/presets.py`、`backend/app/catalog/service.py`、`backend/tests/catalog/`、契约生成配置。

**范围：** 中。

#### Task 4：固化 notebook 映射与确定性测试 fixture

**描述：** 从外部两个 notebook 提取参数/策略映射，记录来源版本或校验信息；建立固定行情、交易日历、VIX/利率、SEC 公司事实、ETF 持仓和缺失数据 fixture，覆盖设计中明确的边界。

**验收标准：**
- [x] 两个 notebook 的显式输入逐项映射到注册键，外部路径不进入生产运行链路。
- [x] fixture 能重现拆股/双价格口径、披露晚于收盘、PE 缺失、ETF 覆盖边界、休市和跨月。
- [x] 默认测试完全离线且可重复，fixture 版本/数据指纹可进入运行快照。

**验证：** fixture 加载测试、输入映射完整性测试、同一 fixture 多次运行结果字节级/数值级稳定性检查。

**依赖：** Task 2；可与 Task 3 并行。

**可能触及：** `backend/tests/fixtures/`、`backend/tests/data/`、`docs/` 中的映射记录、fixture manifest。

**范围：** 中。

### 检查点 A：契约可冻结

- [x] 七类目录、唯一字段注册表和领域快照通过测试。
- [x] fixture 能离线加载；实现不再依赖外部 notebook 文件路径。
- [x] 在进入交易逻辑前确认参数键和状态码不再随意改名。

### 阶段 1：时间与数据层

#### Task 5：实现交易日历与共享注资计划

**描述：** 实现含起止边界的交易日历和 `schedule(runSettings, exchangeCalendar)`：每月 1–31 日截到月末，休市取同月后首个交易日；无后续交易日时，只有日历已覆盖整月才回退至当月最后交易日。日历显式携带 `asOfDate`、`latestCompleteDate` 与 `calendarCoverageEndDate`，纯函数不读取系统时钟；月中区间不补缴、不预缴；一次性投入使用同一计划金额总和。

**验收标准：**
- [x] 31 日、月底假期、跨月、月中起止、未来结束日和无有效注资均有明确结果/诊断。
- [x] 所有策略、基准和搜索候选共享同一排程；结束日冻结为最近完整行情日并可展示实际值。
- [x] 一次性投入本金等于有效计划总额，但在首个回测交易日投入。

**验证：** 纯函数测试覆盖设计稿的日期矩阵和金额矩阵；不访问供应商。

**依赖：** Task 2、Task 4。

**可能触及：** `backend/app/calendar/`、`backend/tests/calendar/`。

**范围：** 小至中。

#### Task 6：实现规范化行情、宏观适配器和缓存边界

**描述：** 定义并实现 fixture/Yahoo 适配器，将标的、VIX、利率转换为统一交易日序列；保留币种、时间戳、来源、数据指纹和 `simulationPrice`/`valuationPrice`，处理预热期和宏观最多 3 个交易日的 as-of 规则。由于日历不提供交易时段收盘时点，同日宏观数据保守地从下一交易日开始使用。

**验收标准：**
- [x] 复权模拟价与估值价明确分离；无法可靠区分时产生不可用诊断而不代用。
- [x] 行情缺失不前向填充/静默跳过；利率单位无法确认时要求显式设置或报单位错误。
- [x] 缓存键包含供应商、代码、频率、日期、版本和价格口径，不把原始供应商响应泄漏到内核。
- [x] 无法与交易时段收盘时点核验的同日宏观观测从下一交易日开始使用；自动识别单位的利率不复用未包含实际单位的缓存项。
- [x] fixture 与 Yahoo 行情/宏观结果可组合为相同的 provider-neutral `DataSnapshot`。
- [x] 规范化内存缓存有界且支持显式刷新；Yahoo 适配器锁定在文档和映射证据验证的版本。

**验证：** fixture 适配器测试；Yahoo 映射/单位/缺失测试；缓存命中与指纹测试；live adapter 仅提供显式 smoke 命令。

**依赖：** Task 2、Task 4、Task 5。

**可能触及：** `backend/app/data/market_data.py`、`backend/app/data/providers/yahoo.py`、`backend/app/data/cache.py`、`backend/tests/data/`。

**范围：** 中。

#### Task 7：实现 SEC 财务/持仓 as-of 与 PE 估值

**描述：** 实现 CompanyFacts/XBRL 与 N-PORT 适配器及规范化估值逻辑：按公开时间可用性选择个股最近合格 EPS；ETF 按历史持仓、身份/财务/价格匹配和覆盖率重归一估算 PE。

**验收标准：**
- [x] 个股不通过累计 YTD 相减生成季度 EPS；非正 EPS、币种/拆股基准不匹配、过期或未公开事实均不可用。
- [x] ETF 只接受符合能力条件的直接股票持仓；覆盖率默认 0.80 可调，保留有效负 EPS 贡献，收益率非正时不可用。
- [x] 公开日不确定或晚于收盘的事实从下一交易日可用；来源、报告期、公开时间和方法标签被保留。

**验证：** 个股季度/年度回退、披露时点、非正 EPS、ETF 80% 覆盖重归一/负贡献/不支持 ETF 的 fixture 测试；SEC live 只做可选 smoke。

**依赖：** Task 2、Task 4、Task 6。

**可能触及：** `backend/app/data/fundamentals.py`、`backend/app/data/providers/sec.py`、`backend/app/domain/valuation.py`、`backend/tests/data/valuation/`。

**范围：** 中至大，应保持为一个可独立验收的数据切片。

#### Task 8：实现配置校验、数据能力诊断和错误字段路径

**描述：** 将注册表的结构/范围/单位/依赖校验与数据能力诊断统一成一个入口，区分空值、非法范围、非适用、参数错误、数据不可用和供应商失败；为 PE/VIX/RSI/均线/布林/利率统一生成诊断码。

**验收标准：**
- [x] `ratio` 始终 0..1、`percent_point` 使用 2.5 表示 2.5%，所有范围与注册表一致。
- [x] 禁用信号不形成依赖；启用信号缺失会生成带 strategyId 的 unavailable 诊断，不被 OR 静默跳过或转为 false。
- [x] API 校验错误、运行诊断和 CSV 诊断保留同一 `code`、`messageKey`、`fieldPath` 结构；前端消费此契约由 Task 16/17 接入。

**验证：** 普通配置与网格配置共用边界测试；AND/OR 与能力诊断矩阵；错误 JSON schema 契约测试。

**依赖：** Task 3、Task 6、Task 7。

**可能触及：** `backend/app/config/validation.py`、`backend/app/config/diagnostics.py`、`backend/tests/config/`。

**范围：** 中。

**跨层验收说明：** 后端校验和数据能力诊断定义稳定码、message key 与字段路径；Task 13/15 的 API 与 CSV 契约测试已确认字段一致。

### 检查点 B：数据层可供内核消费

- [x] 日历、市场快照和估值快照均可由 fixture 构造，字段不含供应商私有结构。
- [x] 配置错误与数据不可用已区分；PE 两种价格口径和 as-of 规则有回归测试。
- [x] 网络不可用不会让默认测试变红或生成伪收益。

### 阶段 2：纯回测内核

#### Task 9：实现指标模块与三态信号评估

**描述：** 实现 RSI（滚动算术均值）、简单均线、样本标准差布林带、VIX、利率和 PE 信号；输出逐日 `true/false/unavailable`、原因及预热边界，支持买入/卖出开关独立依赖和 AND/OR。

**验收标准：**
- [x] 每种信号阈值边界与设计公式一致，技术指标只读当日及以前数据；指标方法有稳定版本号。
- [x] 买入关闭不影响独立开启的卖出数据依赖；空买入集合为 false。
- [x] 任一启用必需信号不可用时，该策略的信号序列不可用并保留诊断，供运行编排标为 unavailable；其他策略不受阻断。

**验证：** 固定序列逐日黄金数据测试；预热、阈值边界、AND/OR、不可用传播和独立开关测试。

**依赖：** Task 5、Task 6、Task 7、Task 8。

**可能触及：** `backend/app/signals/indicators.py`、`backend/app/signals/evaluate.py`、`backend/tests/signals/`。

**范围：** 中。

**跨层验证：** Task 10 确认空买入信号不会抑制定投注资和安全阀执行。

#### Task 10：实现统一交易账本与成交时序

**描述：** 实现 `ledger.runStrategy`：总资产由现金、择时持仓、固定定投持仓组成；按注资→计划买入→前日卖出→前日买入→月末安全阀→估值→当日信号的顺序运行，并记录未执行末日信号。

**验收标准：**
- [x] t 收盘信号只在 t+1 成交；卖出优先并抑制同日择时买入/安全阀，固定定投照常执行。
- [x] 固定定投始终计入总资产，100% 固定比例与同排程 DCA 等值；月度信号次数只统计成交。
- [x] 零现金仍每日估值/保留卖出评估；只有有完整交易所日历证据的实际月末触发安全阀；持仓与交易明细可复现。

**验证：** `backend/tests/ledger/test_engine.py` 的逐日账本黄金测试覆盖资金、成交冲突、信号延迟、月末、零交易、100% 固定定投等值和末日未执行信号；未执行信号使用稳定原因码进入领域结果契约。

**依赖：** Task 5、Task 9。

**可能触及：** `backend/app/ledger/engine.py`、`backend/app/ledger/types.py`、`backend/tests/ledger/`。

**范围：** 中。

#### Task 11：实现统一指标、基准和结果比较

**描述：** 实现投入额、期末资产、净收益、投入回报率、资本倍数、XIRR、扣除现金流影响的最大回撤及相对 DCA；普通策略、两种基准和搜索候选均调用同一指标模块。

**验收标准：**
- [x] `endingEquity / totalContributed` 不被标成盈利率；XIRR 使用实际/365 和各自真实现金流时点。
- [x] 零交易仍可完成并产生正确指标；无唯一 XIRR 时仅将该指标置为不可用并给出诊断，不伪造策略失败或收益。
- [x] 最大回撤来自单位净值；`relativeToDca` 为期末资产的同币种绝对差额，且只接受同预算、期间和数据快照。

**验证：** 手算真实现金流日期、实际/365 XIRR、现金流调整单位净值及回撤 fixture；验证一次投入不将月度计划现金流重复计入，并检查仅匹配的月度 DCA 可计算同币种期末差额。

**依赖：** Task 10。

**可能触及：** `backend/app/metrics/`、`backend/app/domain/results.py`、`backend/tests/metrics/`。

**范围：** 中。

#### Task 12：实现网格搜索包装与候选复用

**描述：** 实现维度合法性、组合数量上限、候选覆盖所选键、固定其余基础参数、逐候选调用普通校验/账本/指标；保留无效候选原因并支持结果复用而不混淆实例身份。

**验收标准：**
- [x] 只允许注册表中适用且可搜索的数字字段；列表非空、去重、边界和 `maxCombinations`（软默认 1000、硬上限 10000）有效。
- [x] 候选与普通策略同口径，固定比例 100% 等值，热图切片明确固定其余维度。
- [x] 无效候选不参与排名但保留原因；有效候选按期末资产降序、绝对最大回撤升序、稳定候选序号处理并列；相同计算指纹可复用，`benchmark`/`strategy` 身份仍独立。

**验证：** `backend/tests/search/test_search.py` 覆盖维度组合/上限、候选覆盖、重复指纹、无效候选、排序、热图固定值和结果数量；`backend/tests/ledger/test_engine.py::test_one_hundred_percent_fixed_dca_matches_monthly_dca_daily_assets` 覆盖固定比例 100% 与 DCA 一致。Task 12 专项与全后端回归命令见本次交付记录。

**依赖：** Task 3、Task 8、Task 10、Task 11。

**可能触及：** `backend/app/search/`、`backend/tests/search/`。

**范围：** 中。

### 检查点 C：内核口径冻结

- [x] 纯 fixture 下普通策略、基准、搜索候选均通过账本/指标一致性测试。
- [x] t+1 成交、现金流、PE 缺失和部分不可用行为均有回归保护。
- [x] 不再在 API 或前端新增交易算法分支。

**验收记录（2026-09-29）：** `backend/tests/search/test_search.py::test_search_candidate_matches_ordinary_strategy_and_monthly_dca_benchmark` 对照普通复合策略、月度 DCA 基准和固定比例 100% 的搜索候选，核对账本及指标一致性。已有回归分别覆盖 `backend/tests/ledger/test_engine.py::test_signal_buy_executes_on_the_next_session_at_that_session_price`、`backend/tests/metrics/test_metrics.py::test_xirr_uses_each_contribution_date_with_actual_365_day_count`、`backend/tests/metrics/test_metrics.py::test_upfront_investment_uses_one_first_day_cash_flow_for_xirr`、`backend/tests/signals/test_evaluate.py::test_any_enabled_unavailable_buy_blocks_the_whole_strategy_even_with_vix_true` 和 `backend/tests/signals/test_evaluate.py::test_unavailable_signal_only_marks_the_strategy_that_depends_on_it`；`backend/tests/domain/test_contracts.py::test_completed_zero_trade_strategy_and_partial_result_are_representable` 覆盖部分成功结果。`rg` 检查确认 API/前端没有账本、信号或指标算法实现。相关测试、Ruff、格式检查和 mypy 均通过。

**执行顺序记录：** Task 13 在检查点 C 关闭前已完成并推送，违反计划顺序。保留该交付，不回滚；Task 14 暂缓至本次核验关闭 C 后再开始。

### 阶段 3：FastAPI 应用层

#### Task 13：提供 catalog、校验和运行提交 API

**描述：** 暴露目录/字段元数据、草稿校验、运行提交和结果查询的版本化 API；请求结构对应领域契约，返回结构化字段错误、诊断和状态，而不是让前端推断。

**验收标准：**
- [x] API 能取得七类目录、注册表元数据和由 OpenAPI schema 生成的契约指纹。
- [x] 提交边界冻结共享设置、所选实例、catalog/engine 版本；`RunService` 返回的已接受记录必须带有含 data fingerprint 的完整 `RunSnapshot`。当前模式要求当前实例启用，全部模式要求至少一条启用。
- [x] 未选实例错误不阻断当前运行；全部运行保留每条已启用实例的独立校验诊断，由 Task 14 作业编排映射为局部结果状态。运行提交必须携带 `Idempotency-Key` 并传给服务；同键重试由 Task 14 存储层复用原作业，同键不同请求返回冲突。

**验证：** `backend/tests/api/test_api.py` 覆盖 OpenAPI 指纹、七类目录、字段路径、当前/全部范围、未选错误隔离、无启用策略、RunSnapshot 身份和 data fingerprint、结构化错误及结果查询；全后端回归通过。

**依赖：** Task 3、Task 8、Task 9–12。

**可能触及：** `backend/app/api/catalog.py`、`backend/app/api/runs.py`、`backend/app/main.py`、`backend/tests/api/`。

**范围：** 中。

#### Task 14：实现作业编排、进度和局部失败

**描述：** 实现 `createRun/getRun` 和本地作业执行器，提供 `queued/loading/running` 进度及终态；按实例独立获取数据/运行策略，统一生成基准、诊断和不可变结果。

**验收标准：**
- [x] `getRun` 返回 queued/loading/running 和终态，整体状态可区分全失败、不可用、部分成功、警告和完成；无作业空态由前端呈现。
- [x] 数据/参数/计算异常映射到稳定诊断码；零交易是 `completed`，缺少必需数据是 `unavailable`。
- [x] `RunSnapshot` 冻结提交配置与数据指纹；后续草稿不能改变已保存结果。编辑实例与结果焦点的 UI 隔离由 Task 17/18 验收。
- [x] `Idempotency-Key` 由单一原子存储认领；同键同提交返回原作业，同键不同提交明确冲突。

**验证：** `backend/tests/api/test_api.py` 与 `backend/tests/runs/` 覆盖 API 状态、部分失败、全失败、不可用、警告、零交易、最新日期快照、同键复用/冲突和异常隔离；`pytest -q`、`mypy app`、`ruff check app tests`、`ruff format --check app tests` 通过。

**依赖：** Task 9–13。

**可能触及：** `backend/app/runs/manager.py`、`backend/app/runs/store.py`、`backend/app/runs/orchestrator.py`、`backend/tests/runs/`。

**范围：** 中。

#### Task 15：实现四类 CSV 导出

**描述：** 从已存结果快照生成汇总、每日资产、交易、搜索结果 CSV；不重新计算，稳定输出字段键、ISO 日期、原始精度和独立币种列。

**验收标准：**
- [x] `/api/v1/runs/{run_id}/export/{kind}?focusedResultId=...` 只从已存 `RunResponse` 导出，不读取当前草稿。
- [x] 无完成结果/不存在的聚焦结果返回结构化错误；成功但零交易时交易 CSV 仍输出表头。
- [x] CSV 不接收 locale，字段键、日期和数值格式固定，不受界面语言影响。
- [x] 四类 CSV 都从已存 `RunSnapshot.dataProvenance` 附加 `dataSources`、`calendarAsOf`、`marketDataThrough`；行情截至日只代表报价覆盖。

**验证：** `backend/tests/export/test_csv.py` 覆盖四类 CSV golden 输出、空结果、零交易、搜索候选诊断和原始精度；`backend/tests/api/test_export.py` 覆盖结构化错误、OpenAPI 文档、语言无关及导出/运行查询一致性。

**依赖：** Task 11、Task 14。

**可能触及：** `backend/app/export/csv.py`、`backend/app/api/export.py`、`backend/tests/export/`。

**范围：** 小至中。

### 检查点 D：后端端到端可用

- [x] 从提交运行到查询状态、用 `focusedResultId` 选定结果和 CSV 导出可用。
- [x] 部分成功/全失败/不可用/警告/零交易状态由 API 和导出检查可区分。
- [x] API 不重复实现目录边界、交易算法或指标算法；API 层边界扫描无算法分支。

### 阶段 4：React 前端与交互

#### Task 16：实现应用壳、共享控件和双语词典

**描述：** 根据静态 UI 源建立日文默认/中文切换、共享设置表单、统一输入/单位/错误样式、可访问的开关/分段控件和生成类型接入。

**验收标准：**
- [x] 共享标的、日期、注资金额/日期只出现一次；动态结束日锁定输入，有运行快照时显示其中冻结的实际日期，无快照时明确显示将在运行时解析。
- [x] `ParameterField` 按 catalog 渲染类型、单位、依赖和错误，不复制后端默认值/边界。
- [x] 词典覆盖字段、状态、诊断、空态、导出；语言状态与配置/结果状态分离，切换语言只更换文案。

**验证：** `npm test`（catalog mock 与实际后端目录契约、组件服务端渲染、latest 日期、依赖/诊断和语言控件）通过；`npm run typecheck`、`npm run lint`、`npm run build` 通过。键盘焦点、skip link、标签/状态播报有静态检查，视口和浏览器视觉回归留在 Task 19。

**跨任务说明：** `SharedSettingsForm` 从 `RunSnapshot.config.shared.run.endDate` 接收已冻结的最新结束日期；Task 17 将运行响应接入后提供该值。初次运行前后端没有完整行情日可用时，界面不使用本机日期代替。

**依赖：** Task 1、Task 3、Task 13。

**可能触及：** `frontend/src/app/`、`frontend/src/shared/ui/`、`frontend/src/i18n/`、`frontend/src/features/config/`。

**范围：** 中。

#### Task 17：实现策略列表、编辑器、运行控制和诊断

**描述：** 实现首屏 VIX 信号定投、目录添加/删除/重新添加、策略实例编辑、唯一启用开关、当前编辑状态、当前/全部运行范围和单一主运行按钮；策略名称保持为稳定预设类型，当前 VIX 代码/阈值以摘要显示。

**验收标准：**
- [x] 首屏默认值来自 catalog；策略显示为「VIX シグナル積立」并显示当前 VIX 参数摘要；切换编辑对象不启用、不运行、不重置参数，停用不丢值。
- [x] 关闭 VIX 信号时保留 `vix_dca` 身份并显示「VIX シグナル無効」，不静默转换策略类型。
- [x] 当前模式/全部模式禁用原因准确；错误按 API 诊断码和字段路径展示，不从参数种类推断失败。
- [x] 草稿、`activeStrategyId`、`runScope`、运行响应、请求时结束日模式和 `focusedResultId` 独立管理。

**验证：** `npm test`（23 项：默认 catalog 值、切换/启停、删除/重加、当前/全部范围、校验诊断、最新日期请求占位及局部失败 API mock）、`npm run typecheck`、`npm run lint`、`npm run build` 均通过；`git diff --check` 通过。VS Code 启动的 API/UI 服务按用户说明已停止，本任务未启动服务。

**依赖：** Task 13、Task 14、Task 16。

**可能触及：** `frontend/src/features/strategies/`、`frontend/src/features/runs/RunControls.tsx`、`frontend/src/features/runs/StatusView.tsx`、相关测试。

**范围：** 中。

#### Task 18：实现结果、图表、交易明细、搜索和导出

**描述：** 实现结果聚焦、KPI、曲线/回撤、比较表、交易记录、搜索结果、图例显隐和 CSV 控件；所有视图从同一不可变结果响应读取。

**验收标准：**
- [x] KPI、曲线、表格、交易记录和 CSV 始终跟随 `focusedResultId`，不跟随当前编辑实例。
- [x] 图表/交易记录是独立展示开关；图例只控制显隐；无结果禁用 CSV，零交易仍能导出表头。
- [x] 结果页能区分无作业、运行中、全失败、部分成功、警告、完成和空交易。

**验证：** `frontend/npm test`（45 项）覆盖结果焦点/编辑焦点隔离、独立显示开关、图表与空交易表、搜索排名/无效候选、CSV API 错误/文件名/下载触发和部分成功状态；`npm run typecheck`、`npm run lint`、`npm run build` 与 `git diff --check` 通过。组件以服务端静态渲染和 mock fetch 验证，本任务未启动浏览器或本地服务。

**依赖：** Task 14、Task 15、Task 17。

**可能触及：** `frontend/src/features/results/`、`frontend/src/features/search/`、图表适配器、相关测试。

**范围：** 中。

#### Task 19：响应式、可访问性和视觉回归

**描述：** 将静态 UI 的布局规则落地并在 320/768/1024px 验证；统一输入高度、触屏命中区、换行和长名称处理，避免裁切核心操作。

**验收标准：**
- [x] CSS 在窄屏使用单列、长名称/顶栏/控件组可换行、宽表格容器内滚动；用静态回归检查 320/768/1024px 断点规则。
- [x] 在真实 Chromium 浏览器 320/768/1024px 视口确认无横向裁切或核心操作隐藏；日文与中文均检查核心控件边界。
- [x] 触屏按钮/输入/复选标签目标至少 44px；静态检查键盘焦点样式、skip link、减少动态效果，SSR 检查 ARIA 状态与表格语义。
- [x] 日文默认和中文切换的词典、标签和状态语义由双语组件测试覆盖。
- [x] 真实 Chromium 下完成日中视觉回归、axe WCAG 2.1 A/AA 扫描及 DevTools accessibility tree 的 main/heading/button 语义检查。

**验证：** `frontend/npm run test`（52 项）、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:e2e`（9 项）及 `git diff --check` 通过。Playwright 由测试配置分别启动临时 fixture API 与 Vite（`reuseExistingServer: false`），测量日中 320/768/1024px 页面溢出和核心控件边界，保存视口截图；axe 对 WCAG 2.1 A/AA 未报告违规，Chromium accessibility tree 含 main、页面标题和按钮。截图已人工检查；测试后确认 8000/5173 端口无监听进程。浏览器验证同时发现并修复未选中的运行范围按钮对比度不足，以及 catalog Decimal 字符串默认值未在前端入口恢复数值类型的问题。

**依赖：** Task 16–18。

**可能触及：** `frontend/src/styles/`、`frontend/tests/e2e/`、组件测试和 CI 配置。

**范围：** 中。

### 检查点 E：产品路径可操作

- [x] 从首屏默认 VIX 到运行、状态、聚焦结果、曲线/交易开关和 CSV 的路径可完成。
- [x] 七类目录可添加；策略启停、语言切换和日中 320/768/1024px 响应式布局通过浏览器测试。
- [x] UI 没有第二份业务默认值、边界或交易算法。

### 阶段 5：集成验收与发布准备

#### Task 20：固定数据端到端验收

**描述：** 用固定行情/SEC/日历 fixture 跑完整 API + UI 链路，覆盖设计稿验收标准及审查指摘；对比账本、指标、图表、表格和 CSV 的同一结果快照。

**验收标准：**
- [x] 首屏 VIX 信号定投、七类目录、基准、搜索、利率/PE、部分失败、旧结果和零交易场景全部可验收。
- [x] t+1 成交、100% 固定比例等值、PE 价格口径/公开时间和 XIRR/回撤现金流有固定数据断言；ETF 覆盖率边界由 Task 7 的 SEC 估值 fixture 测试保护。
- [x] 结果页、导出和 API 的数值/状态/身份一致；浏览器运行只请求本机 fixture 服务，不依赖实时网络。

**验证：** 2026-09-29：后端全量 pytest、`ruff check tests/e2e`、前端 53 项 unit/integration、typecheck、lint、production build 和 Playwright 9 项 E2E 全部通过。单日 PE 场景明确断言 `no_valid_xirr` 警告；ETF 覆盖边界由 `tests/data/valuation/test_fundamentals.py` 中精确 80% 与低于 80% 的 SEC N-PORT fixture 用例覆盖。

**执行记录：** 新增 `backend/tests/e2e/` 固定 fixture API 验收和 `backend/tests/e2e/serve_api.py` 浏览器服务入口；浏览器回归验证旧结果编辑后仍导出冻结快照、七类目录、可访问性和响应式布局，并确认没有向本机以外发请求。一次沙箱内的 Playwright 启动因本地监听权限失败；获批的本机测试进程重跑后 9 项全部通过，进程结束后端口已释放。

**依赖：** Task 1–19。

**可能触及：** `backend/tests/e2e/`、`frontend/tests/e2e/`、`tests/contract/`、CI 配置。

**范围：** 中。

#### Task 21：live adapter smoke、可观测性和开发文档

**描述：** 增加显式 live 数据 smoke 命令、供应商限流/缓存/超时诊断、运行日志和开发排障文档；不把 live 数据结果作为确定性验收基线。

**验收标准：**
- [x] `python -m app.data.smoke` 需要显式 `--live`，Yahoo/SEC 报告 `asOf`、来源、数据截至日期、覆盖率和失败原因；无 SEC User-Agent 在发请求前安全失败。
- [x] Yahoo 诊断区分限流和超时；供应商错误正文与 SEC User-Agent 不进入 API 诊断、日志或 smoke 输出。缓存和运行状态有不含配置/响应内容的结构化日志。
- [x] `docs/development.md` 说明架构边界、fixture 更新流程、常用命令、PE 限制和 V1 范围；README 链接该文档并记录 Task 21 完成时默认 provider 尚未接入 live run（该限制由 Task 23 处理）。
- [x] 冻结来源、日历截止日与行情报价覆盖日；运行完成日志用结构化字段记录它们，前端 OpenAPI 类型由后端契约生成。

**验证（2026-09-29）：** 后端 `python -m pytest`（288 项）、`ruff check .`、`ruff format --check .`、`mypy app` 通过；前端 `npm test`（54 项）、`npm run typecheck`、`npm run lint`、`npm run build` 通过，`npm run generate:api` 根据 52 个 OpenAPI schema 生成类型；`npm run test:e2e`（9 项）通过。smoke 未加 `--live` 与 SEC 缺少 `SEC_USER_AGENT` 均以退出码 2 安全返回；Yahoo/SEC 成功、缺失、超时、限流及脱敏由 fake provider/HTTP opener 验证，未访问 live 网络。E2E 临时 API/Vite 进程退出后，8000/5173 端口均无监听；`git diff --check` 通过。

**实现记录：** 新增 `backend/app/data/smoke.py`，SEC 只请求固定的官方 CompanyFacts 主机并限制响应读取大小；Yahoo 使用 10 秒默认超时。缓存限流策略不自动重试、不写磁盘，成功规范化结果保留在最多 128 项的进程内 LRU。完整维护命令与供应商边界见 [`docs/development.md`](../docs/development.md)。全量 Ruff 格式检查同时格式化了 Task 20 新增的固定 fixture E2E 测试文件，没有改变其行为。

**依赖：** Task 6、Task 7、Task 14、Task 20。

**可能触及：** `backend/app/observability/`、`backend/tests/smoke/`、`docs/development.md`、CI 配置。

**范围：** 小至中。

#### Task 22：持久化运行结果并在重启后恢复

**描述：** 将用户确认的重启恢复要求接入本机运行服务：保存完整 `RunResponse` 与幂等键，API 和 UI 能重新载入最近一次运行；不恢复进程中的线程或未冻结的数据加载过程。

**验收标准：**
- [x] 默认运行服务使用本机 SQLite `RunStore`，保存运行快照、状态、结果及幂等键；新建 store 实例后仍能按 run ID 和幂等键读取原记录。
- [x] 应用提供最近运行查询，页面重新打开后恢复保存的结果、焦点与导出能力；旧草稿仍保持独立，不被历史快照覆盖。
- [x] 服务重启发现 `queued/loading/running` 记录时，将未完成策略明确标为 `failed` 并附稳定诊断；已完成的策略与部分结果原样保留。
- [x] 数据库默认位于仓库忽略的本机状态目录，可用环境变量改路径；实现无网络依赖，并说明备份/清理方式。

**验证（2026-09-29）：** `backend/tests/runs/test_sqlite_store.py` 覆盖关闭/重开、完整结果与幂等恢复、非终态恢复诊断、未接受认领清理及 SQLite 并发认领；API 测试覆盖最近运行端点的空值和已保存响应；前端 API/unit 测试覆盖恢复请求和中断诊断翻译，E2E 在页面重开后确认结果与 CSV 可用。后端 pytest 293 项、Ruff check/format、mypy 通过；前端 npm test 55 项、typecheck、lint、build 通过；E2E 9 项通过；`npm run generate:api` 由 52 个 OpenAPI schema 生成契约；`git diff --check` 通过，E2E 退出后 8000/5173 端口无监听。

**依赖：** Task 13、Task 14、Task 18、Task 21。

**可能触及：** `backend/app/runs/`、`backend/app/main.py`、`backend/app/api/runs.py`、`frontend/src/App.tsx`、`frontend/src/api/runs.ts`、数据存储文档与相关测试。

**范围：** 中。

#### Task 23：将 Yahoo 数据源接入本机回测运行

**描述：** 参考 Task 4 的 `QQQ_VIX_DCA_backtest.ipynb` 和 `compare_strategies.ipynb` 数据下载段，在用户运行 API 时通过现有 Yahoo 适配器获取标的日线和已启用的 VIX/宏观序列，以真实交易日历、完整收盘日和规范化快照驱动回测。服务启动保持离线；默认运行链路必须由真实 Yahoo 数据验收，不能用 fixture 代替源可用性验证。

**验收标准：**
- [x] 默认 API provider 可对支持的 Yahoo 交易所和符号构造真实交易日历，并按已完成的行情日期冻结动态结束日。
- [x] 标的与启用的 Yahoo 行情/指数宏观数据走现有规范化适配器；价格口径、币种、观察时间、缓存指纹及缺失交易日诊断均保留。
- [x] QQQ 与默认 `^VIX` 的真实 Yahoo 数据能通过默认 API 回测完整加载，VIX 信号不因标的 symbol 串用而不可用；真实运行结果包含已对齐的 VIX 观测。
- [x] 所有被选策略/基准共享一致的行情和日历上下文；指标所需预热数据覆盖已启用周期，普通行情缺口不静默填充或跳过。
- [x] Yahoo 不可用、标的交易所不支持、缺少估值获取链路时返回明确本地化诊断；一个依赖失败不阻断其他策略。
- [x] Yahoo 与交易所日历依赖通过标准后端安装可用，服务启动不发网络请求；文档说明联网发生时机和 PE/SEC 数据限制。

**验证（2026-09-30）：** `backend/.venv/bin/python -m pytest` 通过 294 项，其中 `tests/runs/test_yahoo_data_live.py` 通过真实 Yahoo + 交易所日历请求，对 QQQ 和 `^VIX`、`^VXN`、`^VXD` 逐个提交完整 API 回测并检查来源、解析结束日、策略完成状态、VIX 信号可用和相对 DCA 指标；未用 fixture 或 mock 替代数据链路。普通行情/账本边界仍由固定 fixture 精确覆盖。Yahoo 1.7.0 当前发出 `raise_errors` 弃用警告，不影响结果。

**依赖：** Task 5、Task 6、Task 8、Task 14、Task 21、Task 22。

**可能触及：** `backend/app/runs/`、`backend/app/data/providers/yahoo.py`、`backend/app/main.py`、`backend/pyproject.toml`、`frontend/src/i18n/messages.ts`、`docs/development.md`、`README.md`。

**范围：** 中。

#### Task 24：修复运行诊断展示并统一配置表单与策略卡片

**描述：** 修复 `runs.execution` 的原始字段路径和 `{code}` 模板泄漏；统一共享设置、策略编辑器、选项/复选框与单位的标签、间距和控件高度；每个策略实例单独呈现为卡片，并说明条件组合逻辑作用于所有已启用买入条件。

**验收标准：**
- [x] 运行诊断显示日/中性用户文案，不显示原始 `runs.execution` 字段路径、内部 API code 或未插值的 `{code}`。
- [x] 共享设置中结束日期标签只出现一次；代码、日期不显示冗余单位；金额币种说明清楚且不会假定所有标的都是 USD。
- [x] 所有数值单位以内嵌尾缀呈现；所有参数统一使用粗体标签、相同控件高度和标签/输入/说明间距。
- [x] VIX 指数使用 Yahoo 已验证可取数的选项 `^VIX`、`^VXN`、`^VXD`，不接受任意自由文本代码。
- [x] 条件组合说明明确覆盖所有已启用买入条件；复选框等字段拥有清晰标签；策略实例分别放在独立卡片中。
- [x] 日文和中文文案、键盘可操作性及 320/768/1024px 布局通过现有前端单测和浏览器验收。

**验证（2026-09-30）：** `npm test`（59 项）、`npm run typecheck`、`npm run lint`、`npm run build` 和 `npm run test:e2e`（Chromium 9 项）全部通过。诊断组件断言不包含 `{code}`、`runs.execution` 或内部错误码；Playwright 验证日中 320/768/1024px、axe 可访问性和默认 VIX 运行/结果/CSV 全流程。共享设置组件测试确认结束日期只关联一个标签、代码/日期/币种不显示冗余后缀，数字单位位于输入框内。

**依赖：** Task 16、Task 17、Task 19、Task 23。

**可能触及：** `backend/app/catalog/definitions.py`、`backend/app/runs/yahoo_data.py`、`frontend/src/shared/ui/ParameterField.tsx`、`frontend/src/features/config/SharedSettingsForm.tsx`、`frontend/src/features/strategies/StrategyWorkspace.tsx`、`frontend/src/features/runs/StatusView.tsx`、`frontend/src/styles.css`、双语词典及 UI 设计稿。

**范围：** 中。

#### Task 25：改进金融图表并默认运行全部启用策略

**描述：** 针对实际回测界面完善结果图表：在保存结果快照中保留规范化的调整后 OHLC，展示带价格/日期坐标、网格、交易标记的 K 线与资产/回撤曲线；默认运行范围改为全部启用策略，避免添加新策略后只运行最后选中的实例。补充截图对应的固定结束日 QQQ + `^VIX` 真实 Yahoo API 回归。

**验收标准：**
- [x] Yahoo 规范化行情以模拟价格口径保存可验证的 OHLC；缺少可选 OHLC 不得让原本可用的回测失败。
- [x] 每条已保存结果的每日资产包含来源 OHLC，旧快照或 fixture 缺少 OHLC 时图表显示收盘价回退，不伪造蜡烛。
- [x] 资产、回撤和价格图显示完整网格、刻度、日期轴、数值轴及币种/百分比说明；价格图用 OHLC K 线并标记实际交易。
- [x] 初始运行范围为“全部启用策略”；添加其他实例不改变运行范围，前端提交与结果都包含所有已启用实例。
- [x] 真实 Yahoo API 固定日期回归复现截图中的 QQQ + `^VIX` 配置并完成；动态结束日及其它已验证指数回归继续通过。
- [x] 日文/中文、键盘可操作性、响应式布局和 HTML 原型同步更新。

**验证（2026-09-30）：** 后端 `python -m pytest`（297 项，含固定日期 QQQ + `^VIX` 和动态结束日 `^VIX`/`^VXN`/`^VXD` 的真实 Yahoo 回归）、Ruff check/format、mypy 全部通过；前端 `npm test`（64 项）、typecheck、lint、build 和 Playwright E2E（10 项）全部通过。E2E 覆盖日中 320/768/1024px、axe、OHLC K 线、VIX 观测/阈值、加入第二个策略后提交全部启用策略。浏览器截图已目视检查。Yahoo 1.7.0 在 `raise_errors=True` 处产生 6 条弃用警告，功能通过；作为低优先级维护项记录。

**后续调整：** 2026-09-30 用户明确改为传统价格折线；可叠加视图和联动时间轴拆入 Task 26–27，替代本任务的 K 线展示方案。

**依赖：** Task 23、Task 24。

**可能触及：** `backend/app/domain/contracts.py`、`backend/app/data/providers/yahoo.py`、`backend/app/ledger/engine.py`、`backend/tests/data/test_market_data.py`、`backend/tests/runs/test_yahoo_data_live.py`、`frontend/src/features/results/ResultsCharts.tsx`、`frontend/src/features/strategies/model.ts`、双语词典、API 类型、图表/多策略测试及 UI 设计稿。

**范围：** 中。

### 阶段 6：图表与参数表单可读性优化

#### Task 26：提供折线图叠加比较

**描述：** 用传统价格走势折线替代 K 线展示；增加图表组合控件，让用户选择价格、总资产、回撤和 VIX 等序列叠加比较。用户确认叠加模式将每条有效序列归一到起点 100，并清楚标示此相对口径；单图模式仍保留原始单位。

**验收标准：**
- [ ] 价格图展示规范化收盘价折线，不显示 K 线蜡烛；已保存成交仍可在价格/资产图上识别。
- [ ] 图表控件可多选要叠加的序列，并能返回单图布局；组合线共享日期范围与横坐标。
- [ ] 叠加线以各自首个有效值为基准归一到 100，轴和说明清楚写明相对指数；悬停/键盘可读数据同时提供日期、序列名和原始值。
- [ ] 日文/中文、响应式布局、键盘交互与图表可访问性通过测试和浏览器验收。

**依赖：** Task 25。

**可能触及：** `frontend/src/features/results/ResultsCharts.tsx`、结果图表样式和文案、图表组件测试、E2E 及 UI 原型。

**范围：** 中。

**设计参考：** moomoo 官方图表帮助说明了序列叠加、显示/隐藏控制和历史图拖动/缩放交互：[Charts](https://www.moomoo.com/us/support/topic3_33)、[Custom superimposition](https://www.moomoo.com/us/support/topic3_131)。本产品叠加的是回测序列，使用起点 100 的相对指数，不复刻其证券行情或品牌样式。

#### Task 27：同步图表的时间轴拖动与缩放

**描述：** 让所有单独图表及叠加图共享一个可视日期窗口。用户在任一图表横向拖动或调整窗口后，其余图表同步更新；加入重置和键盘可操作的范围控件。

**验收标准：**
- [ ] 各图表使用同一日期窗口、起止刻度和横向定位；拖动/缩放任一图表会同步更新其它图表与叠加视图。
- [ ] 可恢复完整历史范围；短数据集、窄屏和触屏拖动不会让图表失去可读性或造成页面横向溢出。
- [ ] 时间窗口操作可通过键盘控件访问，焦点和可见状态有明确标签。
- [ ] Playwright 回归分别从价格、资产和 VIX 图发起窗口调整，并确认其它图表的日期窗口一致。

**依赖：** Task 26。

**可能触及：** 图表共享状态、`ResultsCharts.tsx`、图表样式、前端交互测试和 E2E。

**范围：** 中。

**设计参考：** 采用 moomoo 图表的拖动查看历史区间、滚轮/按钮缩放模式，并扩展为本产品多图共享一个日期窗口：[Charts](https://www.moomoo.com/us/support/topic3_33)。

#### Task 28：为参数目录添加策略字段分组元数据

**描述：** 在后端唯一 `ParameterDefinition` 注册表为策略参数提供稳定分组标识与本地化分组名，使前端按业务主题呈现参数，不从字段键名猜测分组。

**验收标准：**
- [ ] 每个可见策略参数都属于注册表定义的有效分组，分组与参数的适用目录、默认值等元数据同时从后端提供。
- [ ] OpenAPI/前端 API 类型生成和双语分组文案覆盖所有目录与字段。
- [ ] catalog/契约测试发现缺失、无效或重复分组，并继续保护字段注册表唯一事实来源。

**依赖：** Task 25。

**可能触及：** 后端参数注册表与 catalog 契约、OpenAPI 类型、前端双语词典及对应测试。

**范围：** 中。

**设计参考：** moomoo 指标管理把名称、说明、指标列表和参数设定分区呈现；我们将其信息分层方式映射到策略参数分组元数据：[Desktop indicator management](https://www.moomoo.com/us/support/topic3_525)、[Edit indicator](https://www.moomoo.com/us/support/topic3_39)。

#### Task 29：按主题分卡片展示策略字段并提升选项说明可读性

**描述：** 在各策略卡片内部用清晰的主题区块组织同类输入；统一下拉框、枚举、复选框与数值控件的标签、间距、辅助说明和视觉层级，提高整个配置区域的信息可扫读性。

**验收标准：**
- [ ] 策略参数按 Task 28 的 catalog 分组元数据显示为独立小卡片/区块；组名和内容在日文、中文下清楚且不依赖颜色传意。
- [ ] 所有下拉/选项控件的标签与说明清晰可读，选项描述不会被截断；控件、说明和相邻分组间距统一。
- [ ] 共享设置与各策略参数呈现明确的信息层级，输入值、单位、条件依赖和说明可一眼区分。
- [ ] 键盘/ARIA、长文案和 320/768/1024px 响应式布局通过测试、axe 与浏览器验收。

**依赖：** Task 28。

**可能触及：** `StrategyWorkspace.tsx`、`ParameterField.tsx`、共享配置表单、样式、双语词典、前端测试、E2E 与 UI 原型。

**范围：** 中。

**设计参考：** 参考 moomoo 指标条目的显示/隐藏、设置入口和说明/参数分区，结合现有 catalog 元数据优化表单可扫读性：[Technical indicators](https://www.moomoo.com/us/support/topic3_32)、[Desktop indicator management](https://www.moomoo.com/us/support/topic3_525)。

### 最终检查点

- [ ] 所有计划任务验收标准完成；后端/前端测试、类型检查、lint、构建和 E2E 全部通过。
- [ ] 设计稿中的实现验收标准有测试或明确的手工检查记录；纯计算使用确定性 fixture，默认 Yahoo 数据链由真实供应商 API 回归验证。
- [ ] 运行快照、四类导出、诊断、smoke 报告和开发文档保留来源/截至时间语义；数据不可用不伪装成零收益。
- [ ] 用户要求的已保存运行结果可在服务重启后恢复；notebook 映射与来源哈希已固化并完成审计。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| PE/SEC 公开时间、EPS 口径和 ETF 历史持仓复杂 | 高 | 先做 fixture 和 as-of 纯函数；数据不可用显式返回；live 仅 smoke。 |
| Yahoo/SEC 网络不稳定或限流 | 高 | 适配器与内核隔离、缓存和指纹、默认离线测试、超时/来源诊断。 |
| t+1 成交、月末安全阀和固定/择时资金混淆 | 高 | 先锁定日历/账本黄金测试，再接 API/UI；所有入口只调用统一 ledger。 |
| 前后端重复维护字段边界 | 中 | 后端注册表 + OpenAPI/类型生成；契约测试拒绝前端默认值漂移。 |
| 当前仓库无脚手架且设计稿有未提交修改 | 中 | Task 1 只新增脚手架；开发前确认设计稿基线，不回滚现有工作。 |
| UI 状态（编辑/启用/聚焦/显隐）相互污染 | 中 | 按领域状态模型拆分 store，Task 17–18 做状态组合测试。 |

## 开始前确认项与决策记录

1. 用户于 2026-09-29 确认：V1 运行结果需要服务重启后恢复；由 Task 22 实现。
2. Python/Node 包管理器、图表库和浏览器测试工具已由 Task 1 的配置固定。
3. 两个外部 notebook 的映射、来源哈希和 fixture 已入库；运行时不读取 notebook 路径。
4. Task 21 的 smoke 不增加交易所日历依赖，Yahoo 覆盖率按工作日估计并说明节假日限制；SEC smoke 要求显式 `SEC_USER_AGENT`，Yahoo 超时默认为 10 秒，SEC 单请求不重试，规范化缓存只存内存且无磁盘缓存目录。
5. 本地作业按单机单进程实现，不承诺跨进程并发。

## Definition of Done

- 确定性测试不访问网络且全绿；live smoke 独立可运行。
- 后端类型/格式检查、前端 lint/typecheck/build 和 E2E 全绿。
- 每个功能切片有验收标准、回归测试和必要的诊断/文档。
- 普通策略、基准、搜索、结果图表、表格和 CSV 均从同一账本/不可变快照派生。
- 未实现功能不以 stub、跳过测试、静默缺失或零收益冒充完成。
