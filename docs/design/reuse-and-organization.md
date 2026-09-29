# 复用与组织规范

本文件定义 V1 唯一的策略目录、参数归属、运行状态、界面组件、模块接口和工作顺序。交易与财务计算的具体规则以[回测器设计稿](../superpowers/specs/2026-09-28-stock-etf-backtester-design.md)为准。实现时同一概念只保留一个字段定义和一个计算入口；预设只提供参数，不复制算法。

## 策略目录与计算模块

| 目录 ID / 用户可见类型 | 执行模块 | 差异仅来自配置 |
| --- | --- | --- |
| `vix_dca` / VIX 信号定投 | `accumulation` | 默认仅启用 VIX 买入信号；代码、阈值和信号月限可编辑，默认不卖出 |
| `composite_dca` / 多条件定投 | `accumulation` | 买入信号集合、AND/OR、固定比例定投、卖出规则 |
| `ma_trend` / MA 买卖 | `trend` | `sellBelowOrEqualMa=true` |
| `ma_buy_only` / MA 只买 | `trend` | `sellBelowOrEqualMa=false` |
| `monthly_dca` / 定额月度定投 | `scheduled` | `fundingMode=monthly` |
| `lump_sum` / 一次性投入 | `scheduled` | `fundingMode=upfront` |
| `grid_search` / 网格搜索 | `search` 作业包装 | 实例持有一份 `accumulation` 基础参数和搜索维度，候选仅覆盖所选键；每一候选调用普通校验/执行/指标模块 |

自动显示的 DCA 与一次投入基准分别使用 `monthly_dca`、`lump_sum` 的同一参数、账本和指标模块，结果角色为 `benchmark`。用户添加同种策略时角色为 `strategy`、实例 ID 独立；相同计算指纹可复用结果，但不能把两行身份混成一个实例。搜索也不拥有独立的交易规则。

目录中的用户可见名称表示预设类型，不锁定实例参数。`vix_dca` 的日文 UI 名称为「VIX シグナル積立」，首屏摘要显示当前配置（例如 `VIX: ^VIX ≥ 25、月間最大 1 回`）；`vix.buyEnabled`、`vix.symbol`、`vix.buyThreshold` 和相关买入次数都可以编辑。关闭 VIX 信号时仍保留 `presetId=vix_dca` 和实例身份，界面明确显示「VIX シグナル無効」，不静默改成另一种策略；空买入信号集合按统一信号规则处理。

首屏 VIX 信号定投是上述目录中的普通预设，可删除后重新添加。实例参数相互独立；复用的是字段定义、输入组件和算法，不是用户编辑中的数值。

## 唯一参数注册表

后端的 `ParameterDefinition` 注册表是默认值、类型、单位、取值范围、适用目录、可搜索性、依赖和日中翻译键的唯一维护点。前端通过目录接口取得元数据并渲染字段；服务端用同一注册表完成最终校验。TypeScript 结构类型由服务端公开契约生成，不在前端另写默认值或边界。跨字段约束（如 VIX 阈值顺序、搜索组合数）也集中在一次配置校验中。所有配置键稳定、不翻译。

`type` 只允许 `symbol | date | integer | decimal | ratio | percent_point | boolean | enum | enum_list | number_list`。`ratio` 在保存和计算中恒为 0 至 1；`percent_point` 以 2.5 表示 2.5%，不能有的字段存 `0.025`、有的存 `2.5`。金额是数值，币种来自所选标的的行情元数据；单位只在 UI 外层显示。空值、非法范围与无适用性是三种不同校验结果。

