# 前后端代码简化复审（2026-10-05）

## 范围与结论

基线为本地 `main / 5826b88`，开始时工作树干净。本轮按 code-simplification 技能检查前后端，完成全量结构扫描、重复/引用扫描，以及重点调用链、测试和 Git 历史复核。未修改应用源码或测试。

扫描范围：后端 `backend/app` 的 82 个 Python 文件、前端 `frontend/src` 的 105 个非生成 TypeScript/TSX 文件，以及 17 个样式分文件和样式入口，合计 31,804 行。前端计数包含双语词典；生成契约单独核对使用方式，不作为手工简化对象。长函数和分支计数仅用于选取审阅重点，不作为缺陷证明。

确认 8 项可维护性改善建议，其中 3 项为优先考虑的职责收敛、5 项为局部去重或可读性改进。本轮没有确认新的功能缺陷，也没有确认可立即删除的无消费者实现。静态检查不能证明运行行为完全正确；下列建议尚未实施，不能算作重构验收通过。

上次[代码简化审计](2026103-code-simplification-audit.md)的 Task142–148 已有闭环记录，本轮核对的共享读取、对象判断、API 错误读取、诊断去重、模拟入口、图表模型、弹窗外壳及供应商拆分仍存在。不重新把已完成的工作列为遗漏。CS-05 的测试保留入口和 ETF 能力缺口另见下文。

## 发现清单

P2/P3 表示维护优先级，不表示已发生运行故障。

| 编号 | 优先级 | 当前问题 | 建议边界 |
| --- | --- | --- | --- |
| CS52-01 | P3 | 精确百分数和离线 CSV 重复展开科学记数法 | 共用纯字符串小数点移动，不合并各自输入/输出政策 |
| CS52-02 | P3 | HTTP 成功响应校验使用嵌套三元式 | 用命名校验分派明确 ActiveRun、RunResponse、StrategyRun 的区别 |
| CS52-03 | P3 | 离线 CSV 多次内联展平指标，搜索行集中组装 | 在 CSV 模块内抽取指标展平和搜索行构建 |
| CS52-04 | P3 | 两种自动基准重复取消、进度和异常编排 | 按现有基准顺序循环执行，保留阶段标识和局部失败 |
| CS52-05 | P2 | 一个运行 hook 同时负责恢复、提交、停止、校验、导入和保存 | 先收敛订阅/终态读取，再按职责拆分，保留各入口竞态保护 |
| CS52-06 | P2 | 结果查看器同时构建候选/基准映射、比较曲线、排序和技术指标 | 抽取纯选择投影，候选请求和界面状态留在组件 |
| CS52-07 | P2 | 搜索结果校验器集中三种优化模式的全部关系校验 | 保留共同身份检查，提取各模式私有校验函数 |
| CS52-08 | P3 | 共享参数组件集中字段外壳、列表编辑和所有输入类型 | 先抽取数值列表控件，保留统一字段语义 |

### CS52-01：共通精确小数展开

