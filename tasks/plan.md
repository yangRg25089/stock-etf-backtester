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

**描述：** 针对实际回测界面完善结果图表：在保存结果快照中保留规范化的调整后 OHLC 数据，以收盘价走势折线替代 K 线展示，并提供价格/日期坐标、网格和交易标记；默认运行范围改为全部启用策略，避免添加新策略后只运行最后选中的实例。补充截图对应的固定结束日 QQQ + `^VIX` 真实 Yahoo API 回归。

**验收标准：**
- [x] Yahoo 规范化行情以模拟价格口径保存可验证的 OHLC；缺少可选 OHLC 不得让原本可用的回测失败。
- [x] 每条已保存结果的每日资产包含来源 OHLC，旧快照或 fixture 缺少 OHLC 时图表显示收盘价回退；OHLC 保留为来源数据，不生成或展示 K 线。
- [x] 资产、回撤和价格图显示完整网格、刻度、日期轴、数值轴及币种/百分比说明；价格图使用收盘价走势折线并标记实际交易。
- [x] 初始运行范围为“全部启用策略”；添加其他实例不改变运行范围，前端提交与结果都包含所有已启用实例。
- [x] 真实 Yahoo API 固定日期回归复现截图中的 QQQ + `^VIX` 配置并完成；动态结束日及其它已验证指数回归继续通过。
- [x] 日文/中文、键盘可操作性、响应式布局和 HTML 原型同步更新。

**验证记录（2026-09-30，K 线方案后被用户调整）：** 后端 `python -m pytest`（297 项，含固定日期 QQQ + `^VIX` 和动态结束日 `^VIX`/`^VXN`/`^VXD` 的真实 Yahoo 回归）、Ruff check/format、mypy 全部通过；前端 `npm test`（64 项）、typecheck、lint、build 和 Playwright E2E（10 项）全部通过。当时 E2E 验证 K 线、VIX 观测/阈值、加入第二个策略后提交全部启用策略，以及日中 320/768/1024px 和 axe。2026-09-30 用户改为收盘价折线，现行折线验收见 Task 26。Yahoo 1.7.0 在 `raise_errors=True` 处产生 6 条弃用警告，功能通过；作为低优先级维护项记录。

**后续调整：** 2026-09-30 用户明确改为传统价格折线；可叠加视图和联动时间轴拆入 Task 26–27，替代本任务的 K 线展示方案。

**依赖：** Task 23、Task 24。

**可能触及：** `backend/app/domain/contracts.py`、`backend/app/data/providers/yahoo.py`、`backend/app/ledger/engine.py`、`backend/tests/data/test_market_data.py`、`backend/tests/runs/test_yahoo_data_live.py`、`frontend/src/features/results/ResultsCharts.tsx`、`frontend/src/features/strategies/model.ts`、双语词典、API 类型、图表/多策略测试及 UI 设计稿。

**范围：** 中。

### 阶段 6：图表与参数表单可读性优化

#### Task 26：提供折线图叠加比较

**描述：** 用传统价格走势折线替代 K 线展示；增加图表组合控件，让用户选择价格、总资产、回撤和 VIX 等序列叠加比较。用户确认叠加模式将每条有效序列归一到起点 100，并清楚标示此相对口径；单图模式仍保留原始单位。

**验收标准：**
- [x] 价格图展示规范化收盘价折线，不显示 K 线蜡烛；已保存成交仍可在价格/资产图上识别。
- [x] 图表控件可多选要叠加的序列，并能返回单图布局；组合线共享日期范围与横坐标。
- [x] 叠加线以各自首个有效值为基准归一到 100，轴和说明清楚写明相对指数；键盘可聚焦序列并读取日期、序列名和末端原始值。
- [x] 日文/中文、响应式布局、键盘交互与图表可访问性通过单元测试、axe 和浏览器验收。

**依赖：** Task 25。

**可能触及：** `frontend/src/features/results/ResultsCharts.tsx`、结果图表样式和文案、图表组件测试、E2E 及 UI 原型。

**范围：** 中。

