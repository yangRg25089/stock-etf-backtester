# 全项目严格验收复审（2026-10-05）

## 结论

**全项目尚未全部完成。** 已实现能力重新验收，并确认、修复两处中等接口边界缺陷、一处过期说明及一处历史断链；ETF历史PE的正向接入、最新版本远端CI/发布和远端分支收敛仍未完成。原文明确低优先级的桌面Inspector维持暂缓。随后Task189已恢复并逐条核对两份旧RV原稿；阶段53已完成3项绩效修复、8项简化及770/317/161/1完整门禁，详见[实施与最终验收](phase53-simplification-implementation.md)。本记录下方的745/305/160/1保留为首次严格审计的历史证据。

本轮从干净的本地`main / 83778df`开始。核对任务、原始新增功能设计、当前规则、实际入口、完整门禁和差分，不用旧验收数字代表当前版本，也不把准确的unavailable结果计为正向计算通过。按stabilization-loop发现问题，再经loop-engineering的失败回归、最小修复、浏览器复验和差异审查。

## 确认的缺陷

### B51-01：响应结构合法，但身份不属于请求（中）

- `fetchRun`、`stopRun`、`fetchCandidate`、`fetchBacktestPackage`原来只验证响应内部结构/身份一致，未绑定URL请求的runId/candidateId。
- 用后端实际序列化回测包建立4条失败回归，修复前均报告`Missing expected rejection`。浏览器先选候选1，再请求候选2并返回候选1的合法结果，确认错误响应被接纳。
- 浏览器故障注入必须断言实际命中一次请求；候选ID包含冒号，匹配URL须使用其编码形式。最初未编码的拦截未命中，不能作为有效复现；已纠正并重新取得修复前失败证据。
- 统一API身份校验后拒绝异身份响应，沿用`invalid_response`。浏览器确认错误显示、原候选和曲线保持、正确重试恢复、CSV包含新候选ID且不包含旧候选ID，无页面异常。
- 不修改交易、指标、供应商、生成契约或保存结果。

### B51-02：标的元数据可写入另一标的的币种（中）

- 请求QQQ时，合法的`symbol=7203.T / currency=JPY`响应原来被接纳，共通设置弹窗可关闭并误写草稿币种。
- 新失败单测及实际命中的浏览器故障注入确认；这类错误是响应归属问题，不是行情不可用或计算失败。
- 复用同一身份校验，预期代码按既有后端trim/upper规则规范化；正常大小写、首尾空格继续可用。弹窗显示原API错误说明，不把解析错误统一写成连接失败。
- 修复后弹窗拒绝关闭，原摘要、币种及保存曲线保持；正确响应重试可以关闭。截图及页面异常检查均保留。

两项是主动故障注入确认的边界缺陷，未观察到正常生产服务主动返回异身份对象。修复不能用于宣称所有数据内容均已被独立验算。

### B51-03：README的SEC能力说明过期（低）

旧说明称全部SEC PE未接入，与当前个股运行入口和真实MSFT全年验收相矛盾。已明确个股已接入、ETF历史PE仍未接入及本机联系人配置要求；原始用户设计文档保持原字节。

### B51-04：历史审查链接指向缺失的原稿（低）

`review-resolutions.md`链接到不存在的`2026102_rv.md`；前/后端两份`2026102_rv*.md`在当前目录及可见Git历史均未找到。修正断链并明确不可追溯，保留既有逐项对应表；不推测原稿丢失原因、不伪造原文。Task189记录原稿追溯及逐字核对待办。本轮对原RV只能复核已保存指摘表，不能声称原文对照验收完成。

全量Markdown相对链接扫描另检出原始`2026103-code-simplification-audit.md`指向已退役的`runPersistence.ts`，属于保留的历史定位；原稿不修改，当前运行配置保存入口为`frontend/src/features/strategies/workspacePersistence.ts`。

## 需求与实际验收核对

