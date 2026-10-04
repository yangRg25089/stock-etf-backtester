# 全仓代码简化审计（2026-10-03）

## 1. 范围、结论与证据口径

基线为 `main/65e4eab`，开始时工作树干净。本轮按 code-simplification 的“先理解用途和调用，再判断能否删除或抽取”要求检查。业务源码保持原状；本文件和任务记录属于审计产物。

扫描范围为后端 `app/` 的 60 个 Python 文件、前端 `src/` 的 55 个非生成 TS/TSX 文件和 2,958 行 CSS，共 26,309 行。另检查测试引用、配置和脚本：43 个后端测试文件、21 个前端单测文件及 15 个浏览器测试文件。方法包括 Python/TypeScript AST、TypeScript 符号引用、静态检查、CSS/翻译键查找、Git 历史，以及重点调用链审阅。全量静态扫描不等于执行了所有输入或逐行证明正确。

结论：

- **新确认的边界缺陷**：浏览器结果缓存校验过浅，会把不完整结果交给图表并触发 TypeError；成功 HTTP JSON 响应也缺少结构校验。详见 CS-01。
- **已经登记的未完成能力**：历史 PE 尚未接入普通回测的数据提供层，不能把纯估值模块当作废代码删除。详见 CS-02、Task 135。
- **可以优先清理的残留**：无仓库调用的目录别名、闲置条件遍历器、侧栏宽度变量、旧 CSS 选择器、重复 CSS 声明和退役控件文案。
- **需要分步共通化的部分**：值判断、结果状态、API 错误解析、诊断去重、普通/搜索计算编排、图表系列构建、弹窗展示外壳。
- **不能直接清理的部分**：仅有测试调用的旧 reducer 入口、账本的旧叶子信号兼容分支、历史快照的诊断翻译和独立金融验算代码。

本轮没有发现新证据证明交易或指标算法普遍计算错误。缓存缺陷是独立的边界问题；算法正确性仍须以真实来源及确定性验算门禁为准。

## 2. 发现清单

优先级说明：P2 为应优先修复或收敛的缺陷/维护风险，P3 为低风险清理和可维护性改善。简化建议不是已发生故障的证明。

| 编号 | 分类 | 优先级 | 发现及处理方向 |
| --- | --- | --- | --- |
| CS-01 | 已复现缺陷 | P2 | 缓存/API JSON 边界缺少足够的结果结构校验；先修复，再作为共享校验入口。 |
| CS-02 | 已知能力缺口 | P2 | PE 数据提供层尚未接入，继续保留 Task 135，不能通过删模块或返回 false 掩盖。 |
| CS-03 | 无调用入口 | P3 | 8 个目录驼峰别名、3 个属性别名无仓库调用；确认公开接口用途后删除。 |
| CS-04 | 无调用函数 | P3 | `walk_conditions` 只递归调用自身，没有消费者；删除或在实际需要叶子遍历时使用。 |
| CS-05 | 测试保留的旧入口 | P3 | 逐字段策略更新和 `isPartialSuccess` 已无产品调用，仍受旧测试约束，须单独迁移测试入口。 |
| CS-06 | 样式残留/覆盖 | P3 | 闲置宽度变量、旧选择器和重复移动端声明；按最终计算样式收敛。 |
| CS-07 | 文案残留 | P3 | 已退役控件保留 11 个静态翻译键，日/中各一份；动态键及历史诊断另行保留。 |
| CS-08 | 低价值包装 | P3 | 结束日期直接转发函数和重复赋值已没有日期解析职责。 |
| CS-09 | 重复基础判断 | P3 | 6 个完全相同的 `isRecord`、相同数值转换和完成状态判断，可抽取小型纯函数。 |
| CS-10 | API 错误解析重复 | P3 | JSON、SSE、CSV 分别读取相同错误信封；共享解析，保留传输和取消差异。 |
| CS-11 | 诊断去重重复 | P3 | 普通运行、搜索和信号的完整对象去重可共享；供应商按字段去重的语义不同。 |
| CS-12 | 计算编排重复 | P2 | 普通回测与搜索重复组织信号→账本→指标，适合统一纯计算切片。 |
| CS-13 | 信号模块职责集中 | P2 | 条件树遍历、7 类叶子计算、三态合并和诊断装饰集中于长函数。 |
| CS-14 | 图表组件职责集中 | P2 | 系列构建、坐标、图例交互、读数和 SVG 渲染集中，且重复归一。 |
| CS-15 | 弹窗及 UI 组织重复 | P3 | 两种弹窗重复生命周期和外壳；诊断定位、策略菜单可按职责抽取。 |
| CS-16 | 数据提供层职责集中 | P3 | 大函数同时规划区间、加载/解析、处理预热和诊断，宜按输入输出拆分。 |
| CS-17 | 测试辅助重复 | P3 | 两个浏览器文件的 `openSaved` 完全相同，可共享装载辅助，保留独立预期。 |

