# 绩效体验与代码简化实施

基线：main / ba554a0，开始时工作树干净。用户批准实施20261005审计的8项建议，并新增3项绩效体验修复；旧ETF/远端/原稿缺口继续各自原任务。原始新增功能稿和两份此前原始审计保持字节不变。

## Task191：绩效显示

- 复现：热图可见详情直接使用formatExactPercent，真实保存值显示为`2024-02 · 4.9504950495049504950495049%`。新单测、浏览器先失败。整卡提示测试先修正缺analysis的测试前提，再确认实际失败于卡片没有title。
- 实现：可见详情/ARIA使用formatPercent最多两位；完整Decimal和日期留在title。11个绩效指标整卡有双语说明，键盘通过ARIA描述读取；基准行说明保存NAV口径、利率和年化日数。月度表复用TableExpandButton，仅解除/恢复高度，宽度/数据不变，忙碌禁用。
- 验证：前端307 passed；typecheck/lint/build通过，132模块。绩效、分期和原型8项浏览器通过，含双语320/768/1024/1440px和完整axe。第一次axe发现隐藏描述不能作为dl内div的直接span子元素，已放在分组外；旧数值dd断言不变。
- 原型旧精确可见值断言按本次用户要求更新为短显示，同时新增完整title断言；8项纯重构不能改变旧断言。
- 日志：`/tmp/backtester-phase53-ui-red-valid.log`、`/tmp/backtester-phase53-ui-browser-red.log`、`/tmp/backtester-phase53-ui-unit-reviewed.log`、`/tmp/backtester-phase53-ui-browser-final.log`及`/tmp/backtester-phase53-ui-{types,lint,build}.log`。实际复看绩效中文截图。

## 基线真实数据

沙箱内后端696通过/49失败，日志明确Yahoo DNS不可达。正常审批联网复跑745 passed（62.37秒，46条既有yfinance弃用提示）；没有skip或修改断言。日志`/tmp/backtester-phase53-baseline-backend-network.log`。

## 8项实施进度

Task192–199按局部格式化、HTTP、CSV、基准、搜索校验、结果投影、列表控件、生命周期顺序实施；完成证据逐项追加，完整集成归Task200。

### Task192 / CS52-01

新增纯expandDecimalDigits只插入小数点/补零；formatExactPercent和fixedDecimal分别保留原有输入、符号、去零、指数及数值列政策。输入字段shiftDecimal和读取边界decimalIdentity不改。新增前后零/符号/科学指数4096边界基线先通过，重构后308前端、type/lint/build通过；后端生成fixture的四类离线CSV、科学记数身份及精确百分数旧断言未改。日志`/tmp/backtester-phase53-decimal-baseline.log`及`/tmp/backtester-task192-{unit,types,lint,build}.log`。差异/调用及简化复审通过。

### Task193 / CS52-02

私有isResponseForContract使用switch替代嵌套三元式，分派顺序与校验语义不变；共享ResponseContract只用于该HTTP边界。请求URL身份、safe错误与SSE读取不改。308前端、type/lint/build以及phase51两项实际异候选/币种拒绝和重试浏览器通过，旧断言不变。日志`/tmp/backtester-task193-{unit,types,lint,build,browser}.log`；差异与调用复审通过。

### Task194 / CS52-03

flattenSavedMetrics按原metrics→analysis→tradingCosts覆盖顺序展平；searchCandidateCsvRow明确窗口/训练测试/样本外字段，prefixedMetrics只使用生成列。每候选测试指标一次构造，样本外指标仍在循环外构造。csvValue与JSON递归改显式分支，编码/键序/换行/数值列不变。308前端（含普通/分段/滚动后端fixture逐字符CSV对照）、type/lint/build及离线四CSV/PNG浏览器通过；旧断言未改。日志`/tmp/backtester-task194-{unit,types,lint,build,browser}.log`；差异/共通化复审通过。

### Task195 / CS52-04

按既有_BENCHMARKS(DCA→一次投入)循环，各次check_cancelled→set_current→run_benchmark→complete不变，RunCancelled继续外抛；其他异常保持局部failed与原stage/preset值。无reference_load分支及内核不改。新增定投/一次投入/同时异常3种基线，先43 passed，重构后运行/CSV/搜索87 passed；Ruff/148格式/mypy82通过，旧断言未改。新增测试插入时一度误移动相邻幂等断言，已原位恢复后重新建立绿色基线；最终diff只新增测试。日志`/tmp/backtester-task195-baseline-valid.log`及`/tmp/backtester-task195-{unit,ruff,format,types}.log`；差异/异常/取消/顺序复审通过。

### Task196 / CS52-07

先建立22项基线：20个首次关系错误、共同身份错误先于数量错误的Pydantic根路径、三种模式保存JSON往返。测试前提修正了先命中全局窗口排名检查的构造，以及Decimal参数JSON往返不能按Python对象类型比较的问题；原算法不改。AST机械提取walk_forward/train_test/full_period三个私有校验，校验主体/条件逐节点等价；共同身份及跨模式rolling检查仍留原validator，错误顺序、文案、路径不变。

重构后151项领域/搜索/运行/导出、308前端通过，Ruff/149格式/mypy82通过；79模式生成及三份契约字节无差异。旧断言未改。日志`/tmp/backtester-task196-baseline-valid.log`及`/tmp/backtester-task196-{unit,front,ruff,format,types,generated}.log`；机械基线留`/tmp/backtester-task196-contracts-before.py`。差异/契约/错误优先级复审通过。