| 范围 | 当前确认 | 证据与限制 |
| --- | --- | --- |
| 原Task98–103 / 仓库149–154 | 已实现并重新验收 | 进程内store、仅active重连、仅保存上次实际运行配置；策略/回测JSON预览、原子导入、版本/预算/候选读取；离线四类CSV和PNG。个人旧数据库未读取或清理 |
| 原104–106 / 155–157 | 已实现并重新验收 | 真正queued/202受理、loading取消、统一生命周期；只有已确认工作区参与预校验，弹窗缓冲/旧结果隔离，晚到响应不覆盖新作业 |
| 原128–130 / 158–160、142–148 | 已实现并重新验收 | App/图表/信号/供应商/弹窗职责拆分、CSS/i18n顺序保留；生成契约重建无差异，既有行为断言继续保留 |
| 原107–110 / 161–164 | 已实现并重新验收 | 交易/未执行信号解释、保存数据说明；普通、候选、旧字段、离线文件、双语/窄屏入口 |
| 原111–115 / 165–169 | 已实现并重新验收 | 现金流调整NAV的收益/风险、冻结无风险利率、年表/月热图/回撤区段；空分母明确缺失，XIRR继续使用实际现金流 |
| 原116–119 / 170–173 | 已实现并重新验收 | 佣金/滑点/价差/整股共用账本；现金、费用、首次投入本金≤注资、费用损失的NAV及CSV/解释一致 |
| 原120–123 / 174–177 | 已实现并重新验收 | Train/Test、热图/邻域、Walk-forward连续现金/持仓；真实QQQ 2015–2021、独立逐日复算、未来数据不改变过去选参、同期基准/文件/CSV/PNG |
| 原124–126 / 178–180 | 已实现并重新验收 | 自定义深复制、确认恢复默认、快捷键及输入/弹窗/忙碌隔离 |
| 追加UI / 184、历史多策略指摘 | 已实现并重新验收 | 常驻读数取代主图figcaption；多选/排序/颜色、悬停与锁定/交易点、MA/BOLL/RSI、联动轴、缩放/拖动、表格边界滚动、三块策略dialog、键盘/触屏/axe |
| 刷新格式错误 / 185、局部失败 / 186–187 | 已修复并重新验收 | 全部12模板冻结JSON往返、部分失败配置及浏览器保存/修正、真实默认QQQ/VIX三次刷新重跑、旧结果与导出保持冻结 |
| PE / 135 | **部分完成** | 个股MSFT 2024全年252交易日的SEC/Yahoo、普通/搜索、独立账本/CSV通过；ETF完整链路未完成，详见下表 |
| 原127 / 181 | **暂缓** | 可选桌面Inspector未实现，原文明确低优先级；默认dialog仍可用 |
| 原131–132 / 182–183 | **部分完成** | 本地CI配置/质量门禁及累积代码提交已完成；最新代码未在远端执行CI、发布或创建V1标签 |

## 未完成与未执行的验收

| 项目 | 现状 | 关闭条件 |
| --- | --- | --- |
| ETF历史PE正向数据链 | SEC原生N-CEN/N-PORT解析已建立；随后真实申报发现的条件发行人类别缺口已修复，25项固定及1项真实归一回归通过。实际运行仍只走company_tickers→个股CompanyFacts，基金解析没有运行消费者 | 完成历史基金/series/class身份、证券映射及公开时点持仓估值接入；真实ETF普通/搜索/导出与独立估值正向通过。现金管理基金持仓规则仍待既有答复，不能用当前持仓/PE补历史；来源及778后端门禁见[原生来源验证](20261005-etf-native-source-verification.md) |
| 最新版本远端CI | `.github/workflows/ci.yml`已配置完整后端真实来源及前端/浏览器/生产流程；SEC secret发布/可用性未完成确认和验收 | 最新提交到达目标main，并在GitHub实际跑绿；缺联系人须失败，不能skip或容错成功。本次没有GitHub CI运行证据 |
| 远端main及agent文件清理 | 本地仅main且agent配置已不跟踪；只读核实远端仍有main和两条feature，旧main仍跟踪agent文件 | 完成已指定远端写入及分支收敛，核实远端HEAD与当前main一致、agent路径无跟踪。此前自动审批拒绝仍未解除，本轮无远端写入 |
| V1发布 | 本地没有tag，最新系统未形成远端正式基线 | 完成实际CI/最终验收后再发布并核实标签；不能把本地构建等同release |
| Inspector | 未实现、明确暂缓 | 需独立实现与验收；非当前默认使用路径的故障 |
| 旧RV原稿追溯 / 189 | **随后已关闭**：首次审计未找到；Task189从本会话原始完整cat输出恢复两份读取文本，后端两次独立读取逐字节一致 | 已核对10项前端/7项UI建议/13项后端及重复建议，未漏独立指摘；原字节保存在本机，来源和完整性见[原稿追溯核对](20261005-rv-source-verification.md) |

Task102、检查点W和Task120中未勾选的远端部分，与182–183的发布条件重叠，不是另外三个已完成产品功能。Task135/181/182–183继续独立保留待办；Task189因随后取得原文证据并完成逐条核对关闭，不能以追溯完成代替ETF或远端验收。

2026-10-05只读远端核实：