### CS-01：缓存与 HTTP 结果结构校验不足

证据：

- [runPersistence.ts](../../frontend/src/features/runs/runPersistence.ts) 的 `isCachedRun`（第 11 行）仅检查策略结果的数组成员是对象，未校验搜索候选结构、信号 ID、结果状态、数值和运行身份关联。
- [runs.ts](../../frontend/src/api/runs.ts) 的 `requestJson`（第 76 行）在成功分支直接 `return payload as T`。类型断言不会在运行时校验服务响应；SSE 已有运行时检查，JSON 路径未复用同样的边界原则。
- [results/model.ts](../../frontend/src/features/results/model.ts) 的 `savedChartParameters`（第 41 行）读取 `search.candidates.find`，`selectedVolatilitySeries`（第 21 行）读取 `signal.signalId.startsWith`。

在隔离的 Node/VM 中转译原文件、使用内存 IndexedDB 和模拟 fetch，复现输出如下。没有访问或修改用户的 IndexedDB、SQLite、浏览器 profile，也没有网络请求。

```text
case=search  cacheAccepted=true  TypeError: Cannot read properties of undefined (reading 'find')
case=signal  cacheAccepted=true  TypeError: Cannot read properties of undefined (reading 'startsWith')
case=json-api  malformedSuccessAccepted=true
```

第一种结果的 `searchResult` 为 `{}`；第二种包含有 VIX 类型、单位和值但缺少 `signalId` 的信号对象；HTTP 模拟返回 `200` 和只有 `status` 的 JSON。现有浅校验均没有挡住它们。这是异常数据边界的可复现缺陷，不表示正常后端现在就在返回这些对象。

建议单独修复：

1. 为运行响应、候选详情及错误信封建立小型运行时读取/校验函数，缓存与对应 HTTP 入口共用。
2. 校验身份、允许状态、被消费的数组/记录、信号 ID 及必需数值；按照已经支持的旧快照版本处理合法可选字段，不把缺字段一律补成零或空数组伪造成功。
3. 损坏的浏览器结果回退到已有服务端恢复路径；失败的 HTTP 结果返回 `api.errors.invalid_response`。恢复不能覆盖正在编辑的草稿。
4. 保留原异常复现，增加损坏缓存、旧合法快照、正常/搜索/部分失败及重新运行的回归；不通过散布可选链隐藏问题。

这项会改变异常输入行为，属于缺陷修复，必须和保行为重构分开提交。

### CS-02：PE 模块属于未完成能力

[runs/yahoo_data.py](../../backend/app/runs/yahoo_data.py) 第 536 行的 `DataKind.VALUATION` 分支始终产生 `data.sec_valuation_provider_unavailable`。`data/fundamentals.py` 的估值函数已有精确测试，但没有接入此运行数据链。

保留 SEC/估值模块；Task 135 仍等待用户明确提供 SEC 请求联系人及可靠历史数据验证。不能把测试成功说成真实正向接入完成，也不能把 PE 不可用包装成未触发信号。估值模块的较大拆分宜放在正向链路验收之后。

### CS-03–05：接口及旧状态入口

**无仓库调用的别名：**

- [catalog/service.py](../../backend/app/catalog/service.py) 第 358–362 行：`getCatalog`、`getSearchableParameters`、`parameterKeysForPreset`、`presetDefaults`、`catalogAsDict`。
- [catalog/definitions.py](../../backend/app/catalog/definitions.py) 第 1029–1030 行：`getParameterDefinition`、`iterParameterDefinitions`；第 359/365/369 行：`default_value`、`min_value`、`max_value` 属性。
- [catalog/presets.py](../../backend/app/catalog/presets.py) 第 436 行：`getPresetDefinition`。

仓库源码和测试使用 snake_case 入口；生成前端调用的是 HTTP，不会调用这些 Python 别名。Git 历史显示别名来自早期目录实现。复用规范的 `getCatalog()` 是伪接口描述，清理时一并明确描述，保留真实 `get_catalog`。结论限于仓库调用，不声称已检查未知外部 Python 消费者；不删除实际使用的 `CATALOG`、注册表常量或包导出。