### Task197 / CS52-06

纯buildResultSelection投影主曲线/比较线、同期间基准、颜色/排名、技术和波动率、成交归属；savedPeriodBenchmarks每次只调用一次，preset映射保留首次匹配。原始结果/显示基准明确分离，不重赋result。候选fetch、AbortController、错误、说明dialog及界面状态仍在ResultViewer；价格显隐不加入投影状态。输入兼容原有null/undefined。

新增3项纯投影检查覆盖普通/分段/滚动后端保存fixture的全部候选、同期间基准、颜色/排序/成交引用、零选择保留价格与输入不变；既有SSR及所有行为断言未改。311前端、type/lint/build与5项多选交易点/排名读数/快速图例/交易解释/Walk-forward离线浏览器通过。日志`/tmp/backtester-task197-{unit,browser,lint}.log`、`/tmp/backtester-task197-types-final.log`与`/tmp/backtester-task197-build-final.log`；差异、身份、状态独立与简化复审通过。

### Task198 / CS52-08

同一共享字段模块的私有NumberListControl仅承接列表输入及增删，原inputValue、describedBy、catalog单位/边界/空值政策和prop覆盖顺序保持；其他控件分支不动。公共ParameterField契约不变，没有再建一份参数元数据。

新增2项行为基线先通过，覆盖数字/空白输入、回调和输入不变、逐项单位/ARIA、禁用、nullable和至少一项；重构后313项前端、type/lint/build及3项原生数字校验/网格值与CSV/所有策略三大块dialog浏览器通过，旧断言未改。首次静态检查发现单位必须允许null，已按原unitLabel契约修正，没有转换原值。日志`/tmp/backtester-task198-baseline.log`、`/tmp/backtester-task198-{unit,types,lint,build}-final.log`及`/tmp/backtester-task198-browser.log`。DOM/事件/可访问性及简化差异复审通过。

### Task199 / CS52-05

observeRun共通SSE订阅→单次保存结果读取；恢复入口仍在订阅结束与GET之间检查submittedRunRef，迟到结果应用仍由原入口保护。useDraftValidation只承接确认草稿的300ms校验/取消/错误归属和重试，失败重试判断仍保留旧状态而不错误作用于新草稿；validationDiagnostics从原入口重导出，App公共消费不变。runErrors共用既有错误归一。

原恢复/卸载/预校验effect注册顺序保留，提交与恢复的finally保护不合并；停止重试、提交锁、记忆冻结配置、导入/reset身份及费用/CSV不动。新增4项生命周期基线先317 passed；首个新测试纠正了fetch省略method仍是GET的前提，没有改请求代码。重构后317前端、type/lint/build（137模块）、20项原迟到停止/重试/早期停止/SSE/文件离线/刷新重跑/草稿隔离浏览器通过，旧断言不变。

日志`/tmp/backtester-task199-baseline-valid.log`及`/tmp/backtester-task199-{unit,types,lint,build,browser}.log`。对原控制器逐段核对锁/AbortController/草稿身份/响应顺序/错误语义，五轴与简化复审通过。继续Task200完整真实门禁与稳定化。

### Task200：完整集成完成

当前完整后端770 passed（275.21秒，46条既有yfinance弃用提示）、前端317 passed；Ruff/149文件格式/mypy82、type/lint/build、额外TypeScript unused检查和79模式生成通过，三份生成契约字节不变。真实生产QQQ/VIX三次刷新重跑及冻结CSV 1 passed（55.1秒），仅使用独立8124/5175服务。

首次全量浏览器160通过/1失败（12.2分钟）。失败仅是phase40旧用例过早在首次预校验pending时捕获按钮HTML，确认新草稿的合法预校验使disabled属性被移除/重新附加，属性顺序改变但值完全相同。新增等待首次及确认后校验完成的前提，原按钮、旧结果、利率、数值及完整axe断言一条未删；两个绩效用例随后通过（12.3秒）。最终统一全量161 passed（6.0分钟），不把首次失败隐藏为全绿。

独立模型只读五轴审查覆盖ba554a0..e000bf7的全部源码/测试/设计差异，未发现确认的Critical/Required问题或结构回归；未替代实际运行验证。没有扩散重构、改变费用/本金/成交/CSV规则或读取个人运行数据库。

最终检查覆盖日中双语、320–1920px、原生缩放、绩效短显示/整卡说明/月热图高度、所有策略dialog、多选/颜色/交易身份、候选及滚动窗口、离线四CSV/PNG、确认草稿预校验、停止/重连/迟到响应与真实默认刷新重跑。实际复看绩效中文及窄屏截图；8项审计建议和3项新增指摘均已对应，未发现新的确认缺陷。原始新增功能文档、原简化审计和阶段35原稿字节不变，agent配置不被Git跟踪。

完整日志：`/tmp/backtester-task200-backend.log`、`/tmp/backtester-task200-front.log`、`/tmp/backtester-task200-browser-final.log`、`/tmp/backtester-task200-live.log`，以及`/tmp/backtester-task200-{types,lint,build}.log`。79模式生成无差异、`git diff --check`通过；本地代码与验收记录按切片提交。旧RV原稿追溯已由Task189独立关闭；ETF Task135、远端CI/发布/分支收敛和暂缓Inspector仍未完成，Task200通过不等于全项目完成。
