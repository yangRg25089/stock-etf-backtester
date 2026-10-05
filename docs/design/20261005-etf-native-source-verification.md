# ETF 原生来源复核与解析修复

Task135 的独立切片，2026-10-05，基线 `main / dbfe919`。本切片关闭原生发行人类别的解析缺口；**完整 ETF 历史 PE 仍未完成**。不把归一化成功、准确不支持或个股正向验收视作 ETF 正向验收。

## 官方来源复核

- 官方基金代码表与 submissions 已实际读取：QQQ、SOXQ、SMH、VOO 均能定位当前 CIK/series/class，但一个信托的近期申报可以属于其他 series，不能直接取首条 N-PORT。当前代码表也不能证明过去的身份。
- QQQ 报告期 2026-06-30 的 [SEC 申报索引](https://www.sec.gov/Archives/edgar/data/1067839/000106783926000030/0001067839-26-000030-index.htm)确认 accession、报告日、申报日和系列/类别；submissions 给出的接受时间为 `2026-08-28T13:26:52Z`，不用索引页面无时区的时钟字符串自行推断。
- 该申报的[原生 XML](https://www.sec.gov/Archives/edgar/data/1067839/000106783926000030/primary_doc.xml)有105条持仓，包含衍生品和基金持仓。发行人“其他”通过 `issuerConditional issuerCat="OTHER"` 表达，原解析器只接受 `issuerCat` 文本，因而错误地报字段缺失。
- 报告期2026-03-31的原生申报也有同一条件字段；2024-09-30的历史原文没有当前series/class字段，不能用当前身份回填。最近读取的 N-CEN 没有当前解析器要求的 management/ETF 记录，当前注册证据仍未获确认；不据此猜测基金类型或转换日期。

[SEC 表单 C.4](https://www.sec.gov/files/formn-port.pdf)要求分别报告资产及发行人类别，“其他”附说明。字段读取成功不会把“其他”改成公司股票，也不会忽略衍生品或需要穿透的基金。

## 失败证据与最小修复

1. 实际 SEC 回归先失败于 `_text(..., "issuerCat")`；固定回归另发现同时存在直接/条件字段时，原实现静默忽略条件字段。25项固定测试中2项失败、23项通过，真实回归1项失败。
2. `_issuer_category` 只接受唯一直接字段，或唯一 `issuerConditional issuerCat="OTHER"`。缺失、重复、冲突、空属性及错误条件类别拒绝。`OTHER` 继续由同一 `SecNportAdapter` 规范化为 `unknown:other`。
3. 未改 XML 实体/大小/命名空间防护、基金资格、严格缺失、覆盖率、公开时间、有符号 EPS、股价基准、运行供应商或金融计算。没有新依赖、旁路估值算法或吞异常处理。

## 验证与复审

| 检查 | 结果 |
| --- | --- |
| 原生字段与身份 fixture | 25 passed，原18项保留，新增7项合法/缺失/冲突边界 |
| 官方 SEC 真实归一回归 | 1 passed（0.95秒）；105条持仓全部权重/CUSIP及公开时间核对，无skip/模拟来源 |
| 完整后端 `python -m pytest` | 778 passed（63.86秒），46条既有yfinance提示；个股/QQQ/VIX/复杂策略/搜索/Walk-forward门禁保留 |
| Ruff check / format / mypy | 全部通过，150文件格式及82源文件类型检查 |
| 独立只读五轴与简化复审 | 未发现确认的Critical/Required问题；审查未代替真实运行验证 |

日志：`/tmp/backtester-task135-native-{red,live-red,live-green}.log`、`/tmp/backtester-task135-backend-full.log`、`/tmp/backtester-task135-native-probe.log`。公开原文探查副本在临时目录，私人请求配置未打印/提交/上传；用户服务及私人数据库未操作。前端未改，阶段53的317单测/161浏览器/1真实生产和类型/lint/build继续适用；生成契约另核对无差异。

## 未完成条件

Task135仍需历史基金注册/证券映射、有符号每股盈利与匹配股价接入普通/搜索运行，并完成正向ETF独立估值、保存与导出验算。基金现金管理持仓规则沿用待答复的问题；当前规则下不静默豁免基金或衍生品。远端操作仍等待已发出的指定目标/secret发布确认，可选Inspector仍按原文暂缓。本切片不能关闭这些任务。