| 统一键或键族 | notebook 输入 / 默认值 | 所属层级及复用规则 |
| --- | --- | --- |
| `run.symbol` | 标的代码 / `QQQ` | 共享；行情、基准、所有实例同一代码 |
| `run.startDate`, `run.endDate`, `run.endMode` | 回测起始日 / `2020-01-01`；回测结束日 / 最近完整日 | 共享；动态模式显示实际解析的结束日并锁定日期框，取消「最新まで」即可修改固定日期；每次运行冻结解析值 |
| `contribution.day`, `contribution.amount` | 每月注资日 / `1`；每月注资金额 / `100` | 共享；所有账本与基准调用一个日历生成器 |
| `data.macroStalenessSessions` | 宏观数据最大陈旧交易日 / `3` | 共享数据有效期；按交易所 session 计数，并随运行设置冻结 |
| `accumulation.cashSafetyLimit` | 强制买入现金限额 / `1200` | 策略实例；VIX 和多条件定投共用字段/规则 |
| `accumulation.maxSignalBuysPerMonth` | 每月最多买入次数 / VIX `1` | 策略实例；多条件定投默认 `null` 表示不限，显式数字须为正整数；仍用同一定义 |
| `accumulation.conditionLogic` | 条件逻辑 / `OR` | 策略实例；只组合有效的已启用买入信号 |
| `accumulation.fixedDcaEnabled`, `accumulation.fixedDcaRatio` | 启用固定比例定投 / 多条件默认开；固定定投比例 / `0.5` | 策略实例；比例 0..1，固定部分计入总资产 |
| `vix.buyEnabled`, `vix.symbol`, `vix.buyThreshold` | 启用 VIX 信号 / 开；VIX代码 / `^VIX`；VIX阈值 / `25` | 策略实例；VIX 信号定投预设和多条件预设共用信号定义，代码与阈值可编辑 |
| `rsi.buyEnabled`, `rsi.period`, `rsi.buyThreshold` | 启用RSI / 多条件默认开；RSI周期 / `14`；RSI阈值 / `30` | 策略实例；同一周期结果供买卖复用 |
| `ma.buyEnabled`, `ma.period`, `ma.buyDeviationPct` | 启用200日均线 / 多条件默认开；均线周期 / `200`；价格低于均线百分比阈值 / `-1` | 策略实例；`buyEnabled` 和偏离阈值只适用多条件，趋势策略必需 `ma.period` 并使用同一均线实现 |
| `bollinger.buyEnabled`, `bollinger.period`, `bollinger.stddev` | 启用布林带 / 多条件默认开；周期 / `20`；标准差倍数 / `2` | 策略实例；上下轨由同一指标模块给买卖规则 |
| `rate.buyEnabled`, `rate.symbol`, `rate.thresholdPct`, `rate.sourceUnit` | 启用利率 / 关；利率代码 / `^TNX`；利率阈值 / `2.5`；来源单位默认由适配器识别 | 策略实例；无法识别单位时可显式选取并记录 |
| `pe.buyEnabled`, `pe.threshold`, `pe.etfMinCoverage` | 启用PE / 关；PE阈值 / `25`；ETF 覆盖率 / `0.80` | 策略实例；适用能力由数据诊断决定，不固定代码名单 |
| `exit.enabled`, `exit.vix.low1`, `exit.vix.ratio1`, `exit.vix.low2`, `exit.vix.ratio2` | 启用卖出策略 / 开；VIX卖出阈值1 / `12`、比例1 / `0.20`；阈值2 / `10`、比例2 / `0.30` | 策略实例；仅多条件策略；VIX 信号定投预设默认关 |
| `exit.rsi.enabled`, `exit.rsi.threshold`, `exit.rsi.ratio` | 启用RSI卖出 / 关；RSI卖出阈值 / `70`；比例 / `0.25` | 策略实例；即使 RSI 买入关，卖出开仍依赖 RSI 数据 |
| `exit.bollinger.enabled`, `exit.bollinger.ratio`, `exit.bollinger.vixCeiling` | 启用布林卖出 / 关；卖出比例 / `0.25`；原硬编码 VIX 20 | 策略实例；VIX 上限新增为显式可调字段 |
| `trend.sellBelowOrEqualMa` | 模式2买卖 / 开、模式3只买 / 关 | 预设差异；复用同一趋势模块和 `ma.period` |
| `search.dimensions`, `search.maxCombinations` | 模式4；VIX `[25,28,30,35]`、RSI `[25,28,30]`、安全阀 `[400,600,800]`、固定比例 `[0.3,0.5,0.7,1]`；组合上限默认 `1000`、可调，系统硬上限 `10000` | 搜索作业；维度引用上述注册键，只接受适用的可搜索数字字段 |
| `run.scope` | 策略模式 0..6 的现代化替代 | UI 运行状态；`active | all_enabled`，不保存为策略参数 |
| `display.showTrades`, `display.showChart` | 买入记录输出 / 开；绘图 / notebook1 开、notebook2 关 | 全局展示偏好；首屏两项默认开，追加第二份 notebook 的策略不改变这两个值；不影响交易数据或导出 |