**设计参考：** moomoo 官方图表帮助说明了序列叠加、显示/隐藏控制和历史图拖动/缩放交互：[Charts](https://www.moomoo.com/us/support/topic3_33)、[Custom superimposition](https://www.moomoo.com/us/support/topic3_131)。本产品叠加的是回测序列，使用起点 100 的相对指数，不复刻其证券行情或品牌样式。

#### Task 27：同步图表的时间轴拖动与缩放

**描述：** 让所有单独图表及叠加图共享一个可视日期窗口。用户在任一图表横向拖动或调整窗口后，其余图表同步更新；加入重置和键盘可操作的范围控件。

**验收标准：**
- [x] 各图表使用同一日期窗口、起止刻度和横向定位；拖动/缩放任一图表会同步更新其它图表与叠加视图。
- [x] 可恢复完整历史范围；短数据集、窄屏和触屏拖动不会让图表失去可读性或造成页面横向溢出。
- [x] 时间窗口操作可通过键盘控件访问，焦点和可见状态有明确标签。
- [x] Playwright 回归分别从价格、资产和 VIX 图发起窗口调整，并确认其它图表的日期窗口一致。

**依赖：** Task 26。

**可能触及：** 图表共享状态、`ResultsCharts.tsx`、图表样式、前端交互测试和 E2E。

**范围：** 中。

**设计参考：** 采用 moomoo 图表的拖动查看历史区间、滚轮/按钮缩放模式，并扩展为本产品多图共享一个日期窗口：[Charts](https://www.moomoo.com/us/support/topic3_33)。

#### Task 28：为参数目录添加策略字段分组元数据

**描述：** 在后端唯一 `ParameterDefinition` 注册表为策略参数提供稳定分组标识与本地化分组名，使前端按业务主题呈现参数，不从字段键名猜测分组。

**验收标准：**
- [x] 每个可见策略参数都属于注册表定义的有效分组，分组与参数的适用目录、默认值等元数据同时从后端提供。
- [x] OpenAPI/前端 API 类型生成和双语分组文案覆盖所有目录与字段。
- [x] catalog/契约测试发现缺失、无效或重复分组，并继续保护字段注册表唯一事实来源。

**依赖：** Task 25。

**可能触及：** 后端参数注册表与 catalog 契约、OpenAPI 类型、前端双语词典及对应测试。

**范围：** 中。

**设计参考：** moomoo 指标管理把名称、说明、指标列表和参数设定分区呈现；我们将其信息分层方式映射到策略参数分组元数据：[Desktop indicator management](https://www.moomoo.com/us/support/topic3_525)、[Edit indicator](https://www.moomoo.com/us/support/topic3_39)。

#### Task 29：按主题分卡片展示策略字段并提升选项说明可读性

**描述：** 在各策略卡片内部用清晰的主题区块组织同类输入；统一下拉框、枚举、复选框与数值控件的标签、间距、辅助说明和视觉层级，提高整个配置区域的信息可扫读性。

**验收标准：**
- [x] 策略参数按 Task 28 的 catalog 分组元数据显示为独立小卡片/区块；组名和内容在日文、中文下清楚且不依赖颜色传意。
- [x] 所有下拉/选项控件的标签与说明清晰可读，选项描述不会被截断；控件、说明和相邻分组间距统一。
- [x] 共享设置与各策略参数呈现明确的信息层级，输入值、单位、条件依赖和说明可一眼区分。
- [x] 键盘/ARIA、长文案和 320/768/1024px 响应式布局通过测试、axe 与浏览器验收。

**依赖：** Task 28。

**可能触及：** `StrategyWorkspace.tsx`、`ParameterField.tsx`、共享配置表单、样式、双语词典、前端测试、E2E 与 UI 原型。

**范围：** 中。

**设计参考：** 参考 moomoo 指标条目的显示/隐藏、设置入口和说明/参数分区，结合现有 catalog 元数据优化表单可扫读性：[Technical indicators](https://www.moomoo.com/us/support/topic3_32)、[Desktop indicator management](https://www.moomoo.com/us/support/topic3_525)、[Edit indicator](https://www.moomoo.com/us/support/topic3_39)。

**阶段 6 验收（2026-09-30）：** 后端 `cd backend && .venv/bin/python -m pytest`（299 项全部通过；6 条 yfinance `raise_errors` 弃用警告）、Ruff check/format、mypy 全部通过；前端 `npm test`（74 项）、typecheck、lint、build 和 Playwright E2E（10 项）全部通过。E2E 覆盖日中界面、320/768/1024px、axe、分组/选项说明、价格折线、叠加归一、任一图表拖动/缩放后同步、运行/恢复/CSV；浏览器无页面异常或非本地请求。已目视检查完整运行截图，未发现中高优先级布局缺陷。

## 阶段 7：修复 SQLite 参数恢复与运行进度请求

#### Task 30：无损恢复已保存运行参数并替代重复完整结果轮询

**描述：** 修复策略 `Decimal` 等参数经 SQLite JSON 保存后被读回为字符串、导致 VIX 信号计算失败的问题。增加轻量的运行进度事件流，让页面在一个连接中接收策略状态变化，终态后只获取一次完整结果；页面恢复最近的未完成运行也使用相同进度接口。诊断保留可安全呈现的失败阶段与定位标识，不向界面泄漏 Python 异常文本、内部字段路径或未翻译代码。

**验收标准：**
- [x] SQLite RunStore 的版本化私有编码保留 `Decimal`、bool、整数、浮点和列表参数；读回领域快照与写入前等值，普通 API JSON 仍保持既有结构及十进制字符串语义。
- [x] 兼容已有未版本化 JSON 运行记录；类型恢复只按注册表参数类型执行，不按字符串外观猜数字，旧记录的配置、结果和幂等身份不变。
- [x] 默认真实 Yahoo 回归经临时 SQLite RunStore 执行 QQQ + `^VIX`、`^VXN`、`^VXD`；真实波动率指数观察、策略 `completed` 或仅带来源质量警告的 `completed_with_warning`、信号与指标存在；确定性 SQLite + fixture 测试覆盖 round trip 和局部失败。
- [x] 动态结束日期按真实最后有效报价解析；供应商暂缺最新已收盘日时明确降到最后完整报价日并附警告，区间内部缺口仍使依赖策略不可用。
- [x] `GET /api/v1/runs/{run_id}/events` 返回轻量 SSE 状态事件，在状态变化后发送当前聚合进度与策略状态，终态发出结束事件并关闭；未知 ID 保持标准 404，断开客户端会停止该订阅。
- [x] 提交和恢复中的前端通过一个可取消的 SSE 连接呈现进度，收到终态后只调用一次 `GET /api/v1/runs/{run_id}` 获取完整结果；不再使用 700ms 整体响应轮询或建立重叠订阅。
- [x] 计算失败诊断包含安全的阶段/运行标识并有日中译文；不显示原始异常文本、内部错误码、路径或 `{code}` 占位符。
- [x] 前端请求单测、API/SSE 合约及生命周期集成测试、后端全量测试、真实 Yahoo 回归、前端 typecheck/lint/build、浏览器 E2E 和网络计数均通过。

**依赖：** Task 14、Task 22、Task 23、Task 24。

**可能触及：** `backend/app/runs/sqlite_store.py`、`backend/app/runs/store.py`、`backend/app/api/runs.py`、`backend/app/runs/manager.py`、真实 Yahoo 和 SQLite/API 测试、`frontend/src/api/runs.ts`、`frontend/src/App.tsx`、运行状态 reducer/词典、前端 API/E2E 测试、相关设计及开发文档。

**范围：** 中。

**调查依据（2026-09-30）：** 运行 `4ac3b0ab-c3b3-4a3d-beff-8cdb6e74945e` 的 GET 为 HTTP 200，响应为 `completed_with_warning`，其中两个基准完成、VIX 策略带 `ValueError` 失败诊断。只读读取保存参数确认阈值为字符串 `'25'`；以同区间真实 Yahoo 数据隔离重放时取得 1694 条 QQQ 行情和 1694 条 VIX 观测，保存类型抛出 `ValueError: vix.buyThreshold must be numeric`，恢复注册表声明的 Decimal 类型后策略成功并有 39 笔交易。前端目前有运行提交与恢复两个 700ms GET 轮询入口。不得改写调查运行记录。

**Task 30 验收（2026-09-30）：** 后端全量 pytest 309 项通过，包含临时 SQLite 上真实 Yahoo QQQ/VIX API 回归；动态最新报价尾部延迟时所有策略成功并带来源质量警告。Ruff check/format 与 mypy 通过。前端 77 项单测、typecheck、lint、build 和 12 项 Playwright E2E 通过；浏览器计数确认提交和恢复各使用一个 SSE 连接及一个具体运行 ID 的终态 GET，另有独立 `/runs/latest` 恢复查询。Playwright 临时服务使用 8123/5174 端口，避免影响仍在运行的 VS Code API。

## 阶段 8：行情缺口静默处理与核心曲线合图

#### Task 31：跳过孤立行情缺口并合并价格与总资产图

**描述：** 按用户确认移除“最新交易日行情未发布”的警告；动态结束日使用最后有效行情日。对于每段只有一个缺失交易日的行情缺口，从全部策略共享的交易日历中移除该日，不合成/前向填充价格，也不显示缺口警告；连续缺失两日及以上仍明确报数据不可用。结果页始终把标的价格与总资产放在同一张核心比较图，统一按各自起点 = 100 显示，并标明 100 基准线和保留原始单位的图例/悬停值；图表叠加/分开展示控件仍控制辅助指标。

**验收标准：**
- [x] 动态结束日尾部供应商延迟无警告，运行日历落在最后有效收盘日。
- [x] 固定/动态区间内任意孤立单日缺口从共享日历移除且没有填充价格或失败诊断；相邻连续的两日缺口仍返回必需行情不可用。
- [x] 价格与总资产默认在同一图中；切换显示模式后仍同图，辅助指标可单独显示或按选择叠加。
- [x] 没有已选辅助指标可加入时禁用叠加控件，避免可点击但无变化的空操作。
- [x] 核心图清楚呈现相对指数起点 100 参考线、日期轴、原始序列名/币种图例与悬停值。
- [x] 图表时间范围拖动和缩放继续同步；中日文、键盘/ARIA、320/768/1024/1440px E2E 验收通过。

**依赖：** Task 23、Task 26、Task 27、Task 30。

**可能触及：** `backend/app/runs/yahoo_data.py`、行情日历回归测试、主设计稿、任务进度、`frontend/src/features/results/ResultsCharts.tsx`、图表样式与双语词典、图表/浏览器测试及 UI 原型。

**范围：** 中。

**设计依据：** 用户明确不需要“最新交易日尚未发布”警告，且允许跳过单日行情缺失；多日连续缺口仍保留错误状态以避免隐藏较大缺数区间。moomoo 官方资料提供自定义叠加、拖动/缩放和涨跌幅切换参考：[Charts](https://www.moomoo.com/us/support/topic3_33)、[Custom superimposition](https://www.moomoo.com/us/support/topic3_131)、[Watchlist price change](https://www.moomoo.com/us/support/topic3_44)。共同起点 100 延续本项目已确认的可比口径。

**Task 31 验收记录（2026-09-30）：** `backend/tests/runs/test_yahoo_data.py` 覆盖动态尾部、固定区间孤立缺口、多处孤立缺口、连续缺口不可用及空日历保护；311 项后端全量测试通过，包含真实 Yahoo + SQLite QQQ/VIX API 回归。Ruff check/format 和 mypy 通过。前端 78 项测试、typecheck、lint 和 build 通过；12 项 Playwright E2E 通过，覆盖日中/中文、320/768/1024/1440px、图表图例和键盘操作、三张图拖动/缩放同步、100 基准线在缩放后仍位于绘图区、axe 与本地网络请求。已目视检查完成结果页截图；浏览器无页面错误或非本地请求。Yahoo SDK 有 6 条既有 `raise_errors` 弃用警告。

## 阶段 9：图表尺度与滚轮隔离

#### Task 32：修正注资调整后的相对资产曲线并隔离图表滚轮

**描述：** 当前相对图把持续注资后的总资产金额直接除以最初本金，后续外部注资被误画成投资收益并拉大共享纵轴，导致 QQQ 价格走势几乎压成直线。将资产相对曲线改用结果快照已有的现金流调整单位净值 `unitNav` 归一到 100；图例保留总资产及币种，悬停继续显示实际美元总资产。图表上的滚轮缩放使用非被动原生监听并阻止事件继续触发页面滚动或浏览器缩放；触屏在图表区域操作时也不触发页面原生平移/缩放。

**验收标准：**
- [x] 定投注资只增加资产金额，不会放大总资产相对表现曲线的纵轴；图表同一指数轴上仍能辨认 QQQ 价格变化。
- [x] 总资产曲线使用现金流调整后的单位净值；悬停保留实际资产金额与原币种。
- [x] 旧结果缺少单位净值时显示明确提示，不退回把注资误画成收益的美元金额归一。
- [x] 在核心图、回撤图、VIX 图上使用滚轮，日期窗口和所有图同步更新，页面 `scrollY` 与视口缩放比例不变。
- [x] 键盘/按钮缩放与拖动同步行为保持有效；图表区域触控不触发页面原生平移/缩放。
- [x] 前端单测、320/768/1024/1440px 浏览器 E2E、axe、typecheck、lint 和 build 通过；设计稿及进度清单同步。

**依赖：** Task 31。

**可能触及：** `frontend/src/features/results/chartModel.ts`、`ResultsCharts.tsx`、`styles.css`、图表双语文案、前端图表测试、结果页 E2E、主设计稿和任务清单。

**范围：** 中。

**设计依据：** 资产相对表现须剔除外部现金流对账户总额的影响；领域结果已提供 `unitNav`，其同一口径也用于回撤计算。用户已确认价格与总资产在起点 100 的同图比较及任一图同步缩放/拖动。

**Task 32 验收记录（2026-09-30）：** 前端 `npm test` 82 项通过；`npm run typecheck`、`npm run lint`、`npm run build` 和 `git diff --check` 通过。Playwright E2E 12 项全量通过，且图表回归定向重跑 1 项通过；覆盖 320/768/1024/1440px、axe、核心/回撤/VIX 图滚轮后的页面 `scrollY` 不变、Control+滚轮后的窗口/视口缩放、所有图的时间范围同步及图表 `touch-action: none`。单位净值 fixture 确认外部注资不再压扁 QQQ 曲线，同时悬停保留原始美元金额；缺少单位净值时明确显示不可用提示。未连接实体触屏设备；触摸手势隔离由浏览器计算样式与 CSS `touch-action: none` 实现。

## 阶段 10：图表操作精度与共通设置排版

#### Task 33：降低图表手势灵敏度并分组整理共通设置

**描述：** 降低图表拖动的平移幅度和滚轮的单次缩放幅度，让浏览区间更容易精细控制；叠加曲线较多时减细线条，保留足够可见度；将共通设置从单行字段拆成“标的与区间”和“投入计划”两个有标题的语义分组，并同步响应式布局和 UI 原型。

**验收标准：**
- [x] 滚轮总位移 160px 约改变 8% 的可视区间；相同总位移拆分成多个触控板事件后结果一致。同样的指针位移只平移原先约一半的距离。
- [x] 两条相对曲线使用比当前更细的线宽；三条及以上曲线使用更细线宽，颜色、图例和焦点可见性保持清晰。
- [x] 共通设置分成可辨识的“标的与区间”及“投入计划”两组；每组字段在桌面和窄屏内合理换行，320/768/1024/1440px 均无溢出。
- [x] 两种语言均显示分组标题；字段标签、帮助说明、键盘操作和辅助技术语义保持有效。
- [x] 单元测试、浏览器 E2E/axe、typecheck、lint、build 和设计原型检查通过。

**依赖：** Task 32。

**可能触及：** `frontend/src/features/config/SharedSettingsForm.tsx`、`frontend/src/features/results/ResultsCharts.tsx`、`frontend/src/styles.css`、双语词典、前端响应式/表单/浏览器测试及 `docs/design/backtest-ui.html`。

**范围：** 小。

**Task 33 验收记录（2026-09-30）：** 前端 85 项单元测试、typecheck、lint、build、`git diff --check` 和 12 项 Playwright E2E 通过。浏览器复现表明方向计数式滚轮处理会使一次 `deltaY=-160` 得到 0.92 的窗口跨度，而 16 次 `deltaY=-10` 只剩 0.263；已改为按累积滚动距离连续缩放，单元和 E2E 均确认两者结果一致。E2E 按 45px 指针拖动验证平移约为未调低前的 50%，并断言两条曲线线宽为 1.8、四条时为 1.5；中日文的共通设置分组在 320/768/1024/1440px 都无溢出，axe 无违规，主运行流程无浏览器 console/page 错误或非本地请求。稳定性扫描另通过后端 309 项确定性测试和 2 项真实 Yahoo 测试，Ruff 与 mypy 通过。真实 Yahoo 测试仍有 6 条既有 SDK 弃用警告（`raise_errors`），已知低优先级；实体触屏设备未连接，触屏行为沿用 Pointer Events 与 `touch-action: none`。

### 最终检查点

- [x] 所有计划任务验收标准完成；后端/前端测试、类型检查、lint、构建和 E2E 全部通过。
- [x] 设计稿中的实现验收标准有测试或明确的手工检查记录；纯计算使用确定性 fixture，默认 Yahoo 数据链由真实供应商 API 回归验证。
- [x] 运行快照、四类导出、诊断、smoke 报告和开发文档保留来源/截至时间语义；数据不可用不伪装成零收益。
- [x] 用户要求的已保存运行结果可在服务重启后恢复；notebook 映射与来源哈希已固化并完成审计。

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

## 阶段 11：双区回测工作台 UI/UX

用户于 2026-09-30 确认工作台方案并要求整体计划和验收条件立即进入实施。事实来源为 [`docs/design/backtest-workspace-ux.md`](../docs/design/backtest-workspace-ux.md)。按 Task 34→38 顺序逐项执行 loop-engineering 检查循环，不跨 task。

### Task 34：搭建全宽工作台骨架与常驻运行条

**描述：** 将纵向瀑布页整理为宽屏双区：左侧配置、右侧结果。增加紧凑运行条，保留范围、开始按钮、禁用原因和进度。页面充分使用可用宽度；配置区能收起并通过指针/键盘调整。

**验收标准：**
- [x] ≥1280px 使用全宽双区；配置栏初始约 350px，可调整至 320–420px；移除 1180px 主内容宽度上限。
- [x] 应用顶栏与标题/ETF 信息运行条固定可见；标的/日期/投入摘要、运行范围、按钮和进度保持可访问。
- [x] 左侧共享设置与策略列表固定；策略详情区单独滚动，右侧结果另有独立滚动区；滚动其中一区不移动其他固定内容或另一区。
- [x] 折叠/展开、调整宽度可用键盘和指针操作并有可见焦点，不改变其他独立 UI 状态。
- [x] 768–1279px 优先保证结果可读；窄屏不被固定双栏挤压。

**验证：** 新增布局/运行条前端测试和 E2E；1280/1440/1920px 布局与 1024px 配置抽屉检查；浏览器检查顶区和左侧固定区位置、左右滚动区相互隔离；typecheck、lint、build、`git diff --check`。

**完成记录（2026-09-30）：** 宽屏工作台使用剩余可视宽度，配置栏初始 350px 并限制在 320–420px；顶栏与 ETF/运行上下文常驻，左侧共享设置/策略导航固定，策略编辑和结果各自独立滚动。768–1279px 默认优先显示结果，配置以抽屉展开。前端 `npm test`（86 项）、typecheck、lint、production build 和 Playwright E2E（19 项）通过；E2E 覆盖 320/375/768/1024/1280/1440/1920px 的日中界面、独立滚动、键盘/指针调宽及配置折叠，axe 与默认运行/结果/CSV 流程通过。此前发现并修复 720px 高度时策略导航被挤出可点击区，以及断点改变后配置侧栏未自动折叠的问题。

**依赖：** Task 33。**可能触及：** `App.tsx`、`RunControls.tsx`、`frontend/src/styles.css`、布局测试。**范围：** 中。

### Task 35：共享设置摘要与策略导航/单策略编辑

**描述：** 将唯一共享表单收进可展开区域，并把策略编辑器改为实例列表 + 当前选中实例编辑器；保留 catalog 分组、七类策略、字段依赖及诊断。

**验收标准：**
- [x] 共享摘要和展开表单一致；动态最新日期、字段校验、默认值仍由原表单/catalog 管线提供。
- [x] 列表保留添加七类目录、启停、移除、参数摘要与校验状态；只有当前策略展开完整参数。
- [x] 切换编辑对象只改变 `activeStrategyId`，不改变启用、`runScope`、`focusedResultId`、曲线显隐或保存快照。
- [x] 分组、帮助、单位、依赖禁用值、中日文和错误路径不退化；折叠不丢参数。

**验证：** 覆盖共通设置、多个策略、策略切换及启用/范围/结果焦点独立性的前端测试和 E2E；typecheck、lint、build、`git diff --check`。

**完成记录（2026-09-30）：** 左侧摘要现在和同一 `SharedSettingsForm` 共用标的、日期与月度投入数据；摘要折叠/展开没有副本状态。实例列表显示参数摘要、校验状态与启停/移除操作，仅编辑当前实例；目录选项仍来自 catalog。新增浏览器场景先验证摘要随标的/期间/投入日程变化，再运行多个实例，并确认切换编辑策略不改启用、运行范围、已聚焦基准结果、图表显示状态或运行后编辑值；运行后改草稿仍明确标记保存快照过期。前端 86 项测试、typecheck、lint、build 和全量 E2E 20 项通过，`git diff --check` 通过。

**依赖：** Task 34。**可能触及：** `SharedSettingsForm.tsx`、`StrategyWorkspace.tsx`、策略模型、词典和测试。**范围：** 中。

### 检查点 G：桌面配置与运行路径

- [x] 宽屏工作台可收起、调宽并保留可访问焦点。
- [x] 共享设置、单策略编辑和运行条完整可用。
- [x] 编辑、启停、范围、结果焦点和曲线显隐相互独立。
- [x] Task 34–35 前端测试、E2E、typecheck、lint、build 通过。

### Task 36：结果概览、主图与同步辅助图

**描述：** 在结果区优先展示保存状态、核心指标与价格/总资产主图；辅助序列按需展示，缩减垂直空间，但不改数据口径。

**验收标准：**
- [x] 首要显示期末总资产、投入收益率、XIRR、最大回撤；其余既有指标仍可访问。
- [x] 价格和现金流调整总资产同图、起点 100；保留原始价格/金额、图例、轴和网格；不显示 K 线。
- [x] 辅图可折叠/叠加并共用日期窗口、拖动、缩放和重置；图表操作不带动页面。
- [x] 旧快照、空数据、失败和不可用状态准确显示，不伪造 KPI 或折线。

**验证：** 图表模型/组件/E2E 检查同图口径、显隐/叠加、时间同步和 no-data 状态；typecheck、lint、build、`git diff --check`。

**完成记录（2026-09-30）：** 已保存且可用的结果先显示四项核心 KPI，紧接主走势对比图；其他原有指标保留在完整指标入口。比较表后移到主图之后的详情区域。图表仍使用已保存数据：总资产按现金流调整单位净值归一至 100，价格和金额原始读数保持可查，辅助序列显隐/叠加与所有图的时间范围、拖动、缩放、重置共用同一视口；失败/无指标状态不会伪造 KPI 或折线。单元测试 88 项通过，E2E 20 项通过（排序断言及原有统一日期窗口/缩放拖动/基准 100 验收均通过），typecheck、lint、build 和 `git diff --check` 通过。

**依赖：** 检查点 G。**可能触及：** `ResultViewer.tsx`、`ResultSummary.tsx`、`ResultsCharts.tsx`、图表样式与测试。**范围：** 中。

### Task 37：结果详情标签页、比较表与快照导出

**描述：** 把策略比较、交易、完整指标、网格搜索结果和导出放入清楚的详情导航；保留焦点策略、部分失败和保存快照语义。

**验收标准：**
- [x] 默认策略比较；标签可键盘访问；仅有搜索结果时显示搜索标签。
- [x] 策略/基准、状态与现有全部绩效列可访问；表格的横向滚动不扩大整页。
- [x] 图表、指标、交易、搜索与导出来自同一个已保存的聚焦结果；草稿编辑不改变旧结果。
- [x] 成功、部分成功、失败、不可用、运行中、校验错误和无结果状态/诊断均可发现，失败不遮挡成功结果。
- [x] CSV 继续导出不可变快照的四类文件，字段不变。

**验证：** 结果导航/结果焦点/诊断及四类快照导出前端测试和 E2E；typecheck、lint、build、`git diff --check`。

**完成记录（2026-09-30）：** 结果区详情使用可访问的 tablist/tabpanel，默认策略比较；左右方向键循环切换，Home/End 定位，完整指标、交易和导出常驻，搜索结果只在聚焦结果确有网格数据时出现。比较表保留策略/基准身份、状态和所有绩效列；诊断仍留在结果概览且局部失败行不影响成功结果。所有面板读同一 `focusedResult`，导出仍传原 runId/resultId，没有改动 CSV 路径、字段或数据。测试先确认缺少 tab 语义后实现；前端 88 项测试、typecheck、lint、build 通过；定向 E2E 验证方向键/Home/标签切换、完整指标、日资产/交易/汇总 CSV 下载、失败/禁用导出项及草稿变更后 CSV 仍对应保存快照。

**依赖：** Task 36。**可能触及：** 结果比较、交易、搜索、导出、诊断视图与测试。**范围：** 中。

### 检查点 H：结果概览及快照语义

- [x] 主图和辅助图层级清楚，日期操作跨图同步。
- [x] 图表、指标、比较、交易、搜索和 CSV 对应同一保存快照。
- [x] 局部失败及空/不可用状态清楚，不遮挡可用结果。
- [x] Task 36–37 前端测试、E2E、typecheck、lint、build 通过。

### Task 38：响应式、无障碍与全流程验收

**描述：** 完成中/日文 320–1920px 响应式和实际浏览器验收，修复可复现问题，并同步正式 UI 原型、文档和进度。

**验收标准：**
- [x] 320/375/767/768/1024/1280/1440/1920px 无整页横向溢出、裁切、重叠；表格溢出局限于自身滚动区。
- [x] 1440×900 同时辨识运行条、当前编辑器、核心 KPI、主图绘图区和详情入口；1920px 无大片空白。
- [x] 新交互支持键盘和辅助技术，触屏命中区至少 44px；axe 无严重/高优先级违规。
- [x] empty、校验错误、运行中、成功、部分成功、失败、unavailable 和旧快照状态有自动或手工回归记录。
- [x] UI 原型、工作台设计文档、todo 与实现同步；全前端测试、typecheck、lint、build、E2E 与最终代码审查通过。

**验证：** `cd frontend && npm test && npm run typecheck && npm run lint && npm run build && npm run test:e2e`；另外执行多视口浏览器/axe 检查和 `git diff --check`。

**完成记录（2026-09-30）：** 完成移动端“设置/结果”切换及日中 320/375/767/768/1024/1280/1440/1920px 浏览器回归。首次 1440×900 验收发现图表标题出现但实际绘图区仍在折叠区下方；将运行范围说明横向并排、收紧结果头部/状态/KPI/图表工具栏留白后，Playwright 按 SVG 绘图区裁切区域确认主图可见高度超过 120px，运行条、当前策略编辑器、四项 KPI 和“结果详细”入口也同时可见。成功运行时折叠重复的逐策略状态行，异常/警告/诊断状态自动展开；异常诊断仍直接可见。原型和工作台设计规范已同步。最终前端验证为 `npm test` 95/95、typecheck、lint、production build、E2E 23/23 与 axe 通过；E2E 覆盖八种宽度的日中布局、键盘结果标签、主流程、策略切换、运行恢复、三种 CSV、图表同步/手势及 axe。桌面首次视口截图由 `workbench-1440-first-screen.png` 产出。

**Stabilization-loop 再验收记录（2026-09-30）：** 浏览器复现并修复了 767px 仍进入平板布局、键盘激活“结果详细”后焦点未进入目标、分隔拖拽区在触屏下仅 12px、单个策略导航卡片被拉伸至填满空区、策略摘要文字过小、同一策略的下一轮运行沿用旧详情页签，以及警告诊断详情在新运行间沿用手动折叠状态。现统一断点为 768px；详情区可获得焦点并显示焦点环；粗指针下分隔区、共享设置/运行诊断摘要和详情入口满足 44px 命中尺寸；策略卡片按内容高度排列，关键摘要提高字号；详情页签与诊断折叠状态按运行 ID 重置。新增/扩展回归覆盖断点、绘图区真实可见范围、键盘焦点/结果区滚动、新运行默认页签、触控目标、字号层级和卡片高度分布。全量单测 95/95、Playwright 23/23、typecheck、lint、build 已通过。

**依赖：** 检查点 H。**可能触及：** `docs/design/backtest-ui.html`、前端响应式/浏览器测试、任务记录。**范围：** 中。

### 检查点 I：工作台交付

- [x] Task 34–38 验收标准均有自动或实际浏览器证据。
- [x] 中/日文各状态组合、图表同步、局部失败及 CSV 快照完成集成复核。
- [x] 按用户既有授权推送到 `feature/` 分支，并核实本地/远端 HEAD 一致。

**交付记录（2026-09-30）：** 工作台实现提交 `f866c98` 已推送至 `origin/feature/remaining-v1-tasks`，远端 ref 与本地 HEAD 完全一致；此交付记录随后单独提交并推送。

## 阶段 12：工作台布局与结果层级稳定化

按 Task 39→42 执行本轮截图反馈。保持桌面固定顶栏、左侧共享设置/策略导航、策略详情和右侧结果独立滚动；不改交易、行情和快照契约。

### Task 39：修复左右面板留白与左栏设置展开布局

**描述：** 复现不同窗口宽高下主工作台和结果滚动区的实际边界；消除内容区高度与视口不一致造成的大块底部空白。共享设置在左栏内流展开；768–1279px 下配置与结果并排、不再浮在内容上。展开入口固定在工作区标题，左栏关闭后滚动结果仍能重开；窄屏继续使用配置/结果切换。

**验收标准：**
- [x] 至少覆盖 1280/1440/1920px 宽度及 600/720/900/1080/1440/1920px 高度；文档高度与应用视口边界无意外错位，空余高度不会由错误的固定/最小高度制造。
- [x] 展开共通设置时不覆盖策略选择器；短视口下限制设置区高度并保证策略列表仍有可见、可滚动区域。
- [x] 展开时关闭按钮邻近左栏设置/策略；收起时展开入口固定在工作区标题且结果滚动后仍可达；窄屏继续使用配置/结果切换。
- [x] 左侧共享设置和策略导航仍固定，策略详情独立滚动。

**验证：** 新增 CSS 与 Playwright 几何回归；通过浏览器检查 600–1920px 高度和设置展开/收起；更新设计原型，运行前端全检查及 `git diff --check`。

**完成记录（2026-09-30）：** 浏览器测量确认 768–1279px 布局残留 `min-height: calc(100dvh - 230px)`：实际内容约 317px 时，768×1920/900/600 分别留下约 1373/353/53px 空白；移除强制留白并让主工作区占用标题区以下视口。共享设置改为左栏内流；关闭侧栏后的重开入口从随结果滚动的内容区移至固定工作区标题。1440×600 时策略卡列表原为 0px 高，现保留至少 56px 可见滚动区，导航自身可滚动到“添加策略”。Playwright 以 6 个宽度 × 6 个高度共 36 组几何断言验证无保留空白，另覆盖展开/关闭/重开、短视口和 768/1024px 平板布局。

**依赖：** 检查点 I。**范围：** 中。

### Task 40：让普通滚轮用于页面滚动

**描述：** 普通滚轮/触控板滚动在图表上仍滚动右侧结果区；只有显式 Ctrl/Command + 滚轮才缩放图表。拖动、键盘、缩放按钮、图间同步和触屏行为保留。

**验收标准：**
- [x] 图表上普通滚轮不改图表窗口并可滚动结果区。
- [x] Ctrl/Command + 滚轮只缩放图表且所有图的窗口同步；事件频率差异不会导致过度缩放。
- [x] 双语操作说明、键盘缩放/平移和触屏交互准确。

**验证：** Playwright 验证普通滚动与修饰键缩放各自作用域，图表窗口三图同步；图表模型单测、typecheck、lint、build、axe、E2E。

**完成记录（2026-09-30）：** 图表不再拦截普通滚轮；仅 Ctrl/Command + 滚轮触发缩放，并在图表容器使用非被动监听器取消默认缩放。保留同一视口状态，所以所有图表同步。日中提示文案已同步。单测覆盖累计 delta 的缩放稳定性；浏览器全流程验证普通滚轮滚动结果区、修饰键缩放同步且无页面/视口误缩放。

**依赖：** Task 39。**范围：** 小。

### Task 41：提升当前结果优先级并缩减运行摘要

**描述：** 将聚焦策略的 KPI 卡片置于结果区首位，快照过期说明放进该卡片；主图之后再显示紧凑的执行状态/逐策略摘要。核心 KPI 同时展示总投入本金和期末资产，异常诊断仍优先且可见。

**验收标准：**
- [x] 成功运行时聚焦策略指标卡为结果正文首卡，包含总投入本金、期末资产、投入收益率、XIRR、最大回撤。
- [x] 正常运行摘要明显缩小但运行 ID/逐策略状态仍可展开检查。
- [x] warning/failed/unavailable/diagnostics 仍优先展示；旧快照说明仍在 KPI 数值附近且不会被隐藏。
- [x] 空结果、未选中/失败策略及完整指标/比较/CSV 语义不变。

**验证：** 组件单测和 Playwright 检查卡片顺序、五项 KPI、状态和异常诊断；typecheck、lint、build、E2E、axe。

**完成记录（2026-09-30）：** 聚焦结果卡现在是结果正文第一张卡，核心 KPI 同时展示本金、期末资产、投入收益率、XIRR 和最大回撤；旧快照提示与数值同卡。普通完成状态改为单行紧凑摘要；异常状态和诊断保持 KPI 前优先显示。组件和浏览器测试覆盖结果顺序、状态/诊断优先级及 CSV 快照语义。

**依赖：** Task 40。**范围：** 中。

### Task 42：强化重要操作并完成多尺寸验收

**描述：** 按现有青绿色系统强化常用按钮与选中状态，明确主要执行/添加/图表模式操作层级；纯操作控件采用紧凑图标按钮，保留屏幕阅读器名称和悬停提示；策略及数据序列名称保留文字。更新正式原型、任务记录，复核左栏和结果区在常见尺寸下的可读性。

**验收标准：**
- [x] 运行、显示设置、添加策略和图表模式等可执行操作具有一致且足够醒目的可见状态；高频图表及侧栏操作紧凑且有可访问名称；禁用、焦点和按下状态仍有清楚区分且颜色对比达 WCAG AA。
- [x] 日/中文 320–1920px 宽度和至少 600–1920px 高度下无意外空白、遮挡或横向溢出。
- [x] 页面截图、axe、所有新增回归和前端 `npm test`、typecheck、lint、build、E2E 通过；代码审查无未解决问题。
- [x] UI 原型、工作台 UX 规范、`tasks/plan.md` 和 `tasks/todo.md` 一致。

**依赖：** Task 39–41。**范围：** 小至中。

**完成记录（2026-09-30）：** 侧栏收起/展开、显示图表和图表区间重置改为紧凑图标按钮，均带日中可访问名称、tooltip 和键盘焦点；序列名、策略名与主要运行操作仍保留文字。主要操作和选中图表模式使用更醒目的青绿色状态。原型、工作台 UX 设计、计划与进度同步。

### 检查点 J：布局与结果层级验收

- [x] 底部空白根因有多视口浏览器测量和截图证据，布局无错误高度约束。
- [x] 设置为左栏内流布局，平板宽度不使用覆盖式浮层；关闭后的开关固定可达；滚轮滚动/缩放分离且图表同步。
- [x] 聚焦策略卡片优先，五项核心指标齐全，运行状态摘要紧凑并保留异常诊断。
- [x] 重要操作清晰、可访问；中日文、键盘、触屏和响应式检查通过。
- [x] 本地与远端 `feature/` 分支对齐（依照用户已授权的自主推送偏好）。

**Stabilization-loop 记录（2026-09-30）：** 修复并回归验证六项发现：强制高度导致的底部留白、随结果区滚走的侧栏重开按钮、覆盖式设置、短视口策略导航被压至 0px、图表普通滚轮误缩放，以及高频功能按钮文字过多。中高优先级项均已关闭；纯操作图标控件保留辅助技术名称和提示，不把策略/数据名称图标化。前端单测 99/99、typecheck、lint、生产构建通过；浏览器 E2E 26/26（包含 36 组尺寸几何、日中布局、设置重开、触屏两栏、图表同步和 axe）；`git diff --check` 通过。

## 阶段 13：设置弹窗、固定控制与图表手势修复

按 Task 43→46 顺序处理最新界面反馈。配置编辑继续复用唯一 catalog 表单；草稿值即时更新。不得影响运行范围、已保存结果、策略选择或 CSV 快照。

### Task 43：将共通设置改为模态对话框并固定侧栏开关

**描述：** 左栏只展示共享配置摘要；点击齿轮/编辑图标打开可访问模态对话框，在其中完整编辑现有共享字段。桌面侧栏开关由同一个固定标题按钮控制，开合前后不改变按钮的位置。

**验收标准：**
- [x] 对话框复用现有 `SharedSettingsForm`/catalog/校验管线；表单分组清楚，窄屏单列、内容内部滚动，标题与完成按钮可见。
- [x] 点击触发按钮或按键盘激活能开窗；Escape、关闭按钮和完成按钮关闭；焦点返回触发按钮，背景不可交互。
- [x] 编辑即时更新草稿；关闭重开保留本次编辑，运行快照仅在用户运行时冻结。
- [x] 桌面左侧栏的同一个开/关按钮始终在固定标题区同一坐标，状态、箭头、可访问标签正确；不再在侧栏和标题区切换两个不同按钮。
- [x] 320–1920px、键盘、焦点与 axe 回归通过。

**验证：** 组件测试与 Playwright 覆盖打开/关闭/编辑保存语义、Escape、焦点返回、内部滚动和侧栏按钮几何稳定；typecheck、lint、build、axe。

**依赖：** 检查点 J。**范围：** 中。

**完成记录（2026-09-30）：** 共通设置现在从左栏摘要通过齿轮按钮在原生模态对话框中编辑，沿用原有表单、目录和校验；320px 时表单区内部滚动，标题和完成操作保持可见。键盘 Enter 打开，Escape、关闭图标和完成按钮均关闭并把焦点还给触发按钮；运行时背景进入 modal inert 状态。编辑会即时更新草稿，关闭重开保留数值。侧栏由固定标题区唯一开关控制，浏览器测量展开/收起前后坐标相同。

### Task 44：将执行摘要移到顶部并将运行操作改为图标

**描述：** 右侧执行状态移到结果内容最上方。成功无诊断时显示紧凑摘要；异常和诊断仍完整显示。运行按钮改为显眼的播放图标，不展示“运行回测”字面按钮。

**验收标准：**
- [x] 运行状态在右侧 KPI/图表之前；完成态只有紧凑一行，运行 ID/逐策略详情仍能展开；警告/失败/不可用诊断优先完整可见。
- [x] 运行主操作为青绿色高对比播放图标，视觉上无长按钮文案，但日中可访问名称、tooltip、禁用/忙碌状态准确。
- [x] 工作台现有状态 tag、局部失败、运行范围与请求 payload 不改变。

**验证：** 组件/E2E 检查位置、摘要高度、异常诊断、图标可访问名和运行 POST 行为；contrast/axe 与前端基础门禁。

**依赖：** Task 43。**范围：** 小。

**完成记录（2026-09-30）：** 运行摘要移到结果内容顶部，成功状态缩成一行，告警和失败信息继续优先展开。运行操作改为青绿色播放图标，保留日中 accessible name、tooltip、忙碌图标和禁用语义；端到端回归确认请求与保存结果流程不变。

### Task 45：恢复图表指针同步拖动和可发现的缩放

**描述：** 拖动映射到实际指针位移，不再缩放拖动灵敏度。保留普通滚轮滚动结果区，同时增加明确的图标开关启用普通滚轮缩放；Ctrl/Command+滚轮与显式放大/缩小按钮继续工作，所有图共用视口。

**验收标准：**
- [x] 拖动图表时视窗按指针在绘图区移动的距离平移，不能仅移动一部分；所有图的时间窗口同步。
- [x] 普通滚轮默认滚动结果区且不改变图窗；打开滚轮缩放模式后普通滚轮缩放并阻止结果区滚动；Ctrl/Command+滚轮无论模式状态均可缩放。
- [x] 放大/缩小/重置控件可直接操作且可访问；边界、鼠标锚点、键盘及多事件触控板行为正确。
- [x] 中日文说明及图标开关状态准确。

**验证：** 模型单测加浏览器测量拖动 px/窗口变化；验证两种滚轮模式、修饰键和加减按钮，所有图同步；axe、typecheck、lint、build、E2E。

**依赖：** Task 44。**范围：** 中。

**完成记录（2026-09-30）：** 移除拖拽半速系数，并以拖拽开始视窗和指针相对起点位置计算平移，使图窗随鼠标移动；浏览器回归测量位移在理论值的 85–115% 内并确认多图时间窗口同步。普通滚轮仍滚动结果区；新增默认关闭的放大镜开关可切换普通滚轮缩放，Ctrl/Command+滚轮、加减和重置控件继续可用。日中说明与选中态同步更新。

### Task 46：同步 UI 原型并完成集成验收

**描述：** 更新工作台视觉原型与最终验收记录；在完整运行、配置、响应式、多语言和图表流程中复核阶段 13 改动。

**验收标准：**
- [x] 原型、工作台 UX 规范、实现、计划与待办一致。
- [x] 前端单测、typecheck、lint、build、E2E 和 axe 通过；回测运行、结果快照和 CSV 无退化。
- [x] 完整 diff 复核无遗留问题；按用户已有授权推送 `feature/` 分支并确认远端 HEAD 一致。

**依赖：** Task 43–45。**范围：** 中。

**完成记录（2026-09-30）：** 已同步 HTML 交互原型、工作台 UX 规范与进度记录。完整变更集通过前端单测 101/101、typecheck、lint、production build、Playwright E2E 26/26（含 axe）；随后为新增键盘打开和关闭按钮断言定向复跑 1/1。`git diff --check` 与最终差异审查通过。阶段提交按用户授权推送到 `origin/feature/remaining-v1-tasks` 后核对本地和远端 HEAD。

### 检查点 K：设置、状态与图表交互验收

- [x] 设置对话框清晰、完整、键盘可访问且不挤压左栏；草稿和保存快照语义正确。
- [x] 侧栏开关在打开/关闭状态保持固定位置。
- [x] 运行状态位于结果顶部并紧凑；播放按钮显眼且仅用图标表达。
- [x] 图表拖拽完全跟随指针；普通滚轮/缩放模式/修饰键/按钮缩放均可用，时间轴同步。
- [x] 中日文、320–1920px、axe 和全部前端门禁通过，远端 `feature/` 与本地 HEAD 一致。

## 阶段 14：工作台扁平化与有效视口修复（进行中）

用户最新 11 项要求、浏览器证据、目标布局及最终验收维护在 [扁平化方案](../docs/design/workbench-flattening-proposal.md)。保留阶段 0–13 完成记录，按 Task 47→55、检查点 L→N 串行推进。

**执行方式：** 每 Task 使用 loop-engineering 的实现→验证→审查→修复→简化→再验证循环，满足验收才勾选。沿用用户已授权的直接 Git 提交/自主推送和 `feature/` 分支，不建立额外 Workflow。全部交付后执行 stabilization-loop，可复现缺陷进入对应修复循环。

**依赖：** K → 47 → 48 → 49 → L → 50 → 51 → 52 → M → 53 → 54 → 55 → N。

**共有门禁：** 每个实现 Task 执行相关行为验证及实际前端 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`；E2E 聚焦本任务，检查点做集成复核。完整原型/文档同步在 Task 55。纯样式不增加镜像断言，缺陷与交互使用用户可观察行为回归。

### Task 47：修复外层滚动产生的底部空白

**状态：已完成（2026-09-30）。** 修正 `.sr-only` 绝对定位参照：为工作台结果滚动区建立定位上下文，并将隐藏内容锚在容器内；保留原有尺寸与裁切、读屏标题和 caption。保存结果的 7 种高度以及 5 组桌面/平板视口均断言 document 高度、工作区边界和内部滚动；外围滚轮不滚动 document 或结果面板。

**描述：** 先复现隐藏绝对定位元素越过结果滚动区及顶栏 61px/工作区扣除 60px 的误差，再修复定位、裁切和根布局高度分配；不能仅用 body overflow 隐藏根因。

**验收标准：**
- [x] 1920×1080、1536×864、1280×720 下 document 不超出有效视口；隐藏标题/caption 不撑大整页，外缘滚动不露空白。
- [x] 左栏/结果填满顶栏以下区域，内部滚动、skip-link 和辅助技术标题可用。
- [x] 短视口、侧栏开关及 320/768/1024px 无新裁切或滚动退化。

**验证：** 基于本轮 1081/2780px 复现建立行为几何回归，浏览器检查无结果及多图保存结果的实际外缘/面板滚动，执行共有门禁。

**依赖：** 检查点 K。**可能触及：** `frontend/src/styles.css`、已有工作台 E2E。**范围：** 小。

**完成验证：** 缺陷先由完成真实运行后 1280×600 document 高 2164px（视口 600px）复现；修复后空结果尺寸矩阵及完成运行尺寸/外围滚动 E2E 2/2 通过。前端单测 101/101、typecheck、lint、production build 通过。

### Task 48：将执行入口整合到唯一常驻顶栏

**状态：已完成（2026-09-30）。** 删除可见页面标题及其 ETF 摘要行和独立运行条；顶栏保留产品识别、语言选择、位于左侧固定坐标的设置开关，以及右侧播放按钮和范围选择。运行范围默认仍是 `all_enabled`；短暂成功反馈通过勾选图标和播报表达。两行平板顶栏按 105px 参与工作区高度计算，桌面顶栏压缩至 55px。

**描述：** 去除可见 page-heading 和独立 run-controls 两行；播放主操作及范围菜单进入顶栏，侧栏开关固定在顶栏左侧，正常完成反馈短暂显示。

**验收标准：**
- [x] 只有一个常驻顶栏和一个播放主操作；范围默认全部启用策略，当前/全部菜单及请求配置正确。
- [x] 侧栏开关展开/关闭坐标相同且始终可达，忙碌、不可执行原因及重复提交保护正确。
- [x] 中日文、窄屏与键盘可用；输入摘要在左侧、保存结果来源在右侧可辨识。

**验证：** 组件和浏览器验证范围、POST、开关坐标、运行反馈及响应式，执行共有门禁。

**依赖：** Task 47。**可能触及：** `App.tsx`、`RunControls.tsx`、`styles.css`、i18n 及行为测试。**范围：** 中。

**完成验证：** 先由新增 E2E 断言复现独立标题仍存在；完成重构后 Playwright E2E 27/27（中日文 320–1920px、运行快照/导出、设置开关及双击防重复提交）、前端单测 101/101、typecheck、lint、production build 全通过。桌面截图复核及 `git diff --check` 通过。

### Task 49：让共通设置整块可点并舒展 dialog

**描述：** 将设置摘要变为整体 button；dialog 按标的、期间、投入计划纵向组织，每段最多两列，取消约 119px 日期输入的拥挤排版。

**验收标准：**
- [x] 摘要任意位置及 Enter/Space 均开窗，没有嵌套可交互按钮。
- [x] 日期/投入字段对齐，结束日模式归在同一字段区；窄屏单列、标题/完成常驻，内容内部滚动。
- [x] 复用 catalog/校验，草稿即时更新；关闭重开保留值，Escape/完成/关闭及焦点返回正确。

**验证：** 实际页面比较宽/窄视口字段宽度，组件与 E2E 检查整块点击、编辑保留、焦点和 axe，执行共有门禁。

**依赖：** Task 48。**可能触及：** `App.tsx`、`SharedSettingsForm.tsx`、`SharedSettingsDialog.tsx`、`styles.css`、dialog 测试。**范围：** 中。

**完成验证（2026-09-30）：** 设置摘要整块是唯一按钮，支持 Enter/Space；对话框分为标的、区间和投入计划三段，结束日模式保留在区间内。320–767px 每组单列，768px 起日期/投入最多两列；对话框内容独立滚动，标题和完成栏保持可见。关闭重开保留草稿，Escape/关闭/完成后焦点返回。前端单测 101/101、typecheck、lint、production build、Playwright E2E 27/27（含 axe）通过；CSS 精简后相关单测及 17 项浏览器检查再次通过；1440px 对话框截图、`git diff --check` 及差异审查通过。

### 检查点 L：视口及基础操作

- [x] 外层留白根因修复，实际滚动和几何回归通过。
- [x] 顶栏执行/范围/固定侧栏开关完整，共通设置整块开窗且可读。
- [x] Task 47–49 门禁通过，无未解决高/中优先级发现，再开始策略迁移。

### Task 50：将策略配置迁移到卡片 dialog

**状态：已完成（2026-09-30）。**

**描述：** 目录选择器/添加在列表之前，左侧只保留摘要卡；取消内嵌编辑器和高度分槽，点击卡片在宽 dialog 中编辑 catalog 参数组。

**验收标准：**
- [x] 目录在前、卡片在后，没有第三个内嵌详情区；列表按内容高度排列并在剩余区域滚动。
- [x] 七类策略可在 dialog 中编辑，长参数有分组/内部滚动，关闭重开及焦点返回正确；参数和校验仍来自 catalog。
- [x] 启停/删除不触发开窗；编辑、当前运行对象、范围、启用、结果焦点及图例独立；添加删除后焦点合理。

**验证：** 组件及浏览器覆盖七类预设、至少三个实例、长参数、添加删除、编辑保留和状态独立性，执行共有门禁。

**完成记录（2026-09-30）：** 左侧选择器/添加行置于已添加策略卡之前；移除第三个内嵌编辑区，按内容排列的卡片列表在剩余高度内独立滚动。七类预设均打开 catalog 驱动的宽弹窗，参数组导航留在内部滚动区；编辑即时更新草稿，关闭重开保留，Escape/完成后焦点返回。运行对象改由独立图标按钮设置，打开编辑不改变运行范围、结果焦点或图例；启停/删除独立，删除后焦点落到相邻策略或目录选择器。前端单测 102/102、typecheck、lint、production build 通过；Playwright 六项定向 E2E 通过，覆盖 320px 单列及日中 axe、七种预设、长参数滚动、状态独立性、焦点和独立面板滚动；`git diff --check` 通过。

**依赖：** 检查点 L。**可能触及：** `StrategyWorkspace.tsx`、策略 dialog、`App.tsx`、`styles.css`、策略行为测试。**范围：** 中。

### Task 51：置顶并合并结果详情和指标

**描述：** ResultDetails 置顶，五项 KPI 合入默认概览，保存标的/期间、结果焦点和导出集中在同一上下文；移除独立 KPI 跳转及正常成功状态卡，异常改为上下文诊断。

**验收标准：**
- [x] 首卡为结果详情，概览只有一份本金/期末资产/收益率/XIRR/最大回撤；比较、交易、搜索及额外指标可访问。
- [x] 成功卡不常驻，empty、运行中、请求失败、局部失败、unavailable、零交易和旧输入有可读原因入口。
- [x] 结果选择与四类 CSV 读取同一冻结快照；左侧编辑不改结果焦点，新运行页签初始化正确。

**验证：** 104 项前端单元测试、typecheck、lint、build 全通过；Chromium `default VIX can run to a focused saved result, display toggles, and matching CSV` 通过，覆盖焦点下拉、详情置顶、指标、策略编辑后仍从保存快照导出、运行恢复和新运行重置概览；单测验证四种 CSV 均绑定同一 run/result ID，浏览器下载验证 summary、daily-assets、trades，普通策略的 search-results 正确禁用。浏览器测试使用本地 fixture API，并在授权的临时 localhost 端口启动。

**依赖：** Task 50。**可能触及：** `ResultViewer.tsx`、`ResultDetails.tsx`、`ResultSummary.tsx`、`ExportControls.tsx`、`StatusView.tsx` 及对应行为测试。**范围：** 中，分内部切片循环。

### Task 52：统一右侧模块的折叠交互

**描述：** 结果详情和图表模块采用一致的轻量折叠标题，界面显示状态与数据分离，减少多层等权重套卡。

**验收标准：**
- [x] 结果详情、主图、辅助图共用 chevron/标题开合；结果与主图默认展开，辅助图默认折叠。
- [x] 折叠只隐藏视图，不卸载内容；重开保留 KPI、图例、日期窗口和图表视窗。结果焦点、CSV、旧快照提示与异常状态入口留在可见区。
- [x] 原生标题按钮可用键盘操作并提供 expanded/controls/region 语义；窄屏标题和操作无横向裁切，焦点保留。

**验证：** 前端单元测试 104/104、typecheck、lint、build 通过；定向 Chromium 用例通过，覆盖键盘折叠、焦点/CSV 持续可用、主图与辅助图窗口保留、375px 标题布局，以及图表 axe 扫描。E2E 使用本地 fixture API。

**依赖：** Task 51。**可能触及：** 共享折叠控件、`ResultDetails.tsx`、`ResultsCharts.tsx`、`styles.css`、行为测试。**范围：** 中。

### 检查点 M：策略编辑及结果结构

- [x] 七类策略由卡片 dialog 编辑，状态独立性有证据。
- [x] 结果置顶/KPI 合并/成功卡移除，状态与四类 CSV 快照正确。
- [x] 折叠一致并保留日期/图例；Task 50–52 前端门禁及定向 Chromium 验收通过。

### Task 53：让共享图表工具常驻并控制图高

**描述：** 共享日期窗口的工具栏在图表区域 sticky；限制随宽度过度增高的 SVG，并按实际绘图区验证指针坐标。

**验收标准：**
- [x] 第三图可见时缩放/重置/布局工具仍可达，sticky 限于结果/图表区域且不遮挡焦点；手机页面滚动时工具栏停在 sticky 顶栏下方，联动含义明确。
- [x] 1920×1080 下主图绘图区为 320–420px、辅助图为 180–240px，短屏可读；价格/资产同图及起点 100/原始值正确。
- [x] 分图/叠加、拖动跟随、普通滚动、滚轮模式、Ctrl/Command、加减/重置及键盘同步正确，变尺寸无锚点偏差。

**验证：** Task 53 通过：`npm test`（104/104）、`npm run typecheck`、`npm run lint`、`npm run build`；Chromium 定向用例 `default VIX can run to a focused saved result` 覆盖 1920×1080/600 绘图区实测、短屏、第三图 sticky/工具可达、320/375/767px 顶栏遮挡、拖动/缩放/同步和 axe。先添加窄屏回归断言并确认失败，再设置移动端 sticky 偏移修复，复跑通过。`git diff --check` 通过。静态代码复核修复了一项窄屏顶部栏遮挡问题，复核后无剩余问题。

**依赖：** 检查点 M。**可能触及：** `ResultsCharts.tsx`、`chartViewport.ts` / `chartModel.ts`、`styles.css`、图表模型及 E2E 测试。**范围：** 中。

### Task 54：精简表格、说明和剩余操作视觉

**状态：已完成（2026-09-30）。** 比较表移除默认内部策略 ID，搜索表保留候选序号而隐藏候选 ID，交易信号改为日中双语名称；比较/交易/搜索重复标题保留为读屏标题。图标操作具一致的 `aria-label`/`title`，交易明细切换扩大为 44px；校验诊断可分别打开共通设置或目标策略 dialog 并聚焦字段。

**描述：** 完成额外审计发现的重复标题、内部 ID、套卡及固定长说明降噪；统一剩余图标/提示，并把校验入口关联到配置字段。

**验收标准：**
- [x] 比较/交易/搜索无重复可见标题或默认内部 ID，绩效字段、角色、长名称、原始值及局部表格滚动可访问。
- [x] 通用动作具日中可访问名称/提示，主操作、选中、禁用与焦点统一；字段、策略、指标和错误保留必要文字。
- [x] 复杂说明在需要处可读；校验入口能开正确 dialog 并定位字段，不仅靠颜色表达问题。

**验证：** `cd frontend && npm test`（105/105）、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run test:e2e`（31/31，含双语 axe、诊断跳转与结果表格交互）；`git diff --check` 通过。第一次完整 E2E 暴露旧用例仍依赖已隐藏的内部 ID、静态交易按钮名称和 900px 下并无溢出的滚动假设，更新为按策略/角色定位、按按钮当前动作名断言，并将独立滚动验证放在 700px 短屏后全量通过。

**依赖：** Task 53。**可能触及：** 相关结果表格、i18n、共享 UI 样式、配置诊断入口及行为测试。**范围：** 中。

### Task 55：同步原型并完成最终多视口验收

**追加依赖（最新用户要求）：** 先执行下方阶段 15 的 Task 56–60，再回到本任务和检查点 N；本任务保持未完成，不把阶段 14 的旧 UI 证据当作新版本验收。

**描述：** 更新正式 HTML 原型与组件/工作台文档，逐项验证 11 条需求和额外优化；全部实现完成后按已有要求执行 stabilization-loop。

**验收标准：**
- [x] 方案六条最终验收有证据，包含视口矩阵、真实浏览器 100%/125%/150% 缩放、外缘滚动及首屏实际绘图区；真实缩放未检查不能用调整视口代替。
- [x] 前端全套门禁、E2E/axe、真实 QQQ/VIX 运行/恢复及保存快照导出通过，原型/设计/计划/进度一致。
- [x] 聚合 diff 审查/简化及 stabilization-loop 完成，无未解决高/中优先级发现；按已有授权推送 feature 分支并核实远端 HEAD。

**验证：** `cd frontend && npm test && npm run typecheck && npm run lint && npm run build && npm run test:e2e`；真实供应商常规门禁依实际配置执行；浏览器证据及 `git diff --check`。不得将阶段 13 的验证结果作为新验收。

**依赖：** Task 54。**可能触及：** `docs/design/backtest-ui.html`、正式 UI 规范、工作台 E2E 及任务记录；缺陷返回对应任务修复。**范围：** 中。

### 检查点 N：扁平化工作台交付

- [x] 用户 11 项均有交付和浏览器证据，额外扁平化项完成。
- [x] 有效视口无空白尾部，dialog、状态/快照、折叠及第三图工具可达性正确。
- [x] 全部门禁和 stabilization-loop 通过，设计/原型/任务一致，远端 HEAD 已核实。

**风险与处理：** 修复隐藏节点溢出时保护可访问语义；策略 dialog 迁移保护焦点及即时草稿；折叠不能卸载并丢失图窗；移除成功卡不吞异常；图高改变后验证实际 SVG 指针映射；只将通用动作图标化。当前没有阻止本轮计划完成的产品开放问题，细节依方案和实现证据收敛。

## 阶段 15：用户复核后的交互收敛（2026-09-30）

执行顺序：Task 56 → 57 → 58 → 59 → 阶段 16（Task 61–64）→ Task 60 → Task 55 → 检查点 N。遵循 loop-engineering 的失败测试、实现、验证、审查、修复和简化循环。

### Task 56：隔离草稿校验与保存结果，提供重置

- 共通/策略 dialog、启停、范围或删除操作不改变右侧保存结果、诊断、图表与 CSV；校验仅归属设置侧，结果标题固定显示保存标的/期间，不再由草稿派生旧输入提示。
- 播放旁增加图标重置；仅清空客户端当前结果、焦点和运行错误，不修改草稿、取消运行或删除 SQLite 记录。运行中禁用；页面刷新后不恢复已清空的同一 run，新的运行可正常恢复。
- 验收：有效/无效草稿编辑的结果 DOM 和保存导出不变；重置后 empty、CSV 禁用、重开页面仍 empty，重新运行正常；运行诊断不被草稿编辑清除。

### Task 57：精简左栏与运行入口

- 删除栏宽调整；分隔区域使用唯一开关，展开/关闭均可达，窄屏采用配置/结果切换。
- 添加目录只提供五种可选策略；月度 DCA/一次投入仍由后端七类 catalog 自动生成必选基准。共通摘要删除齿轮，整块打开 dialog；金额显示同标的保存结果的币种，尚未确认币种时使用明确的取引通貨/交易货币单位，不猜币种。
- 添加为醒目图标、标题简化；策略启停为可访问 switch，停用卡变灰且保留参数。删除卡片运行目标按钮，顶栏菜单统一选择全部启用或指定实例；编辑、启停、结果焦点仍独立。删除 local-tag，缩短范围/注解。
- 验收：五种目录、两项基准仍运行；switch/删除/开窗不混淆；单实例范围与全部范围、关闭重开、键盘焦点及双语/窄屏通过。

### Task 58：合并比较指标，约束交易滚动与 CSV 入口

- 结果默认策略比较，合并全部八项绩效字段，移除概览/其他指标重复页和 result-focus-select。点击比较行选择图表/交易/导出结果；同类多实例使用短序号区分。
- 交易表最大高度内独立滚动、表头 sticky；横向溢出仅发生在表格容器。导出使用下载图标及文件型名称（例如 汇总.csv），四类快照导出语义不变。
- 验收：所有绩效字段可查且不重复，比较选择驱动统一结果；长交易表表头固定，键盘/ARIA、无交易/失败态和四类 CSV 正确。

### Task 59：统一图高与图例悬停强调

- 主图/回撤/VIX 使用同一尺寸规则，保留同步窗口、sticky 工具栏和实际指针映射；辅助图不再缩小。
- 常态线更细；鼠标悬停或键盘聚焦局部图例时，对应线加粗并显示同色透明渐变面积，离开后恢复；不改变显隐、数据、窗口或范围。线/面积受绘图区裁切。
- 验收：同尺寸、多曲线重叠可辨；hover/focus 有面积、恢复无残留，颜色正确；拖动/缩放/折叠/日期联动/单点与缺数据回归通过。

### Task 60：同步规范、原型及新增验收证据

- 同步主设计稿结果/验收、复用规范、工作台方案及正式 HTML；更新任务进度，保留历史证据。
- 验收最新 17 项和全部前端门禁、浏览器/axe、真实 QQQ/VIX/SQLite 恢复/保存导出；完成后回到 Task 55 的实际缩放、聚合审查、stabilization-loop 和已授权推送。

### 检查点 O：交互收敛

- [x] 17 项均有当前版本实现和回归证据，草稿/结果隔离、重置、基准、指标/交易/导出和图表强调通过。
- [x] 原型/唯一规则来源同步，前端门禁/axe/真实数据通过；随后继续 Task 55 与检查点 N。


## 阶段 16：最新复核与主辅图联动（2026-09-30）

用户最新 12 项及已确认的累计本金收益口径覆盖阶段 15 的开关位置、范围菜单、同类型多实例和叠加/图高规则；此前完成记录保留为历史证据。执行顺序：Task 59 → 61 → 62 → 63 → 64 → 60 → 55，逐任务完成失败测试、实现、门禁、审查与简化，不跳过最终检查点。

### Task 61：分隔线开关、悬停卡片操作和唯一类型

- 左栏固定宽度，开关在左右边界上，采用无边框 `< / >`，关闭后边界入口可重新打开。删除 far-left rail 和所有 resize 行为。
- 卡片启停/删除仅 hover 或 focus-within 时浮于右上；触屏常驻以保证可达，停用灰卡仍可编辑，操作不打开 dialog。
- 顶部移除范围下拉，只运行所有启用实例并自动附带两个基准；后端 active/all_enabled API 保持。可选五类预设，每类最多一个；已添加选项禁用，reducer 二次防重，删除后可重新添加。
- 验收：实际几何测量开关在边界；连续关闭/打开、悬停和 Tab、停用、删除、去重与提交载荷通过；320–1920px 和双语可访问。

### Task 62：精简上下文与 dialog 文案

- 日期和标的在共通摘要中集中显示，动态结束使用最近保存且同标的的实际行情截至日；尚未运行且无法确认时显示占位，不编造日期。dialog 保留可编辑日期/动态模式。
- 结果页/图表移除重复标的和日期区间；图轴日期与可访问范围说明保留。保存快照来源可从按需信息入口查看，编辑草稿不改变右侧。
- 策略 dialog 删除重复导航/标题说明和参数摘要；每组唯一标题，每字段唯一标签，组合方式说明仅出现一次；缩短选项和依赖注解，参数依赖仍明确。
- 验收：同页重复文案消除、动态真实日期/无结果占位正确，旧快照身份按需可查，dialog 键盘/长表单/诊断跳转和草稿隔离保持。

### Task 63：累计本金收益曲线及真实账本回归

- 用户已确认：价格为首个有效价归一至 100，总资产为 `100 * totalAsset / totalContributed`（当日累计本金），不是单位净值，不再次按首个收益比例归一；本金为零时不画资产收益点。
- 累计本金由后端共享现金流/指标模块逐日记录，月度策略只累加实际注资，一次投入首日记全部预算；前端不复制注资日历，旧快照缺字段明确不可用，重新运行补齐。
- 单位净值、最大回撤、XIRR、资金/交易时点保持原规则；新增可选字段保存/恢复/API/每日 CSV 同步。
- 验收：固定 fixture 验证注资前空段、分批成本、亏损/零值和一次投入；真实 Yahoo QQQ/VIX + DCA/一次投入逐日账本/曲线比值及 SQLite/CSV 一致，不能只比较截图或 mock。

### Task 64：图表操作与紧凑联动指标

- SVG 禁止文本选择，拖动跟随鼠标；主图 Y 轴 8 刻度、X 轴至多 7 日期，窄屏允许缩短日期/隐藏隔行文字但保留网格。
- 滚轮模式开关可重复开启/关闭；仅图内拦截显式缩放，关闭后普通滚轮恢复结果区滚动。使用稳定 locator 与实际事件验证，保留修饰键/按钮/键盘缩放。
- 联动视图：价格/本金收益主图，下方 VIX/回撤在同一宽度的小型图中按自然单位显示；所有图共享时间窗/网格对齐/sticky 工具栏。分图视图保持相同完整尺寸。
- 细线及图例 hover/focus 同色渐变强调保留；不新增 RSI 数据或更改信号公式。
- 验收：真实浏览器多次切换缩放模式、拖动无文字选择、7×8 主图网格、自然单位和紧凑高度/同宽/同步范围；完整前端/axe、响应式和最终实际浏览器缩放通过。

### 检查点 P：最新复核

- [x] 最新 12 项逐一有证据；累计本金收益口径与保存快照/真实数据一致。
- [x] 规范/原型同步、门禁和 stabilization-loop 通过，继续关闭 O/N 并自主推送。

## 阶段 17：精简信号操作及十字定位（2026-10-01）

用户追加五项复核和十字定位功能。先完成当前 Task 60 和 Task 55 的真实浏览器缩放检查，再执行 65→66→67→68→69，最后由 70/55 统一复审、检查全部待办和推送；最终检查点保持开放。

### Task 65：AND/OR 关系与信号开关

- 买入组合使用只有 AND / OR 的分段选择，通过信号卡片连接关系及短提示说明全部/任一；不重复字段说明，不混入卖出逻辑。仍从 catalog 获取允许值与依赖。
- 策略布尔信号使用紧凑 switch 和明确状态，买入/卖出开关独立；停用样式和关联字段禁用可读，不改变预设/计算语义。
- 验收：鼠标/键盘、AND/OR 数据提交、关闭/重开、信号独立依赖、错误定位及双语/320px 通过。

### Task 66：关闭 dialog 后卡片操作隐藏

- 区分键盘聚焦与鼠标返回焦点。鼠标开窗后关闭不把操作按钮持续显示为悬浮；键盘返回仍可识别焦点和访问开关/删除，真实 hover 可再次显示。
- 验收：鼠标/键盘/关闭/完成/Escape、重新悬停及触屏可达，焦点返回正确。

### Task 67：共通摘要分行

- 股票代码、具体起止日期和投入计划各占一行，不重复外围标题/标的/日期；金额保留单位，整块按钮及 dialog 编辑语义不变。
- 验收：长代码/320px/双语、实际结束日和未确认占位可读，草稿与结果隔离保持。

### Task 68：价格显隐保留图表

- 复现点击价格图例的行为；有资产收益时只隐藏价格线，主图/工具/指标继续存在。旧快照缺累计本金时明确提示，不制造收益线；保留可恢复操作和真实数据诊断。
- 验收：单独价格/资产、两个核心系列显隐、旧快照、零本金、重开/切换策略，曲线和保存数据不变。

### Task 69：跨图联动十字定位及读数

- 指针在绘图区时显示纵向日期线和当前图横向数值线，各图同步到同一最近保存行情日；左上显示日期、价格/资产/累计本金及该图可用指标。使用现有保存数据，不生成 OHLC/成交量。
- 主图读数区分相对指数与原始金额，辅助图使用自然单位；缺失读数显示占位，不插值数据。移动/离开/拖动/缩放/折叠/重新选择结果正确；支持键盘查看并避免文字选择。
- 验收：纯坐标/最近点边界测试、真实浏览器悬停和跨图日期同步、横纵线/读数/退出、紧凑图映射、缩放后日期/原值正确，响应式/axe 通过。

### Task 70：按用户全部指摘复审并关闭待办

- stabilization-loop 检查布局密度、重复文字、操作可达、状态/草稿隔离、图表显隐/手势/读数和真实数据/恢复/导出。记录可复现发现，按 loop-engineering 修复并回归。
- 核对 tasks/todo.md 所有未完成项；全部门禁和检查点满足后自主提交推送 feature 分支并核实远端 HEAD。

### 检查点 Q

- [x] 五项追加复核和十字定位完成，所有当前规范/原型一致，最终复审无新增中高优先级缺陷。
- [x] 全部待办/检查点及实际门禁通过，已自主推送且远端 HEAD 一致。


### 最终复审证据（2026-10-01）

阶段 15–17 实现与最终门禁已通过：前端 121 项、Playwright/axe 46 项、typecheck/lint/build；后端 312 项及 Ruff/格式/mypy，包含真实 Yahoo、QQQ/VIX 固定区间、SQLite 重启和保存 CSV 对照。原生浏览器实际缩放 100/125/150% 的首屏绘图区可见高度约 358/247/123px，DPR/有效视口和原生 getter 同时验证，visualViewport.scale=1。稳定化发现及回归证据记录在 todo 的 Task 70；第二轮复扫无新增中高优先级问题。实现提交 `258e7da`、`229c8bc` 已推送到 `feature/remaining-v1-tasks`，核实本地和远端均为 `229c8bc723c8a09bf4a7e223dd1598f58d2219f8` 后关闭 Task 55/70 及 N/O/P/Q 检查点。收尾文档另提交推送并再次核实。

## 阶段 18：彻底清理旧区域并收敛联动图（2026-10-01）

顺序按用户补充明确为 71 → 72 → 73；先完成旧运行区域清理，再对应追加的图表要求。既有完成记录保留，当前行为以本阶段和唯一 UI 规范为准。

### Task 71：彻底删除旧运行条和状态面板

**已完成：** 前端 124/124、typecheck/lint/build、定向 Playwright 2/2（7 状态、按钮几何/进度、恢复与折叠诊断、日中 axe）通过；所有对应源码/CSS/原型残留清除，详见 todo 验证记录。

- 删除 `RunControls`、`StatusView` 及 `.run-controls`、`.run-status-panel` 的完整渲染、样式、专用文案；清除重复策略状态列表、默认运行 ID、进度说明、短暂完成文字及计时器。不能只在完成时隐藏或换类名保留旧区域。
- 顶栏仅有播放/重置图标；忙碌/进度由播放按钮和辅助技术播报表达，禁用原因可访问。共享诊断列表独立，结果详情只保留真实请求错误/去重的保存诊断，折叠后仍可读；每策略状态由比较表呈现。
- 验收：queued/loading/running/completed/completed_with_warning/unavailable/failed 均无旧区域；源码/CSS/原型无残留；重复提交防护、单 SSE/完成单 GET、空态/恢复/重置/冻结结果及双语键盘/ARIA/axe 正确。

### Task 72：仅保留紧密联动图和资产交易点

**已完成：** 前端 127/127、typecheck/lint/build、定向 Playwright 5/5、原生 100/125/150% 缩放 1/1 通过；资产标记坐标、日期轴转移、实际半高/间隙、网格/手势/十字定位及 axe 已验证，详见 todo。

- 所有买卖交易点只描画在总资产累计本金收益线上；资产线隐藏或该日无本金收益点时不代用价格线。
- 完全删除分割显示及其选择按钮/状态/样式/专用翻译，只保留联动图。主图和辅助图紧密相连；日期刻度、日期轴标题与十字定位日期标签仅在最下面一个实际可见图显示，其余图保留对齐的竖向网格和共享日期信息。
- 辅助图高度约为当前一半，主图保持可读尺寸；辅助图仍用自然单位，单一时间窗、拖动/缩放/十字定位/折叠/图例显隐正确，底部日期轴随可见辅助图变化。
- 验收：资产线上交易点坐标正确；完全无分割入口/旧模式分支；1/2/3 图日期轴只显示一次且网格/十字线对齐；辅助图实测半高、主图尺寸不变，320px/桌面/实际缩放及可访问性通过。

### Task 73：历史删除项复核与最终稳定化

**已完成：** 最终前端 129/129、Playwright/axe 47/47、typecheck/lint/build，后端 312/312、Ruff/格式/mypy；复扫无新增中高问题，50a64c4 已推送并核实远端。新追加需求继续下阶段。

- 检查标题、范围菜单、运行目标、重复 KPI/页签、调宽、local-tag 和内嵌编辑器的历史删除要求，无可执行残留；必要数据契约和历史验收记录保持可追溯。
- 同步规范/原型/任务，执行全部适用前端门禁、浏览器/实际缩放、真实 QQQ/VIX/SQLite 恢复/CSV 回归，按 stabilization-loop 复扫并修复可复现问题。
- 审查和简化完成后，自主提交推送 feature 分支并核实远端 HEAD。

### 检查点 R

- [x] Task 71 在完整生命周期与源码/CSS/原型中彻底清理，必要诊断/状态正确。
- [x] Task 72 仅有紧密联动图、单一底部日期轴和半高辅助图，交易点固定资产线。
- [x] 历史复核、稳定化、适用门禁、文档及推送核实完成。

## 阶段 19：追加紧密图表与控制清理

用户要求前序完成后追加，故依赖 71–73 已完成后执行 74 → 75 → 76；仍沿用 loop-engineering，最终 stabilization-loop。

### Task 74：独立底轴与无标题辅助图

**已完成：** 129/129、typecheck/lint/build、定向浏览器 6/6（含原生缩放）及原型/真实几何补充 2/2；辅助实际绘图区等高，标题/局部高亮残留清除，独立底轴及共享滚动通过。

删除回撤/VIX 辅助 figcaption、局部图例高亮状态/渐变及专用标题样式；保留自然单位数值刻度和可访问 SVG 名称、真实阈值线/保存读数。所有辅助图使用同一半高 SVG/绘图区；日期刻度、日期标题和定位日期在独立底部轴显示，任何辅助显隐或焦点策略变化都不压缩末图。主图保留资产/价格图例高亮与交易点；跨图网格、拖动/缩放、游标、键盘保持一致。验收：动态 1/2/3 图都只有一个独立日期轴、辅助实际绘图区等高；无 figcaption/高亮死逻辑，几何/指针/键盘/axe 通过。

### Task 75：摘要标识与控制彻底删除/修复

**已完成：** 前端 130/130、typecheck/lint/build、定向浏览器 7/7，简化和新目录复验各 2/2；目录/映射/SQLite 32/32、Ruff/格式/mypy 通过。放大镜未选中 hover 的绿色根因已复现修复；删除交易显隐的注册/状态/渲染/样式/词典，目录 v5 且 v4/v5 旧保存类型兼容。

共通摘要的标的、日期、注资三行分别添加 emoji（辅助技术不重复读）；交易页直接显示表格，完全删除显隐按钮/区域、状态/action、UI 参数注册项、词典/样式和消费方逻辑。侧栏边界开关背景始终与页面底色一致，hover/focus 只增强图标粗细。放大镜保持可重复开关，取消后仍在 hover 时必须显现未选视觉，并实际恢复普通滚动；Ctrl/Command 缩放和正常拖拽保持。验收：完整静态无残留，真实浏览器反复点击/滚轮/键盘/鼠标停留确认。

### Task 76：最终集成和稳定化

**已完成并推送核实：** 最终前端 131/131、Playwright/axe 47/47、typecheck/lint/build，后端 315/315（真实 Yahoo QQQ/VIX/VXN/VXD、固定运行、SQLite 重启与 CSV）、Ruff/格式/mypy 通过。复审先失败后修复末日日期裁切、原型图例/游标与旧控件词典/样式残留；第二轮复扫无新增中高优先级问题。全部发现和证据见 todo 的 Task 76。另恢复无响应的本地 API，37 条保存记录指纹不变，health/catalog/latest 均 HTTP 200。Task 74–76 实现提交 `99cc317`、`702e3bd`、`61108aa` 已推送，远端 HEAD 核实为 `61108aa8950c5a1ff1571d1ac456e1a3adaeae36`；全部任务及检查点关闭，收尾文档另提交推送。

同步唯一规范、原型、开发说明及所有参数/测试消费方；运行全量前后端门禁、原生浏览器缩放/双语 axe、真实 Yahoo/恢复/CSV。截图复扫并修复可复现问题，核对所有待办后自主提交推送 feature 分支与远端核实。

### 检查点 S

- [x] 无辅助标题/交易显隐逻辑，动态独立底轴、等高辅助绘图区和紧密联动通过。
- [x] 摘要 emoji、边界 hover、放大镜释放视觉/行为一致，双语/键盘/触屏可用。
- [x] 门禁、稳定化、文档/待办及远端核实全部完成。

## 阶段 20：可复用条件与自定义策略（2026-10-01）

依据最新指摘，按 77 → 79 → 80 → 81 → 78 → 83 → 84 → 82 推进；78 将注入本金与实际买入金额分列，买入金额取累计买入成交（含再投资），收益分母保持注入本金。每个任务执行 loop-engineering，最终执行 stabilization-loop。固定策略不提供条件类型/AND/OR/嵌套编辑；自定义策略支持可增删、独立参数和嵌套 AND/OR 条件。沿用既有 `composite_dca` 稳定配置键承载自定义策略，移除旧复合策略编辑器和用户可见类型，历史保存结果继续可读。

### Task 77：紧密图表和比较表降噪

**已完成：** 前端 132/132、typecheck/lint/build、最新定向浏览器 6/6；按追加要求把所有读数移到主图标题下单一区域，辅助图无读数/留白；实际边界、等高/紧贴/显隐/游标/axe 通过，源码删除两列及专用标题。基线后端模块入口 315/315 含真实数据，记录见 todo。

- 删除三图之间的横线、额外间距及相关原型样式。所有读数常驻主图标题下，价格/资产/本金后追加回撤/VIX；无定位或移开指针时显示可见区间最后保存日，缩放/拖动更新末日，只收起定位线；辅助图无读数或留白，图高不随 hover 改变，绘图区保持等高，单一底轴/时间窗/游标继续联动。
- 比较表完全移除角色/状态列及专用渲染；必要身份/执行状态仍属于结果契约和 CSV，实际错误继续通过诊断显示。
- 验收：新增失败回归后验证指针读数不遮住回撤曲线顶部，辅助绘图区等高、显隐及日期轴正确；两列无 DOM/专用实现残留，局部失败可读，双语/320px/axe 通过。

### Task 83：图例点击与多策略曲线（追加，最终 Task 82 前验收）

**已完成：** 独立多选、统一颜色、图例点击/键盘锁定、焦点/导出/共享时间窗隔离；清空选择与失败焦点边界已修复。最终前端 143/143、Playwright/axe 53/53、类型/lint/build 通过，详细证据见 todo。

- 图例改为原生可切换按钮，hover/focus 临时预览，点击/Enter/Space 锁定曲线高亮及渐变，再次点击取消；选中不改变图例显隐和保存数据。
- 比较表支持多选结果，在同一主图显示各选中策略累计本金收益；表格每行色标、曲线、图例及读数共用确定性颜色映射，不仅依赖颜色表达选中。
- 明细/交易/导出继续使用独立焦点结果；多选不改变草稿、启用或运行范围。各图共用保存日历/时间窗/定位日期，缺失点不插值；失败结果可查看诊断、不画虚假曲线。
- 验收：选择/取消多条、稳定色映射、键盘/触屏、价格独立显隐、点击高亮/取消、草稿隔离、CSV 焦点不变、原生缩放和 axe。

### Task 79：统一条件对象、目录和契约

**已完成：** 共享树契约/目录 v6、固定模板/叶字段校验、冻结/SQLite Decimal、旧平面输入在配置边界物化、OpenAPI 类型和前端解码/结构守卫；计算接入归 Task 80，编辑器归 Task 81。

- 增加可冻结的条件叶节点/AND-OR 分组和买入/卖出根对象；条件的允许字段、默认值、单位和边界继续引用 ParameterDefinition 唯一注册表。支持同类型不同参数的独立条件，不共享可变草稿。
- 目录提供固定策略模板和自定义编辑能力、条件元数据及结构限制；基础菜单加入 RSI、均线偏离、布林、利率、PE 等单条件策略。VIX/MA 为固定模板，只调整该模板数字/已有指数选项，不暴露 AND/OR。
- 普通运行、验证、搜索、生成类型、指纹、SQLite 和导出使用同一条件契约；旧平面参数只在边界转换，旧已保存结果不重算。
- 验收：条件合法/非法/空组/嵌套/重复 ID/独立值/冻结/旧记录兼容、目录唯一参数引用和错误路径测试通过。

### Task 80：共享条件计算与 Python 策略复核

**已完成：** 后端 336/336 含真实 Yahoo QQQ/VIX/RSI/MA200、等价固定/自定义、SQLite/CSV；前端 136/136、类型/lint/build，浏览器 3/3，Ruff/mypy 58 文件通过。Python 对照与周末预热边界修复证据见 todo 和 `docs/design/python-strategy-audit.md`。

- 逐项对照指定 compare_strategies.py 的 VIX/RSI/MA/布林/利率/PE、趋势与搜索；记录源码、已确认规则和实现的对应。保留已确认的 t+1 成交、统一注资、严格缺失、固定定投总资产和最大卖出比例规则。
- 固定模板、自定义嵌套与搜索复用同一原子条件评估和账本；禁用条件不形成数据依赖，任一启用必需条件不可用仍使策略不可用。数据加载/预热遍历叶节点，支持同指标不同周期/代码。
- 验收：嵌套真值与 unavailable、买卖独立、不同周期、低档 VIX 优先、卖出比例、固定策略和等价自定义/搜索逐日一致；真实 QQQ/VIX/MA/RSI 默认链路、持久化和导出通过。

### Task 81：买入/卖出大卡片与复用条件编辑器

**已完成：** 固定/自定义/搜索复用条件编辑器，买卖区块、独立卡片、居中连接器与标题开关实现；嵌套/独立参数/限制/草稿隔离/错误定位通过。数字类型与部分失败规则冻结缺陷先复现后修复；最终前端 143/143、浏览器 53/53、后端 348/348 及相关质量检查通过。

- dialog 采用买入、卖出两个大区块；每个原子条件和嵌套组各为卡片。组内卡片之间以实线分隔，AND/OR 按钮居中，与该组对象的逻辑一一对应；禁止依赖文字顺序猜测优先级。
- 所有固定模板和自定义使用同一 ConditionCard/参数控件。自定义可增删条件/组、嵌套组合、关闭后重开保留、定位结构化字段错误；固定模板不暴露增删/逻辑入口。额外注资/限额/搜索设置单独分组。
- 验收：对象/UI 复用无重复字段定义，鼠标/键盘/焦点/触屏/长表单/双语/320px、独立参数、嵌套提交、草稿不影响保存结果、策略类型防重通过。

### Task 78：投入金额口径校验

**已完成：** actualInvested 单独记录累计 BUY 成交，totalContributed 保持注入本金；指标版本 metrics-v3、比较/搜索/CSV/SQLite/旧记录兼容同步。七组精确账本和真实 Yahoo 保存/导出对照通过；后端 348/348、Ruff/格式 90 文件、mypy 58 文件及前端门禁通过。

- 已发现 totalContributed 表示实际注资（含未买入现金），不是成交金额。单独保存实际买入度量（所有买入成交，含再投资，不扣卖出），保留注资本金和收益/XIRR/回撤分母契约；旧快照缺新指标不编造数值。
- 验收：无买入/部分买入/固定比例/安全阀/卖后再买/两基准，指标与账本/SQLite/汇总 CSV 一致；实际买入为零时注资本金和现金仍正确，真实数据回归通过。

### Task 82：整体复审与最终交付

**已完成并推送核实：** 前端 143/143、Playwright/axe 53/53、类型/lint/build；后端 348/348（含真实 Yahoo）、Ruff/格式/mypy 全部通过。S10–S16 已闭环，修复后最终复扫无新增中高优先级问题；规范/原型/开发说明同步，源码删除扫描通过。本机 health/catalog/latest HTTP 200，现有结果可读取。实现提交 `e981761`、`0e66055`、`f332ac8` 及前序阶段 20 提交已自主推送，核实本地与远端 HEAD 均为 `f332ac85efb46b5d2b147ff648d2e06c4533162f` 后关闭全部待办及检查点 T；收尾记录另提交推送并再次核实。

- 同步主设计稿、复用规范、HTML 原型、Python 对照记录、任务和开发说明。运行所有适用前端/后端门禁、浏览器/真实缩放/双语 axe、真实供应商/恢复/CSV。
- stabilization-loop 按全部当前指摘发现、复现并按 loop-engineering 修复；最终复扫无新增中高优先级问题，检查旧复合编辑器/重复逻辑残留，自主提交推送 feature 分支并核实远端。

### Task 84：图表状态与策略入口优化（追加，83 后、82 前）

**已完成：** 常态 VIX 小点与旧添加表单/平面条件控件彻底删除；指标选中、滚轮聚焦/释放、左侧加号菜单、连接器/开关与触屏尺寸已验证。复审修复图标描边/尺寸；最终前端 143/143、浏览器 53/53、类型/lint/build 通过。

- 完全删除 VIX 曲线常态小点的生成/渲染及专用样式；保留用户要求的悬停坐标定位点。
- 指标开关用明确的选中底色、勾选符号和 aria-pressed 区分状态。滚轮缩放开启后，联动图区域显示聚焦边框和可见状态标识；指针在区域内滚轮仅缩放，区域外保持正常滚动，再次点击立即释放。
- 复核条件卡片连接器，组内每两个相邻条件之间用左右实线和居中 AND/OR 控件，控件只修改所属组的逻辑。买卖开关放所属标题右侧、大小一致，不占单独表单行。
- 添加策略入口改成左侧醒目加号；点击后右侧出现目录选项，点击项即添加，保留同类型防重和自动基准规则。支持键盘、触屏、Escape 和焦点恢复。
- 验收：先复现各缺陷，真实浏览器验证状态/边界滚轮/释放、嵌套连接器归属、开关布局、目录菜单和双语/320px/axe；源码检查无旧小点和旧添加表单残留。

### 检查点 T

- [x] 图表无分隔线、读数不遮线，比较表无角色/状态列，真实诊断可读。
- [x] 固定/自定义/搜索共享条件对象、参数注册、评估、数据依赖和账本；嵌套与持久化正确。
- [x] 买卖卡片/居中逻辑分隔/复用编辑器与本金和实际买入显示通过浏览器和真实数据验收。
- [x] 全量门禁、源码复审、稳定化、规范/待办与远端核实完成。

## 阶段 21：弹窗隔离、简化策略与可停止运行（2026-10-01）

依照本轮 19 项指摘，顺序 85 → 86 → 87 → 88 → 89 → 90 → 91。继续 loop-engineering，最终 stabilization-loop；不新增 Workflow 产物。当前要求覆盖旧的最新日期模式、策略启停、固定比例定投及同类自定义实例限制。

### Task 85：更新共享设置及策略契约（对应 3/4/5/8/10/11/12/16）

- 结束日改为日期框默认今天（本机日期），删除「使用最近完整行情日」入口、草稿联动及专用逻辑；实际可用行情截至日仍来自保存来源，不合成今日价格。
- 标的提供常用 ETF 快捷选项且保留自由输入；金额统一跟随标的真实报价币种，不进行隐式汇率换算。
- 删除相对 DCA 差额度量/比较/CSV 和独立固定比例定投的注册、预设、搜索维度、账本入口；自动 DCA 基准保留。历史快照字段只作为读取兼容，不成为可执行旧入口。
- 自定义策略最多 10 个、固定类型最多一个，新增自定义名称带稳定序号；每棵买/卖树内同条件类型最多一个，买树与卖树可分别使用同一指标。校验和目录限制必须来自后端契约，UI 不复制边界。
- VIX 预设更名为「波动率信号定投」/「ボラティリティ積立」，稳定 presetId 不变。
- 验收：目录/默认日期/币种/实例数量与编号/重复条件前后端一致；历史读取保留；删除项无活动消费方，普通/搜索/基准及 CSV 回归通过。

### Task 86：弹窗本地编辑与强校验（对应 6/7/11/19）

- 共通和策略弹窗各持独立编辑缓冲与校验；弹窗编辑不写工作区草稿、运行按钮或保存结果。关闭前校验当前缓冲，存在错误或请求尚未完成时禁止完成、关闭、Escape 和背景退出；提供可见错误及焦点定位。校验通过一次提交草稿，不触发回测。
- 删除全局草稿自动校验与运行按钮可用性的联动；播放只受作业忙碌/目录可用影响，点击后校验并执行冻结的已保存草稿。
- 策略买入限额放最前，随后买/卖条件大卡片和必要搜索设置；金额单位全部来自共通设置选定标的。
- 验收：修改合法/非法值时背景按钮属性/文本和旧结果完全不变；错误下所有退出路径均阻止，纠正后可退出；嵌套错误、数字类型、键盘/触屏/双语通过。

### Task 87：策略一览与入口（对应 9/12/17/18）

- 策略添加即参与运行；完全删除实例启停字段/action/控件、状态标签、灰置逻辑及专用词典；条件买卖开关保留。
- 标题简化为策略一览，加号置标题右侧；固定类型防重，自定义最多 10 个且默认带序号，删除后不改已有编号。
- 验收：菜单/ reducer/提交限制一致，自定义编号在卡片、弹窗、保存结果中一致；无旧启停 UI/逻辑，双语/键盘/触屏/320px 可用。

### Task 88：停止运行与真实逐策略进度（对应 13/14）

- 增加停止按钮和作业停止 API；只终止未完成计算，已完成结果保留，停止操作幂等、可恢复，新增明确 cancelled 终态。计算循环协作检查停止信号，不能只关闭浏览器订阅。
- 作业按真实执行顺序逐条进入 running，等待项保持 queued；SSE 同时传递已保存的完成指标，比较表即时显示完成数据，不重复轮询 GET。
- 验收：排队、执行、搜索期间停止，重复停止、结束后停止、竞争更新、SQLite 重启/单 SSE/完成单 GET；完成数据不被覆盖，停止后可重新执行。

### Task 89：结果行点击与网格曲线（对应 1/2/15）

- 修正结果详情头部内边距。比较表删除 checkbox；点击行或原生键盘按钮切换选中，第二次点击释放，同时保持明细焦点规则和颜色映射。
- 网格搜索保存最佳候选资产曲线，并保存可按候选读取的计算输出；点击候选展示其保存曲线，不下载或重算，不使用当前草稿。候选大曲线按需读取，主运行响应避免包含全部搜索轨迹。
- 验收：行点击/Enter/Space/取消、多曲线/导出焦点、逐行进度；最佳及非最佳候选、复用计算、失败候选、重启后候选读取、数据/CSV 一致。

### Task 90：策略弹窗与文案复审（对应 7/18/19，整轮复核）

- 检查买入限额顺序、独立条件卡片、标题开关、连接器/防重、单位、说明、错误/关闭行为；删掉重复说明和废弃标签，保留必要公式/边界/可访问名称。
- 同步视觉原型和唯一 UI 规范；浏览器检查所有固定策略、自定义/搜索、320/768/1024/1920px、双语、原生缩放、键盘/触屏和 axe。

### Task 91：最终门禁、稳定化与自主推送

- 全量后端真实 Yahoo、前端单测/类型/lint/build、浏览器/axe、Ruff/格式/mypy，完整删除扫描及保存/CSV 回归。
- stabilization-loop 复现并修复当前范围内缺陷，最终复扫无新增中高问题；完成全部待办、更新规范及开发说明，提交推送 feature 分支并核实远端 SHA。

### 检查点 U

- [x] 默认日期/ETF/币种、固定定投及相对差额删除、自定义/条件限制一致。
- [x] 弹窗无背景联动，校验错误阻止退出，策略一览及买卖编辑清晰。
- [x] 停止与逐行进度真实，比较点击多选、网格候选保存曲线正确。
- [x] 全量门禁、复审/稳定化、源码清理、规范和远端核实完成。

阶段 21 的逐项验收、失败复现、修复及门禁结果统一记录在 `tasks/todo.md` 的阶段 21 验收与稳定化记录中。85–91 全部完成；本地门禁、最终复扫和 `origin/feature/remaining-v1-tasks` 远端 SHA 核实通过。

## 阶段 22：本金来源、结果选择与策略弹窗复核（2026-10-01）

本轮按 92 → 93 → 94 → 95 → 96 → 97 执行 loop-engineering，最后 stabilization-loop。用户已确认已投入本金按资金来源追踪；第 11 项 AND/OR 已确认无问题，保持现有同组统一切换，仅做回归。继续使用 feature 分支、自主提交推送，不新增 Workflow 产物。

### Task 92：已投入本金与金额审计（对应 2）

- `actualInvested` 改为注入资金首次用于买入的累计本金；卖出回收资金（含收益）优先用于再买，不重复累计。每一天满足 0 ≤ 已投入本金 ≤ 累计注资本金，完整投入可相等；无买入为零。成交额仍逐笔保留在交易明细。
- 唯一指标模块计算并保存每日/汇总口径，CSV 只读取保存值，禁止在导出中另算买入累计。增加口径标记，旧快照的成交累计不能冒充新的已投入本金；版本/指纹及类型同步。
- 验收：无信号、部分投入、赚/亏后卖再买、多次注资与再投入、DCA/一次投入/普通/搜索均一致；总资产、现金、净收益、收益率、XIRR、回撤及 SQLite/CSV 对照通过，真实 Yahoo 门禁通过。

### Task 93：新运行重置与忙碌保护（对应 5/6）

- 新 runId 重置结果选择、焦点、图例、时间窗、定位/高亮、候选和排序；同一次运行的进度/最终读取不改用户选择。新运行采用初始显示默认值，不能继承上一运行的列表。
- 执行/校验期间禁止共通/策略编辑、追加删除、结果选中/排序、搜索候选及图表交互等可改变执行上下文的操作；停止始终可用，滚动查看和真实进度继续。入口和处理均有保护，不只做视觉灰置。
- 验收：第二次运行默认值、SSE/最终更新、恢复/停止/取消、快速点击与键盘路径，无草稿或结果竞争。

### Task 94：独立指标来源、策略命名与字号（对应 3/4/9）

- VIX 等波动率曲线从已选策略的保存信号取得，改变明细焦点不会隐式隐藏已选策略所需指标；不同指数不混值。
- 资产曲线图例/常驻读数明确标注所属策略，统一颜色不随排序或焦点改变。控件使用简洁的“策略资产”，不再以“总资产”指代所有策略。
- SVG 坐标说明随浏览器缩放，与普通文字保持共同的缩放比例；窄屏可读、无裁切，联动几何与辅助高度保持一致。
- 验收：VIX + MA/DCA 多选/取消/换焦点、VIX/VXN/VXD 保存来源、候选、新运行，100/125/150% 原生缩放和 320–1920px 布局。

### Task 95：选中卡片、动态排名与列排序（对应 1/7/8）

- 左侧选中策略保持悬停的深色背景；删除操作仍按原有悬停/键盘可见规则。
- 比较默认按本金收益率降序，已完成结果即时挪到对应位置，待完成保持稳定原序；排名变动有简洁位移动画并尊重减少动态偏好。
- 每列提供可访问的升/降序排序，数值按原值比较，空值置后，并列稳定；结果颜色按保存身份保持一致，排序不改变选中/明细/导出。
- 验收：逐个完成的排名、并列/零/负值/缺值、全部列点击与键盘、排序动画、颜色、运行期间保护。

### Task 96：所有策略弹窗的买入上限与适用性（对应 10，11 回归）

- MA 买卖与 MA 只买加入共用月度信号买入上限（默认不限，以保持原计算）；注册表是唯一来源，账本已共用该上限。现金安全阀仅适用于定投类型，不强行让趋势策略在空仓时买入。
- 横向复核所有固定/自定义/搜索的上限置顶、单位、买卖卡片、条件参数适用性、错误/关闭与同组 AND/OR 行为；无不生效或缺失控件。
- 验收：所有目录渲染/后端校验、MA 月上限对成交生效、默认结果不变、普通与搜索同入口，双语/键盘/触屏/响应式。

### Task 97：整轮验收、稳定化与远端同步

- 全量后端（含真实 Yahoo）、前端单测/类型/lint/build、Playwright/axe/原生缩放、Ruff/格式/mypy；针对用户歷史指摘扫描删除项、联动残留和快照一致性。
- 完整 diff 复审和简化，stabilization-loop 复现修复后再次扫描无新增中高问题；同步规范/原型/开发说明和待办，自主提交推送并核实远端 SHA。

### 检查点 V

- [x] 资金来源与每日/汇总/CSV 一致，旧口径不误标，金额算法精确和真实数据通过。
- [x] 新运行重置、执行保护、VIX 来源和策略资产名称独立且一致。
- [x] 选中背景、动态排名/全部列排序、缩放字号及所有策略弹窗通过浏览器验收。
- [x] 全量门禁、最终复审/稳定化、规范/待办及远端核实完成。

阶段 22 的失败复现、修复及最终门禁统一记录在 `tasks/todo.md`；92–97 全部完成；实现、全量门禁、复审/稳定化及 feature 分支推送/远端 SHA 核实通过，检查点 V 关闭。

## 阶段 23：全画面稳定化与策略弹窗重点复审（2026-10-02）

用户要求继续未完成项，先全面审查 UI/UX，再重点优化策略弹窗；本轮持续有证据的迭代直到本次五小时额度边界。此前 1–97 的关闭记录保留，新发现与追加要求按本阶段修复。遵循 stabilization-loop 的发现/复现/优先级流程，每项修复走 loop-engineering；不以空转消耗额度。

### Task 98：补齐策略选中整卡效果并重新核对十一项指摘

- 未选中的策略卡片缩进 8px，选中后缩进 0、轻微放大 1.015 倍并以阴影前浮；160ms 过渡不改变行高，减少动态效果时关闭过渡。整卡和内部按钮保持同一悬停背景，鼠标离开和关闭弹窗后仍可明确识别。保留键盘焦点/ARIA、触屏操作和独立结果选择。
- 逐条复核阶段 22 的十一项：选中、本金追踪、多选波动率、策略资产名称、新运行重置、忙碌保护、动态排名、全部列排序、原生缩放字号、各弹窗买入上限和已确认的同组 AND/OR。
- 验收：先失败的真实浏览器整卡背景/缩进断言；切换、弹窗退出、窄屏与双语；金额真实行情及已有回归通过。记录每条证据，不以已打勾代替验证。

### Task 99：控制长结果表并回收中等宽度的视口

- 21 个允许结果在桌面把比较表撑到 1276px，图表标题位于 1505px。比较和搜索长表限制高度、固定表头，内部滚动，保留完整数据、排序/排名与键盘可达。
- 768–1279px 顶栏即使有足够横向空间仍固定两行 105px，减少 50px 结果可见空间；改为同一常驻单行顶栏，保留手机换行、触屏命中和短屏布局。
- 验收：1920×1080、1440×900、1024×768、768×1024、多策略/长表/逐条排序、内部滚动/表头、缩放/触屏/axe；保持已有首屏绘图区门槛。

### Task 100：复审弹窗校验、错误定位与条件排版

- 全面检查固定/自定义/搜索及共通弹窗：有效/禁用/嵌套/错误/网络等待、关闭与本地缓冲隔离、长内容和 320px；仅修复可复现问题。
- 统一买卖卡片、条件边界、开关位置、标签/单位/提示密度和键盘焦点；错误与等待必须有可见反馈，不能遮挡输入或把退出按钮挤出视口。
- 验收：针对发现先建立失败断言；真实浏览器/双语/键盘/触屏/axe、快照不变和全部弹窗字段复核。

### Task 101：补齐网格搜索候选值的可编辑配置

- 审查确认 UI 只选搜索维度，候选值始终取预设常量，用户无法编辑设计要求中的搜索取值。恢复既有设计功能，参数注册表/候选枚举/校验/快照/导出继续单一来源。
- 在搜索设置内显示各维度的候选值、单位和组合数；所选字段直接引用普通参数的类型/边界，未选维度保留配置但不参与计算。候选值编辑独立于基础条件字段。
- 验收：编辑值确实影响普通搜索候选，非法/重复/空/组合上限可定位；保存、恢复、候选曲线和 CSV 一致；前后端与真实来源回归。

### Task 102：集成门禁、重复发现循环与自主推送

- 逐项修复后复扫全画面，最后重点复审策略弹窗；持续记录新证据，不重复报告旧问题。复现问题追加到同一待办，不建立 Workflow 或第二套计划。
- 运行前后端门禁、Playwright/axe/原生缩放；审查 diff、简化当前改动、同步规范/原型/开发说明。按可验证切片提交并推送 feature 分支，独立核实远端 SHA。
- 在资源边界前保存可审查的完整切片，未解决发现如实保留；不把未完成复审标记完成。

### 检查点 W

- [x] 追加选中整卡效果和此前十一项均有实际复核证据。
- [x] 多策略密度、长表、全部视口与主要生命周期通过。
- [x] 固定/自定义/搜索弹窗重点复审及候选配置通过。
- [ ] 全量门禁、复审/简化、规范/原型及远端核实完成。
