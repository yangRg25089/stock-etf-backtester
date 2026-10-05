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