注册表还要定义每项的具体上下界、步长和必要性；例如 `contribution.day` 为整数 1..31、比例 0..1、标准差倍数 >0、周期为正整数、金额不小于 0、搜索列表非空且去重。参数表的普通编辑器、搜索维度编辑器、服务端错误字段路径与导出配置快照都使用这些稳定键。`run.scope` 和语言选择是 UI 状态，不包含在算法哈希里。

网格搜索实例中的基础参数用 `accumulation` 同一字段定义与默认值，只是在渲染时增加 `search.dimensions` 编辑器。未被列为维度的字段保留该实例的基础值；列为维度的键逐候选覆盖，不能维护第二套搜索专用阈值或交易规则。

## 草稿、作业与结果状态

| 状态实体 | 唯一含义 |
| --- | --- |
| `StrategyInstance {id, presetId, enabled, params}` | 可编辑草稿；右侧列表行的启用开关是唯一写入入口 |
| `activeStrategyId` | 当前在左侧编辑的实例；点行名切换，不自动启用或运行 |
| `runScope` | `active` 或 `all_enabled`；当前实例必须已启用才能单独运行，全部模式至少有一条已启用实例；其余实例的错误不阻断本次所选实例 |
| `RunSnapshot {runId, config, catalogVersion, dataFingerprint, engineVersion}` | 提交时冻结的共享设置与各实例参数，不受后续草稿变化影响 |
| `StrategyRun` | 该快照中的实例状态、诊断、账本、指标、交易；`benchmark` 是角色字段，不是第二套算法 |
| `focusedResultId` | 结果页 KPI、交易明细和导出的归属；与 `activeStrategyId` 独立 |
| `visibleSeriesIds` | 只控制曲线显隐，不改变结果、启用状态或运行范围 |

作业及每条策略的状态码由后端给出：`queued | loading | running | completed | completed_with_warning | unavailable | failed`。`empty` 是结果页没有作业时的显示状态，不伪装成失败；零交易但指标完整仍是 `completed`。前端不可从“是否含 PE”自行推断失败，必须展示统一诊断码。全体失败与部分成功分别呈现。草稿与 `RunSnapshot` 不同则标记结果使用旧配置，不把旧 KPI 挂在新表单下面。

## 模块接口与目录组织

| 模块 | 小接口与职责 | 依赖 |
| --- | --- | --- |
| `catalog` | `getCatalog()`：预设、字段元数据、默认值、翻译键、可搜索字段 | 无业务 I/O |
| `config` | `validateDraft(draft, catalog)`：结构化字段错误及必要数据清单；在构造领域契约前用注册表物化 `DataSettings` 默认值 | `catalog` |
| `calendar` | `schedule(runSettings, exchangeCalendar)`：有效注资日期及金额 | 交易所日历适配器 |
| `market-data` | `loadMarket(spec)`：统一行情、两种价格口径、VIX/利率、币种及时间戳；`compose_data_snapshot` 将分离加载的供应商结果组合为同一 `DataSnapshot`；预热行情不改变回测日历，宏观源请求额外覆盖陈旧期回看 session，宏观原始日期/发布时间与对齐 session 分字段保存 | Yahoo 适配器；测试用固定 fixture 适配器；规范化结果经具备完整身份的有界缓存复用，显式刷新不读取旧缓存 |
| `fundamentals` | `loadValuation(spec)`：已公开财务/持仓、覆盖率、来源及公开时间 | SEC 适配器；测试用固定 fixture 适配器 |
| `signals` | `evaluate(config, snapshot)`：逐日 `true/false/unavailable` 与诊断 | 规范化数据、指标计算 |
| `ledger` | `runStrategy(config, schedule, signals, prices)`：统一交易顺序、每日总资产及交易 | 纯输入，不自行下载 |
| `metrics` | `summarize(trace, schedule)`：统一绩效指标 | `ledger` 输出 |
| `search` | `runGridSearch(baseConfig, dimensions, snapshot)`：按稳定候选序号枚举并复用 `config/ledger/metrics`；无效候选保留诊断但不排名；排名依次按期末资产降序、绝对最大回撤升序和候选序号；指纹包含目录/算法版本及所有计算输入，复用时仍保留候选 ID 和 `strategy` 角色 | 纯配置、共享数据快照 |
| `runs` | `createRun(snapshot)` 与 `getRun(id)`：编排、进度、局部失败和不可变结果 | 上述模块 |
| `api` | `/api/v1/catalog`、`/contracts`、`/config/validate`、`/runs`：Pydantic/OpenAPI 契约、结构化字段诊断、范围选择及 `Idempotency-Key` | `catalog`、`config`、`runs` |
| `export` | `exportRun(runId, kind, focusedResultId)`：从已存结果生成 CSV | `runs` 结果，不重新计算 |