[domain/conditions.py](../../backend/app/domain/conditions.py) 第 83 行的 `walk_conditions` 没有外部调用。现有配置校验需要字段路径，信号合并需要遍历分组，不能为了使用这一个函数强行统一不同的树处理。

**仅剩测试调用的入口：**

[strategies/model.ts](../../frontend/src/features/strategies/model.ts) 的 `strategy.param` / `strategy.rules`（第 41–42、162–174 行）已不被 UI dispatch。策略弹窗缓存整份草稿，合法关闭时只提交 `strategy.commit`。`isPartialSuccess`（第 329 行）也只被旧单测调用，产品使用后端状态。

这些是退役候选，不是能直接删除的未测试废代码。保行为重构阶段先保留；后续以独立接口退役改动把既有草稿/快照隔离断言迁到真实 commit 入口，再删除旧分支。不得删断言或将测试改成只检查实现文本。

### CS-06–08：CSS、翻译及包装

[styles.css](../../frontend/src/styles.css) 的确认项：

- 第 198 行 `--workbench-config-width` 无读取者；当前布局不再提供拖动调整宽度。
- `.section-subhead`、`.shared-settings-heading` 及其弹窗后代规则在非生成组件中没有 class 消费者。
- `.checkbox-control` 的 `font-size` 第 1028 行被第 1108 行覆盖。
- `.strategy-card-actions` 第 1230、1250 行重复定义布局属性，后者覆盖前者；合并时保留前块仍有效的属性。
- 相同 `max-width:767px` 下 `.workbench-config` 第 2452、2582 行重复 6 个属性，`.workbench-results` 第 2464、2591 行重复 3 个属性。

按最终 specificity、媒体条件和源码次序整理，避免把“多个规则共同组成样式”误当作冗余。`.severity-*`、`.chart-trade-marker-sell` 是动态 class，仍在使用。

[messages.ts](../../frontend/src/i18n/messages.ts) 中确认已退役控件的静态键为：

```text
app.localOnly, page.subtitle, workbench.resizeConfig,
section.sharedSettingsHelp, strategy.setRunTarget,
strategy.currentRunTarget, strategy.parameterGroupNavigation,
results.role.strategy, results.role.benchmark,
results.compareToggle, export.csv
```

11 个键均无当前产品调用，日文与中文各一份。`export.csvLabel` 仍是实际导出按钮的无障碍说明，必须保留。动态参数/枚举/诊断键及旧快照可能保存的 `market.latest_quote_delayed` 不按全文搜索缺少字面调用就删除。

`.run-controls`、`.run-status-panel`、旧 scope 选项、`.local-tag`、拖动 grip 和 `showTrades` 等用户要求退役的产品入口，本次扫描没有发现仍存活的实现；历史设计说明和测试里的否定断言不属于残留 UI。

[config/summary.ts](../../frontend/src/features/config/summary.ts) 仅把 `shared.run.endDate` 原样返回，已没有动态日期计算；直接读取或保留明确语义 helper 二选一即可，优先级较低。`serializeDraftForApi` 已展开 `run` 又重复设置同一个 `endDate`，可直接移除冗余赋值。不要借此修改日期冻结或快照序列化规则。

### CS-09–11：小型纯函数共通化

- `isRecord` 在 `api/catalog.ts`、`api/runs.ts`、`api/exports.ts`、`DiagnosticList.tsx`、`runPersistence.ts`、`workspacePersistence.ts` 六处实现完全相同。适合一个 `shared/lib` 纯函数；具体业务校验留在各模块。
- [ResultsCharts.tsx](../../frontend/src/features/results/ResultsCharts.tsx) 第 91/97 行的数值/语言转换和 [format.ts](../../frontend/src/features/results/format.ts) 第 3/7 行相同，可复用。其他数字解析先核对空值、非法字符串、Decimal 字符串及符号语义，不能一并替换。
- `isCompletedResult`、`tradeStatusIsComplete`、导出成功状态集合重复判断 `completed | completed_with_warning`。共享状态谓词即可；终态集合还包含失败/不可用/取消，不能替换成同一集合。
- `RunApiError`、`ExportApiError` 和 JSON/SSE/CSV 错误信封读取重复。先抽取错误信封读取和默认连接诊断，保留类身份、HTTP 状态、取消传播、Content-Type 检查与文件解码边界。
- 后端 `manager._unique`（第 1119 行）、`search._unique_diagnostics`（第 564 行）、`StrategySignalSeries.diagnostics` 按完整 Diagnostic 对象稳定去重，可共享。`YahooRunDataProvider._unique_diagnostics` 第 720 行按 `(code,messageKey,asOf,source)` 去重，语义不同，不能直接换成前者。