| 分支 | HEAD |
| --- | --- |
| main | `4176e352478c0d2d6841af01c41ce529bd0735a9` |
| feature/remaining-v1-tasks | `c565215c0832c5365f8fc196fbb74875518e42cf` |
| feature/task-7-sec-valuation | `4748a2170ca3701fde0f59cc67c0100d5a877a1c` |

远端main仍有`AGENTS.md`、`.agents/skills/stock-task-dispatcher/SKILL.md`和三项`.pi/`文件；本地这些路径均不被Git跟踪。本轮开始时本地比origin/main多115个提交；旧两条feature均为本地main祖先，既有可恢复备份保留。本轮不自动删除未导出的个人结果或写入联系人secret。

## 本轮实际检查

| 目录 / 命令 | 结果 |
| --- | --- |
| backend / `.venv/bin/python -m pytest` | **745 passed**，46条既有yfinance弃用提示；包含真实Yahoo默认/指数/利率/上市边界、MSFT SEC正向及真实Walk-forward和独立验算 |
| backend / Ruff check、format、mypy | 全部通过，148个文件格式正确、82源文件类型检查通过 |
| frontend / `npm test` | **305 passed**，0 fail / skip；新增6项身份拒绝及规范化回归 |
| frontend / `npm run typecheck`、`npm run lint`、`npm run build` | 全部通过；132模块构建，未增加依赖或suppression |
| frontend / `npm run test:e2e` | **160 passed**，5.0分钟，最终统一回归通过；先前159项全量和新增2项专项也通过 |
| frontend / `npm run test:e2e:live` | **1 passed**，真实生产后端QQQ/VIX、三次刷新重跑及冻结CSV逐字符对照 |
| frontend / API生成与三份生成文件diff | 79模式生成，字节无差异 |
| root / `git diff --check` | 通过；提交前再次核对文档、差异及生成文件 |

浏览器覆盖日文/中文、320–1920px、原生100/125/150%缩放、所有10个可选策略dialog、active/SSE/终态一次GET、停止/迟到响应、部分失败、离线候选/CSV/PNG、联动/读数/选择、训练测试与滚动窗口。使用隔离8123/5174 fixture服务及8124/5175生产服务，不停止用户8000/5173服务。

失败证据：`/tmp/backtester-strict-identity-red.log`（4项身份拒绝失败）、`/tmp/backtester-strict-identity-browser-red-verified.log`（实际命中异候选响应）、`/tmp/backtester-strict-instrument-red.log`（币种归属拒绝失败）、`/tmp/backtester-strict-instrument-browser-red.log`（错误币种使弹窗关闭）。

修复及最终门禁：`/tmp/backtester-strict-instrument-green.log`、`/tmp/backtester-strict-instrument-browser-verified.log`、`/tmp/backtester-strict-audit-backend.log`、`/tmp/backtester-strict-audit-browser-complete.log`、`/tmp/backtester-strict-audit-live-final.log`、`/tmp/backtester-strict-audit-{type-complete,lint-complete,build-final}.log`。第一次浏览器绿色复验中的摘要对比误混innerText/textContent，已统一读取方式；保留原摘要、币种、曲线和错误断言，未修改产品规避测试。

实际复看本轮共通设置1440px、中文网格策略320px、原生150%缩放、Walk-forward以及异币种拒绝/候选恢复截图；对应目录为`.playwright-results/phase31-audit-*`、`phase27-feedback-*`、`native-zoom-*`、`phase49-walk-forward-*`和`phase51-strict-audit-*`。自动检查保留完整axe、布局/焦点/原生缩放几何及字体同比例断言；本轮没有以截图存在替代交互验收。

## 最终差异审查与边界

- 正确性：同一小型API身份校验供五个读取入口使用；读取后才返回消费者，错误不改旧快照。大小写/空格语义和取消控制器不变。
- 安全/资源：保留生成结构检查、对象/树/文件预算及安全诊断；不读取联系人内容、私人数据库，不将供应商头部/正文写入报告或Git。
- 简化：不增加第二套候选/币种状态，不复制交易算法；弹窗沿用现有错误、退出校验及重试入口。
- 范围：本轮业务变更仅HTTP身份读取和弹窗错误说明，另同步README/规范/任务/审查记录。原始新增功能及前两份审计文档字节不变。
- 最终统一浏览器、截图复看和差异复审完成；最终发现扫查没有新增未关闭的中等及以上确认缺陷，Task188仅表示本轮审计闭环。未在Safari/Firefox或实体触屏设备执行验收；没有最新远端CI/发布证据。测试通过不等于全项目无未知缺陷。