位置：[`formatExactPercent`](../../frontend/src/features/results/format.ts#L47) 和 [`fixedDecimal`](../../frontend/src/features/results/importedCsv.ts#L8)。两处都按符号、有效数字和指数生成小数点位置，再分三种情况补零/插入小数点。Git blame 显示两者进入当前实现的提交均为 `610fcb9`。

建议只抽取“数字字符串及小数点位置 → 展开后的字符串”的小型 helper。外围政策不同：百分数要移动两位、去尾零、把负零显示为 `0%`、非法值显示占位；CSV 只对生成契约标记的数值列展开，保留原有精度/尾零，代码和身份不能被改写。`ParameterField.shiftDecimal` 处理数值输入，`contractReader.decimalIdentity` 用于比较，不能直接替换为这个格式化 helper。

保留验收：`frontend/tests/period-performance.test.mjs` 的精确百分数断言、`frontend/tests/package-model.test.mjs` 的后端 CSV 字节等值及 `1E3`/`2E3` 身份用例。既有断言不修改。

### CS52-02：HTTP 校验分派可读性

位置：[`requestJson`](../../frontend/src/api/runs.ts#L55) 的成功响应分派，特别是第 86 行。当前嵌套三元式把通用 Schema 和两个专用结果校验混在一个表达式里。

建议使用 `isResponseForContract(contract, payload)` 或显式 switch。ActiveRun 允许 null 且只接受活动状态；普通 RunResponse 和 StrategyRun 继续走已有语义校验；其他契约使用生成 Schema。请求身份与响应身份的后置匹配仍保留。JSON 和 SSE 可共用已有错误信封解析，SSE 的流读取、分块换行、终态和取消规则保持独立。

保留验收：`frontend/tests/runs-api.test.mjs`、`contract-reader.test.mjs` 和 `frontend/e2e/phase51-strict-audit.spec.mjs`。异身份、畸形响应、活动作业/null、SSE 分块换行和取消结果必须等价。

### CS52-03：离线 CSV 行构建

位置：[`importedCsv`](../../frontend/src/features/results/importedCsv.ts#L32)，第 43、56、60 和 68 行附近重复展平 summary、analysis、tradingCosts。测试指标的展平目前还写在逐字段 map 内，重复构造同一对象。

建议在本模块抽取 `flattenSavedMetrics` 和 `searchCandidateCsvRow`，每个候选只构造一次测试指标映射；把 `csvValue` 和递归键排序改成显式分支，提高阅读清晰度。服务端已有 `_metric_values`，但不能让离线导出依赖服务端实时请求，也不能在前端重新计算指标。

保留字段展开顺序、冲突覆盖顺序、生成列顺序、JSON 字典键顺序、空值、换行和原始 Decimal。只共通序列化表达，不新增第二套 CSV 字段定义。

保留验收：`frontend/tests/package-model.test.mjs` 覆盖保存结果/候选的四类 CSV 与后端等值；`backend/tests/export/test_csv.py` 和 `frontend/e2e/phase35-local-files.spec.mjs` 覆盖原始精度、零交易和离线下载。

### CS52-04：基准执行编排去重

位置：[`RunManager._execute_run`](../../backend/app/runs/manager.py#L492) 的第 526–568 行。DCA 和一次投入各自重复 `_check_cancelled → _set_current → _run_benchmark → 异常转换 → _complete_run`。

建议按现有 `_BENCHMARKS` 顺序循环，使用明确的阶段映射保留 `monthly_dca`/`lump_sum` 日志标识。无需构造通用执行框架；单策略计算本来已经通过 `simulation.simulate_strategy` 共通，不重复抽取算法。

Git blame 确认异常处理与取消检查是后续局部失败/停止修复加入的，必须保留。无 reference_load 分支的完成方式、基准执行次序、每次检查取消的位置、进度发布顺序和异常边界不能改变。

保留验收：`backend/tests/runs/test_manager.py` 的基准身份、单策略失败隔离、停止保留已完成基准、排队停止和进度断言。现有测试未专门覆盖两种基准各自计算异常的所有阶段元数据，正式重构前需补行为基线，不能删掉异常转换来缩短函数。

### CS52-05：运行生命周期边界

位置：[`useRunController`](../../frontend/src/features/runs/useRunController.ts#L41)，254 行主体同时管理预校验、活动运行恢复、新运行提交、停止、浏览器保存和文件导入。恢复和新提交均执行进度订阅、终态 GET、保存配置和日期同步，但各自的保护条件不同。

建议先提取狭窄的“订阅进度后读取终态”异步操作，保留入口自己的 response 应用/保存回调；之后再将预校验职责拆成独立 hook。不要一次把所有 refs/state 搬进一个万能 controller 或 Context。浏览器保存必须读取冻结运行，不能改为保存当前编辑缓冲。

尤其保留：恢复入口的 submittedRunRef/controller 归属检查、停止请求的当前 runId/controller 匹配、提交前停止、停止失败后继续订阅及可重试、导入/新运行淘汰迟到响应。两处 finally 的当前写法不相同，不能简单复制其中一处覆盖另一处。

保留验收：`frontend/tests/runs-api.test.mjs`、`workspace-persistence.test.mjs`、`frontend/e2e/phase37-async-runs.spec.mjs` 和 `phase35-local-files.spec.mjs`。重连与新提交的竞态要按独立入口验证；仅通过类型检查不足以证明等价。

### CS52-06：结果选择投影

位置：[`ResultViewer`](../../frontend/src/features/results/ResultViewer.tsx#L27)，第 63–97 行构建主曲线、比较序列、颜色、技术指标；第 99–102 行查成交归属，第 145–146 行再次做同期间基准映射。`savedPeriodBenchmarks` 被多处重复调用，策略排序表达式嵌在 JSX 中。

建议在结果功能目录增加纯 `buildResultSelection`，一次计算期间基准及其 preset 映射，返回主曲线、比较线、排序身份、稳定颜色和成交 lookup。保留 `savedPeriodBenchmarks` 的唯一期间匹配语义。候选请求、AbortController、错误及解释 dialog 状态继续留在组件。

区分原始结果与显示用同期间基准，避免在 flatMap 内重新赋值 result。保留已选集合、明细焦点、价格显隐、波动率来源及图例高亮的独立状态；不借 refactor 改变零选择默认值、排名或颜色。主图 `OverlayChart` 仍有进一步抽取纯读数模型的空间，可在上述投影稳定后独立处理，不与坐标/手势同时改写。

保留验收：`frontend/tests/results-viewer.test.mjs`、`results-model.test.mjs`、`search-optimization.test.mjs`、`walk-forward.test.mjs`、`chart-boundaries.test.mjs`，以及已有多选、交易点、技术指标和期间基准浏览器检查。

### CS52-07：按优化模式组织搜索关系校验

位置：[`SearchResult.validate_candidate_identity`](../../backend/app/domain/contracts.py#L906)，150 行主体包含候选唯一性/序号/排名、Walk-forward 窗口与样本外结果、train/test 结果身份和期间基准、full-period 排除规则。

建议将共同检查留在当前 model_validator，依次调用本模块内的私有模式校验函数；它们是同一搜索契约的内部实现，不新增领域模型、继承层或插件注册表。

必须保持原来检查顺序、最先抛出的 ValueError 文案、Pydantic 错误路径、窗口连续性、基准数量/身份及生成 Schema。不得把“子模式校验太复杂”变成删除校验；前端独立读取边界仍需拒绝损坏的保存文件，不能仅依赖实时后端。

保留验收：`backend/tests/search/test_search.py`、`test_optimization.py`、`test_walk_forward.py`、领域契约/导出测试及前端文件读取测试。若现有用例没有覆盖每条首次失败文案，实施前增加行为基线；三份生成契约须保持字节一致。

### CS52-08：参数字段外壳与列表控件

位置：[`ParameterField`](../../frontend/src/shared/ui/ParameterField.tsx#L65)，257 行主体已共用字段标签、单位、依赖和错误，但数值列表的项目标签、数组修改及增删逻辑集中在同一组件内。

建议先抽取内部 NumberListControl，继续由 ParameterField 统一生成字段 ID、ARIA 描述、范围/步长、禁用和错误信息。普通输入不必按每种类型拆成小文件；布尔 checkbox 与 switch 的可访问语义不同，enum 和 enum_list 的翻译键也不同，不能因结构相近而统一成一个模板。

数值列表空项保留空字符串，普通空输入保留 null；ratio 的显示/提交小数位移动、必填规则、逐项单位 ID 和最低一项限制全部保持。参数默认值/边界仍只来自 catalog。

保留验收：`frontend/tests/shared-settings.test.mjs`、`ui-accessibility.test.mjs`、`strategy-ui.test.mjs` 及策略/共通弹窗的浏览器键盘、错误关闭和多尺寸验收。

## 残留代码与删除边界

| 对象 | 本轮确认 | 处理结论 |
| --- | --- | --- |
| `.run-controls`、`.run-status-panel`、拖动分隔线、旧运行范围/焦点选项、SQLite/IndexedDB 结果读取 | 当前前后端实现未找到相关旧入口；断言/历史文档中的名称用于证明已退役 | 不把历史名称命中当作实现残留 |
| `strategy.param` reducer、前端 `isPartialSuccess`、后端 `is_partial_success` | 没有产品直接消费者，但仍有具体测试引用；前次 CS-05 已明确保留 | 若退役，须独立迁移兼容/测试用途，不能在保持现有测试不变的简化任务中直接删除 |
| `sec_funds.fund_identity/ncen_etf_identity/nport_xml` | 只有 ETF fixture/边界测试调用，尚未接入运行供应商 | 属于 Task135 的未完成能力，保留，不能用删除代码关闭功能缺口 |
| Pydantic validators/serializers、FastAPI 路由、HTMLParser 的 handle_* | 由框架或解析器调用，无普通函数引用不代表无消费者 | 保留运行/序列化/解析语义 |
| `csv_field_groups` | 前端生成脚本通过 Python 子进程读取 | 是生成 CSV 列契约的有效入口 |
| 两个 domain 描述性类型别名 | 被 domain.__init__ 显式公开；仓库内无进一步运行引用 | 公开接口退役需另行确认，不在本轮删除 |
| `.chart-trade-marker-sell`、`.is-true`、三种 `.severity-*` | 被模板字符串动态组成，是简单选择器引用扫描的假阳性 | 保留；检查样式不能只搜索完整类名字符串 |

注册表的 1,082 行主要是字段定义，domain/contracts 的 1,319 行还包括契约与冻结/兼容校验；长度不等于应拆掉唯一注册点。账本 run_strategy 的顺序直接表达交易阶段，现有纯 simulation 入口、信号缓存/三态缺失、SEC 公开时点和双价格检查均有领域用途。本轮不建议为减少行数拆散这些约束。

## 建议执行顺序与验收

1. **局部共通化**：CS52-01 → CS52-02 → CS52-03，每项单独实现、验证和提交；先保存精确输出和错误基线。
2. **基准编排**：CS52-04，验证两个基准的顺序、阶段、取消和局部失败。
3. **搜索契约**：CS52-07，先锁定首次错误和 Schema，再机械提取私有校验；不和搜索算法改动混在一起。
4. **界面职责**：CS52-06 → CS52-08，先纯数据投影，再控件搬移；多选/图例/交易归属与弹窗行为各自验收。
5. **运行生命周期**：CS52-05 放在最后，使用前面已清晰的边界，分别验证新提交、重连、停止、导入和迟到响应。

以上是建议，尚未作为已执行重构勾选。实施时不修改既有测试断言来适应重构；缺失边界先补行为基线。单个改动超过 500 行时使用可审阅的机械搬移/AST 工具。每个切片执行相关单测、类型/lint/build及适用浏览器检查，最后执行完整前后端和真实 Yahoo 默认链路门禁。比较输出、错误、身份、取消及副作用顺序，不能仅以行数下降验收。

## 本轮实际检查

| 命令/检查 | 结果 |
| --- | --- |
| Python/TypeScript AST 文件、长函数、分支和重复主体扫描 | 完成；协议空方法及声明性元数据已剔除出删除候选 |
| 全仓应用/测试/生成脚本引用与动态调用核对、重点 Git log/blame | 完成；上表假阳性均找到消费者或框架入口 |
| `cd frontend && node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --noUnusedLocals --noUnusedParameters` | 通过 |
| `cd frontend && npm run lint` | 通过，零警告 |
| `cd backend && .venv/bin/ruff check app` | 通过 |
| `cd backend && .venv/bin/mypy app` | 通过，82 个源文件无问题 |
| `git diff --check` | 报告及任务记录通过 |

本轮没有运行单元测试、真实供应商回归、构建或浏览器 E2E；应用源码未改。[上一轮严格验收](20261005-strict-acceptance-audit.md)的 745/305/160/1 是已有实现的历史证据，不代表这些建议已实施或通过验收。ETF Task135、可选 Inspector、远端 CI/发布和旧 RV 原稿追溯继续按原任务状态记录。本轮未操作服务、私人结果数据库、SEC 联系配置或远端 Git。