不建立一个同时负责类型判断、请求、缓存、重试和 UI 的万能 helper。每个抽取必须有至少两个语义相同的消费点。

### CS-12：普通与搜索共享计算切片

[runs/manager.py](../../backend/app/runs/manager.py) 第 701 行 `_run_basic_strategy` 与 [search/engine.py](../../backend/app/search/engine.py) 第 215–280 行重复组织：

```text
冻结策略配置 → 收盘信号 → 账本成交 → MetricsInput → 指标
              → 诊断/技术指标/未执行信号 → 完成状态
```

交易、信号和指标算法已经共用，问题在重复的编排及输出拼装。建议抽取输入明确的纯计算函数，返回现有信号、账本、指标及诊断。manager 保留进度、停止和保存；search 保留候选生成、指纹、复用和排名。数据下载、缓存、角色/实例身份不移入计算模块。

共享函数需区分调用方添加的供应商/排程诊断，保持既有局部失败和异常边界；不能为了统一而改变普通/搜索的诊断集合。验收依赖现有单独/批量/反序/候选逐日等价证据，并要求 CSV/PNG 保存身份不变。

### CS-13：按条件职责拆分信号计算

[signals/evaluate.py](../../backend/app/signals/evaluate.py) 的 `_evaluate_strategy` 第 168 行约 349 行，内层 `evaluate_node` 第 187 行约 263 行。它同时负责树遍历、VIX/RSI/MA/布林/利率/PE 的叶子计算、参数读取、诊断路径装饰、三态组合和观测输出。

建议分为叶子求值与条件树组合两层，共享显式只读计算上下文。保留严格 unavailable 传播、t 日公开可用时点、VIX 两级优先级、最大卖出比例、观测顺序和完整字段路径。优先使用小函数，只有存在真实替换需求时才引入类。

[ledger/engine.py](../../backend/app/ledger/engine.py) 第 375 行 `_sell_triggers` 仍包含没有 `conditions.sell` 时按旧叶子信号推导卖出比例的分支。当前信号链提供合并结果，但精确账本 fixture 仍使用此接口。该分支涉及领域算法和测试输入协议，不能当作无调用代码随手删除；若退役，须先将兼容转换集中到明确边界并保留原交易断言。

### CS-14：图表数据模型与展示分离

[ResultsCharts.tsx](../../frontend/src/features/results/ResultsCharts.tsx) 共 1,049 行，`OverlayChart` 第 529 行约 296 行，`ResultsCharts` 第 826 行约 224 行。

已有 `chartModel`、`chartViewport`、`chartTradeMarkers`、`technicalIndicators`、`ChartCrosshair` 和 `useChartInteraction`，这些属于有效复用。剩余可分三步：

1. 共享系列构建函数：日期索引、股价归一、策略本金收益和可用性一次生成，主/比较曲线消费同一结构。
2. 提取坐标及单条 SVG 系列展示：统一轴、折线/面积/标记，但保留主图和辅助图的独立数值单位。
3. 分离常驻读数/图例状态与绘图区：悬停、键盘和点击锁定继续调用同一强调规则。

目前父组件和 overlay 都会遍历数据归一，属于可观察的重复处理；没有做性能测量，不据此宣称存在卡顿或量化收益。不增加图表依赖，不改变价格/本金口径，不把辅助图归一后叠到主图。

### CS-15：共享弹窗外壳及清晰 UI 边界

[SharedSettingsDialog.tsx](../../frontend/src/features/config/SharedSettingsDialog.tsx) 第 69 行与 [StrategyEditorDialog.tsx](../../frontend/src/features/strategies/StrategyEditorDialog.tsx) 第 108 行的 native dialog 生命周期相同；标题/关闭/禁用字段/诊断/完成按钮也重复。`useDialogValidation` 已共享，继续使用。

可抽取窄接口的展示外壳及 modal 生命周期，传入合法关闭处理。通用设置与策略的缓冲、币种获取、规则树及提交仍归各功能模块；保留现有 portal 差异或单独验证挂载位置。不得因抽取而恢复“每次修改驱动运行按钮/旧结果”的联动，也不能绕过错误时禁止关闭的约束。

另外两项小切片：

- `App.tsx` 第 97 行 `fieldActionForDiagnostic` 混合字段路径解析与打开/定位动作；纯解析函数返回定位目标，App 执行动作。
- `StrategyNavigator` 的追加菜单与策略卡片、`ConditionNodeEditor` 的叶子卡片与分组连接可按展示职责分组件。现有 registry 驱动的 `ParameterField` 应继续共享，不为每个策略复制一套字段 UI 或前端边界值。