建议目录按职责放置：`backend/app/catalog`、`config`、`data`、`domain`、`runs`、`export`；`frontend/src/features/config`、`strategies`、`runs`、`results`、`i18n`；统一表单控件放 `frontend/src/shared/ui`。这些是组织边界，不要求每个目录包装一个透传模块。领域契约只接收已物化的数据设置，不反向导入 catalog；注册表默认值与适用边界由 catalog/config 边界提供。数据供应商更换只改适配器，策略逻辑与 UI 契约不变。

## V1 组件清单与统一规则

| 组件 | 唯一职责 |
| --- | --- |
| `ParameterField` / `FieldGroup` | 按注册表渲染标签、数字/日期/代码输入、单位、依赖、校验信息；全界面同尺寸/焦点/错误样式 |
| `SharedSettingsForm` | 标的、区间、注资金额和日期；不在策略编辑器重复 |
| `StrategyListRow` / `StrategyCatalogMenu` | 切换编辑对象、唯一启用开关、添加完整 7 类目录、删除实例 |
| `StrategyEditor` / `SignalEditor` | 由实例预设与注册表生成相同类型的信号和卖出控件；停用不丢值 |
| `RunControls` | 一个 `runScope` 分段选择和一个执行按钮；当前实例停用或全部模式无启用实例时禁用执行并指出原因 |
| `StatusView` / `DiagnosticList` | 统一状态码、数据覆盖、错误原因和翻译 |
| `ResultViewer` / `ChartLegend` | 聚焦结果、指标、曲线显隐、交易明细；图例不修改策略启用 |
| `ExportControls` | 从当前结果快照选导出种类；无结果禁用，零交易可导出表头 |
| `SearchDimensionEditor` | 从注册表筛选可搜索字段，沿用普通输入的单位、范围和错误 |
| `LocaleControl` | 可访问的日/中文分段控件；只改变文案与格式 |

相同控制统一样式和交互：二元值用开关，模式用分段控件，多项目录用菜单，数值用不含单位的数字控件，明确命令用文本加 Lucide 图标。操作区域只有一个主按钮。桌面可见输入高度统一，触屏命中区域至少 44px；窄屏允许顶栏、长名称、输入组换行，不能裁切内容。绘图和交易记录是结果区两项独立开关。日中词典覆盖字段、状态、诊断、空态和导出；内部键及 CSV 字段名保持不变。

## 组织顺序与检查点

| 顺序 | 交付内容 | 在下一阶段开始前可检查的条件 |
| --- | --- | --- |
| 1. 契约 | 策略目录、字段注册表、快照/结果结构、固定测试数据 | 7 类目录和所有 notebook 显式输入有一一映射；普通/搜索字段无第二份定义 |
| 2. 数据与时间 | 交易所日历、贡献计划、行情与 SEC 适配器、公开时间及两种价格口径 | 固定 fixture 能重现缺行情、披露晚于收盘、拆股基准、ETF 覆盖边界 |
| 3. 纯回测 | 信号、统一账本、绩效、基准和搜索包装 | 相同配置不同入口结果一致；固定比例 100% 等于 DCA；t 信号只在 t+1 执行 |
| 4. 应用与画面 | FastAPI 作业/目录/结果/导出，React 的共享组件与 i18n | 当前/全部运行、启停、草稿变更、局部失败、结果聚焦与 CSV 共用一套状态 |
| 5. 集成验收 | 固定数据端到端、320/768/1024px 画面与可选实时数据检查 | 回测结果和图表、表格、CSV 相同；所有验收用例通过 |

依赖方向是目录/配置与数据快照 → 信号/账本 → 指标/搜索 → 作业与导出 → 界面。同类功能扩展先修改其唯一维护点，再检查普通运行、搜索、基准、导出和日中界面的复用用例。
