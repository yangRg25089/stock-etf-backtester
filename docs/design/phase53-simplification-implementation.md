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