### CS-16：数据提供层按规划/加载/规范化拆分

`YahooRunDataProvider.load_for_run` 第 127 行约 295 行；Yahoo 行情与宏观适配器的 `load` / `load_macro` 约 211/228 行；估值模块也有较长选择逻辑。

推荐先把可用日期/预热/依赖规划和纯响应解析分开，再由现有 I/O 边界执行加载。保留供应商失败和程序错误的区别、币种、拆股双价格、公开可用时间、有效日期调整、缺口诊断及指纹。不要扩大 catch 来获得简短函数，也不为简化而在策略层下载数据。

核心账本的日内顺序虽然长，但已经按交易阶段清晰排列；不能仅因行数超过阈值而拆散资金事件顺序。PE 大规模重构等待 Task 135 的正向样本。

### CS-17：只共通测试装载，不共通独立预期

`frontend/e2e/phase27-feedback.spec.mjs` 第 16 行与 `phase30-ui.spec.mjs` 第 24 行的 `openSaved` AST 完全相同，适合放入已有 e2e helpers。

真实矩阵、有理数参考、CSV 和 PNG 的独立验算不与生产算法合并；它们看似重复的金额/指标计算用于发现生产错误。也不为了重构删除旧断言、降低精度、跳过测试或新增长期 suppression。

## 3. 建议执行顺序及验收

实现建议已登记为 Task 142–148，尚未实施。CS 编号用于追溯，不另建第二套产品规则。

| 顺序 | 任务 | 范围 | 验收重点 |
| --- | --- | --- | --- |
| 1 | Task 142 | CS-01 结果读取边界修复 | 异常缓存/API 不崩溃，旧合法快照可读，草稿/保存身份不混用。 |
| 2 | Task 143 | CS-03–08 确认残留清理 | 无调用入口删除完整；有效包导出、动态 CSS/翻译和旧快照兼容保留；所有既有行为断言继续有效。CS-05 接口退役单列，先不强删。 |
| 3 | Task 144 | CS-09–11、17 小型共通函数 | 错误、空值、状态、取消、去重顺序完全等价；不共通独立测试预期。 |
| 4 | Task 145 | CS-12 普通/搜索纯计算切片 | 普通/基准/批量/候选逐日、诊断、身份、保存和 CSV 等价。 |
| 5 | Task 146 | CS-13、16 信号及数据模块 | 叶子/分组层清晰，三态/诊断路径/成交时点不变；I/O 异常边界保留。PE 大拆分仍等待 Task 135。 |
| 6 | Task 147 | CS-14–15 图表和弹窗 | 多选/排序/图例/买卖点/滚动/缩放/常驻读数等价，弹窗隔离和错误关闭规则不变。 |
| 7 | Task 148 | 差异复审及完整验收 | 全部现有测试、真实数据、浏览器/axe、类型/lint/build、保存导出及文档检查，无新行为偏离。 |

缺陷修复、接口退役、纯重构分开记录；每个切片单独验证。超过 500 行的搬移优先用可审阅的 AST/codemod，而不是把多模块人工改写成一份大补丁。抽取前后比较输入/输出、错误类型、路径、副作用和顺序，不能仅以“行数减少”验收。

## 4. 本轮实际执行的检查

| 检查 | 本轮结果 |
| --- | --- |
| `node ./frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit --noUnusedLocals --noUnusedParameters` | 通过；额外开启 unused 检查也未报错，但无法发现有导出/测试引用的退役入口。 |
| `cd frontend && npm run lint` | 通过，零警告。 |
| `cd backend && .venv/bin/ruff check app` | 通过。 |
| 隔离 Node/VM 缓存和 JSON 边界诊断 | CS-01 的三种异常输入均确认未被拒绝，两种图表消费者抛出 TypeError。 |
| `git diff --check` | 审计文档与任务记录通过。 |

本轮没有运行单元测试、真实行情回归、完整构建或浏览器 E2E，没有改应用源码。上轮阶段 33 的后端 534、前端 202、浏览器 121 通过属于既有基线，不能作为未实施重构的验收，也不覆盖本轮新增的异常缓存场景。后续如需导入后端应用，继续使用隔离运行库 `STOCK_ETF_BACKTESTER_RUN_STORE_PATH=:memory:`。

Task 102、检查点 W、Task 120 的远端目标确认以及 Task 135 的真实 PE 接入依赖仍未解决；本次没有远端写入、分支删除或用户存储清理。
