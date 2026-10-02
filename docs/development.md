# 开发与排障

## 当前运行边界

这是本机历史模拟应用。前端只消费 FastAPI 契约；`catalog` 和 `config` 提供目录与验证，`data` 负责供应商适配、规范化和快照，`signals`、`ledger`、`metrics` 与 `search` 负责计算，`runs` 冻结配置并协调独立结果，`export` 只从保存的结果快照导出。

应用启动不访问外部网络。纯计算确定性测试使用固定数据；后端的默认 Yahoo provider 回归测试会实际请求 Yahoo 和交易所日历，覆盖 QQQ 与 `^VIX`、`^VXN`、`^VXD`，另验收 QQQ/USD 和 7203.T/JPY 真实报价币种。用户提交回测后，默认 API provider 调用 Yahoo 获取标的日线及启用条件所需的指数/利率序列；数据先经过现有适配器规范化，再进入快照和回测。共通弹窗选择目录以外的代码时，通过 `/api/v1/instruments/{symbol}` 读取供应商元数据确认币种；不推测币种或做汇率换算。当前交易所日历映射覆盖美国 NASDAQ、NYSE、AMEX/ARCA 与 OTC 常用代码；未知交易所会返回未支持诊断。Yahoo 请求失败会返回限流、超时或请求错误诊断。浏览器 E2E 使用仓库 fixture provider，`live smoke` 是独立的只读连通性检查。

已提交的 `RunSnapshot.dataProvenance` 冻结来源列表、日历截止日和行情最新报价日。汇总、每日资产、交易、搜索结果四类 CSV 都从这个保存快照附带 `dataSources`、`calendarAsOf`、`marketDataThrough`，导出不读取当前草稿或重新请求数据。`marketDataThrough` 表示行情报价覆盖，不代表宏观或 SEC 数据也更新到该日；这些数据的观察日/公开时间保留在数据快照和诊断中。运行完成日志以结构化字段记录相同来源与日期，不输出配置值或供应商响应。

运行记录由本机 SQLite `RunStore` 保存，默认路径为仓库根目录 `.local/runs.sqlite3`，该目录已加入 Git 忽略规则。可通过 `STOCK_ETF_BACKTESTER_RUN_STORE_PATH` 指定另一文件路径。运行响应、冻结快照和幂等键均持久化；SQLite 私有版本化编码保留冻结参数中的 `Decimal` 类型，旧格式记录依照对应 catalog 参数类型恢复，API 快照 JSON 仍以十进制字符串对外。页面启动时读取最近一次已保存运行；未完成作业经单条 `/api/v1/runs/{runId}/events` SSE 连接恢复进度，结束后只读取一次完整结果。断开页面订阅不会终止服务端运行。服务重启时，仍处于 `queued/loading/running` 的策略会转成带 `runs.interrupted_by_restart` 诊断的 `failed`，已经结束的策略和部分结果保留。

结束日期框默认本机今天，提交快照保留所选日期。实际计算使用该日之前的完整交易日；今天尚未收盘、周末或暂未发布的尾部行情静默截到最后有效报价日，实际截止日记录在 `marketDataThrough`。显式选择未来结束日仍提示已调整日期；没有有效交易日或必需数据时返回错误。有效区间单个孤立缺失日从共享日历中跳过，不造价，连续缺失两日及以上返回不可用诊断。所有静态日历/数据/指标诊断都有日中本地化说明，测试检查后端诊断键不直接显示。计算失败诊断包含安全阶段和运行/策略标识；异常消息、内部路径和异常类型仅写入受限服务日志或不写入，不返给前端。

停止调用 `POST /api/v1/runs/{runId}/stop`，结果为明确的 `cancelled` 终态；重复停止、结束后停止幂等，已完成策略/基准的指标和交易保留。账本逐日、搜索逐候选协作检查停止信号，锁保护进度和结果，迟到的计算不会覆盖停止终态。正在发送的供应商 HTTP 请求使用自身超时，不能被计算停止立即中断；提交尚未取得 runId 时，前端记住停止意图，在作业接受后立即发送停止。比较表实时显示等待图标、执行 spinner 和已完成指标；SSE 推送轻量完成摘要，最终只 GET 一次完整结果。

搜索版本 `search-v2` 将候选完整结果保存在同一 RunStore；SQLite 的 `candidate_results` 保存压缩 JSON，主运行只包含排名摘要和最佳候选曲线。`GET /api/v1/runs/{runId}/candidates/{candidateId}` 按需读取保存曲线，重启后仍可查看；相同计算复用但候选身份独立。旧记录没有保存曲线时显示结果缺失诊断，保留原曲线并允许重试，不误报网络错误。候选的汇总/每日资产/交易 CSV 使用候选 ID，搜索 CSV 使用父搜索结果；所有读取与下载均不重算、不读当前草稿。

备份时优先使用 SQLite 在线备份接口，例如：

```python
import sqlite3

with sqlite3.connect(".local/runs.sqlite3") as source:
    with sqlite3.connect("runs-backup.sqlite3") as backup:
        source.backup(backup)
```

清除全部运行历史前停止 API 服务，再删除 `.local/runs.sqlite3` 及其 SQLite `-wal`、`-shm` 辅助文件；下次启动会创建空数据库。规范化数据缓存仍只在进程内，最多保留 128 个结果，不保存供应商响应；成功且无错误诊断的快照才会缓存，`refresh=True` 会绕过现有项，自动识别单位的利率不走缓存。缓存键包含供应商、代码、日期、频率、版本、价格口径和上下文指纹，服务重启后缓存会清空。

## 工作台结果与交互

独立运行条/状态面板已在全部生命周期删除；顶栏为播放/重置及执行中的停止图标，真实诊断归入结果详情；比较表不显示角色/状态列，机器契约与 CSV 保留。配置 dialog 各持本地编辑缓冲，合法关闭时一次提交；错误和未完成校验阻止完成、关闭、Escape、背景退出。编辑不改变背景运行按钮、保存结果或诊断；播放时才校验执行草稿。播放运行全部已添加策略及两个自动基准。比较表点击选中，再点释放，键盘按钮保持原生语义。重置仅清空当前显示及错误，客户端记住被清空的 runId，刷新不再恢复同一条记录，不删除 SQLite 数据。新提交的结果可恢复。

前端已删除运行范围状态、reducer 分支、当前策略校验分支和专用文案；catalog-v10 不再注册 `run.scope`。播放明确提交 `all_enabled` 且不发送当前编辑身份，局部策略错误由保存结果表达，不能阻断其他策略。后端的历史/API 范围字段继续兼容旧请求，Notebook 模式仅映射预设身份。

策略比较选中行按身份颜色加深背景、描边与阴影，并上浮 1px；160ms 过渡，取消后恢复。绘制位移独立于行布局和排名动画，列宽/滚动位置保持稳定；支持多选/键盘，减少动态效果时无过渡。

条件关闭只收起正文，不豁免参数校验；收起的根、叶及嵌套组显示带字段名的错误摘要，并恢复可见焦点。窄屏切换通过内容尺寸观察保留当前错误焦点位置，观察器随校验状态清理。波动率和布林卖出条件的标签不固定冠名 VIX，实际指数由各条件的选择表示；买卖指数独立，不改变稳定键、交易算法或保存快照。

自定义分组入口为子条件预留节点、层级和未使用类型；该侧类型全部添加后禁用新增入口，删除后恢复，固定只买模板不显示空卖出区域。ratio 编辑器显示等值百分数，值/范围/步长共用注册元数据，通过十进制移位提交原 0–1 比例，保留非法精度供校验；percent_point 字段不变。波动率卖出指数独占一行，阈值/比例成对显示。两档波动率卖出按实际阈值从低到高检查，比例始终对应原档位；相等时保留第二档优先。信号评估版本 `signals-v1` 纳入运行 `engineVersion` 和普通/搜索计算指纹，旧保存结果仍读取原值，不重算或命中新算法缓存。默认、反向、相等和边界阈值有确定性回归，真实 Yahoo 运行核对成交比例、SQLite 恢复和交易 CSV。

每日 `totalContributed` 是累计外部注资，包含未买入现金；`actualInvested` 是注资首次用于买入的累计本金。回收资金及收益优先用于再买，不重复计入，始终满足 `0 ≤ actualInvested ≤ totalContributed`。唯一指标模块同时保存每日与汇总值，CSV 读取保存值，不累加成交或重算。新结果 `investmentBasis=original_principal`；历史累计买入成交额标记 `buy_turnover`，前端「已投入本金」显示占位，旧每日缺值留空，历史 CSV 保留原口径并附该标记。成交额仍见交易 CSV。指标版本为 `metrics-v5`、账本为 `ledger-v4`，参与普通/搜索缓存指纹。净利润、注资本金收益率、XIRR 和剔除注资的单位净值回撤口径不变。真实 QQQ 重复买卖验证本金、资产分解、SQLite 重启和每日/汇总 CSV 一致。常驻读数固定高度，多个策略在读数区内滚动，不遮挡曲线。缺累计本金的历史结果保留价格和原始导出，重新运行后获得本金收益曲线。

主图价格以首个有效价格为 100；资产曲线为 `totalAsset / totalContributed * 100`，单位净值与回撤算法保持原有定义。仅保留紧密联动图：买卖标记固定到资产累计本金收益线，VIX/回撤以半高辅助图显示自然单位，不显示辅助标题/局部图例；所有辅助绘图区等高。日期刻度和定位日期标签在独立底部轴显示，不占最后一个图的高度；共享日期窗口与十字纵线，横线属于当前图。定位读取最近保存日，缺失值显示占位。Shift+左右键查看读数，Escape 收起；普通滚轮滚动结果区，显式放大镜模式或 Ctrl/Command+滚轮缩放，拖动跟随指针。放大镜取消后即使鼠标仍悬停也显示未选中，边界开关背景始终为页面底色、悬停仅加粗图标。交易页直接显示保存交易表，无显隐状态或参数。比较表多选只控制主图曲线，焦点独立控制明细/导出；行色/曲线/读数共用颜色映射，切换焦点保留日期窗口。所有选中资产线被取消时保留价格恢复入口，失败状态不画残留资产。VIX 无常态小点，主图图例可点击锁定高亮。指标开关有勾选符号；放大镜开启有图表聚焦边框和短状态，关闭即恢复普通滚动。

目录版本为 `catalog-v10`：共享条件元数据、叶节点/嵌套分组、结构限制、固定模板、ETF 快捷选项及实例数量上限。`composite_dca` 为「自定义策略」，最多 10 个，名称使用稳定序号，删除不重排；其他固定类型各一个。同一侧买/卖树中条件种类不能重复。所有择时策略的月度买入上限置顶，MA 买卖/只买默认不限且不提供现金安全阀；条件与金额单位共享组件和真实报价币种。PE 阈值最小值与输入步长同为 0.000001，默认 25 不触发原生 stepMismatch；VIX 预设名为「波动率信号定投」，可选择 VIX/VXN/VXD。实例添加即运行，无启停 UI；买卖条件开关独立保留。固定模板只改参数，搜索也消费同一树。候选值在弹窗内编辑，列表元数据沿用普通字段的单位/边界，catalog 绑定值列表注册键；只有所选维度参与枚举，提交冻结列表及结果维度，恢复、候选曲线和 CSV 不重算。条件字段引用唯一 ParameterDefinition，SQLite 保留叶节点中的 Decimal。原七个稳定 ID 保留；旧平面请求在配置边界物化为同一树。数字字段编辑后仍以数值提交；局部无效策略快照也保存完整条件树用于复现。带类型标记的 SQLite 快照按原存储格式恢复；未带类型标记的 v4/v5 记录仍按注册表恢复十进制参数，保留旧快照版本，不修改已保存结果。

新 runId 重置结果焦点/多选至首个提交策略、默认指标显隐、排序、候选、日期窗口、游标、图例锁定和滚轮模式；同一 runId 的进度/结果更新保留当前偏好。运行中锁定设置入口、策略增删/编辑和结果选择/排序/搜索/图表操作，停止仍可用，进度与指标继续更新。

比较表默认按注资本金收益率降序，已完成指标逐条排到稳定待执行队列前；全部九列支持升降序，空值固定置后、并列按原身份顺序。排序只变显示顺序，颜色固定绑定原策略身份，调色板覆盖当前所有允许实例及基准且读数颜色满足白底 4.5:1。短位移动画读取布局坐标而非动画坐标，遵守减少动态效果偏好。选中策略卡保留悬停深色底，焦点和当前项语义可读。资产图例/读数使用具体策略名；波动率来源从所有已选保存策略聚合，切换明细不隐藏其他策略的指数，不同指数按自然单位分别显示，冲突阈值不画公共阈值线。SVG 坐标和游标字号按实际绘图区宽度补偿，在原生浏览器 100%/125%/150% 缩放中与普通文本同比放大。零净收益且可解的 XIRR 精确返回 0，避免极小求根残差显示成 -0%。

## 环境与常用命令

Python 需为 3.11（3.11 以上、3.13 以下），Node.js 需为 22 以上，npm 需为 12 以上。

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
python -m pytest -o addopts='' -q
ruff check .
ruff format --check .
mypy app
```

前端检查：

```bash
cd frontend
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

E2E 包含隔离 Chromium 临时 profile 的原生 `tabs.setZoom/getZoom` 100%/125%/150% 检查，不读取或修改个人 Chrome。E2E 会自行启动本机 fixture API 和 Vite 临时进程，结束后应释放端口。不要把 E2E 临时服务当作平时启动的 API。

后端全量 `pytest` 包含 `tests/runs/test_yahoo_data_live.py`，需要外网访问 Yahoo 和 Yahoo Finance 的交易所元数据。该回归检查真实 QQQ 和所选波动率指数的日期、来源、信号可用状态及完整 API 运行结果，不断言实时行情数值；网络或 Yahoo 服务不可用时全量 pytest 会失败。纯账本、信号边界和 fixture API 测试仍保持确定性。

## 显式 live smoke

后端标准安装已包含 Yahoo 与交易所日历依赖。运行 API 前在后端虚拟环境安装/更新项目依赖：

```bash
cd backend
.venv/bin/python -m pip install -e '.[dev]'
```

提交回测时联网获取 Yahoo 行情；若只需要单独检查连通性，也可执行显式 live smoke：

```bash
cd backend
.venv/bin/python -m app.data.smoke --source yahoo --symbol QQQ \
  --start-date 2024-01-01 --end-date 2024-01-31 --live
```

命令会打印 JSON，字段包括检查时刻 `asOf`、来源 `source`、数据截至日期 `dataThrough`、覆盖率 `coverage`、状态和 `failureReasons`。退出码 `0` 表示完整，`1` 表示部分数据或供应商失败，`2` 表示未显式启用或本地参数/配置不满足。Yahoo 覆盖率按工作日估算，不含交易所节假日；节假日可能被报告为缺失交易日。smoke 使用单次请求和 10 秒默认超时，可用 `--timeout-seconds` 修改；yfinance 固定版本为 1.7.0。

SEC CompanyFacts 需要 CIK 和你提供的联系标识：

```bash
cd backend
SEC_USER_AGENT='Stock ETF Backtester contact@example.com' \
  .venv/bin/python -m app.data.smoke --source sec --symbol AAPL \
  --cik 0000320193 --live
```

没有 `SEC_USER_AGENT` 时命令会在发出请求前安全失败。检查只请求 SEC 官方 CompanyFacts JSON 地址一次；报告、日志和诊断不会包含 User-Agent、响应正文或请求 URL。SEC 要求使用可识别的 User-Agent，并要求遵守 fair-access 速率限制；这个单次 smoke 不会自动重试。

关闭 `--live` 时 smoke 命令不会调用供应商。provider 的超时、限流、缺少配置和脱敏边界通过 fake provider/HTTP opener 精确检查；另有真实 Yahoo API 回归保证默认 QQQ/VIX 数据链实际可用。回测本身在用户按下运行后会访问 Yahoo；VIX 不会前向填充。单个缺失行情日会从共享回测日历中跳过且不造价，连续缺失两日及以上仍作为行情不可用处理。

## Fixture 更新流程

固定数据放在 `backend/app/data/fixtures/`；当前核心 bundle 为 `task4_core.json`，notebook 来源与字段映射见 [`fixtures/notebook-mapping.md`](fixtures/notebook-mapping.md) 和同目录 JSON manifest。fixture loader 计算规范化快照指纹，运行结果会冻结该指纹。

更新 fixture 时：

1. 先确定测试要保护的领域规则和固定日期范围；live smoke 的结果不能直接成为测试期望值。
2. 只保存最小、可复核的 fixture 内容及来源/日期/版本说明，不提交认证信息或无关的供应商响应字段。
3. 保持原始公开/观测时间、币种、单位、价格口径和缺失状态；不要用前向填充、零值或当前 ETF 持仓补历史缺口。
4. 为新增/改变的场景加确定性测试，验证规范化结果和诊断；需要时同步更新 notebook manifest 与此文档。
5. 运行后端 pytest、Ruff、mypy 和前端契约/类型检查，复核 fixture diff 与 `git diff --check`。

目前没有 live 数据转 fixture 的自动导入器；导入和清理由维护者审阅完成。

## PE 与公开数据的已知限制

- SEC CompanyFacts 适合读取标准化 XBRL 事实，但不能单独证明每股 EPS 的拆股基准、准确上市类别和实际盘中公开时刻。没有可核验的时点/口径时，依赖 PE 的日期保持不可用。
- SEC N-PORT 是申报快照，不是逐日 ETF 持仓；ETF PE 是基于历史直接股票持仓的估算，并受申报滞后、发行人识别、EPS 和估值价格匹配及最低覆盖率影响，不代表基金公布的原生 PE。
- 免费来源无法保证所有标的和历史日期均有可用估值。个股非正 EPS、过期/未公开事实、价格口径或币种不一致都会导致 PE 不可用。
- CompanyFacts 和 N-PORT 解析适配器当前接收已取得的数据，不承担 HTTP 获取；SEC live smoke 只验证 CompanyFacts 读取和 EPS 规范化覆盖，不验证完整 PE 或 ETF 持仓估值链路。
- Yahoo 行情/指数/利率已接入回测运行；PE 仍依赖 SEC CompanyFacts/N-PORT 的获取、标识和公开时间链路，目前未接入普通回测 provider。启用 PE 的策略会显示专门的数据不可用诊断，其他策略照常运行。

官方参考：[SEC EDGAR API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)、[SEC Developer Resources / fair access](https://www.sec.gov/about/developer-resources)、[SEC N-PORT 数据集](https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets)、[yfinance 1.7.0 history 实现与 timeout 参数](https://github.com/ranaroussi/yfinance/blob/1.7.0/yfinance/scrapers/history.py)。

## 本机日志与 V1 范围

Yahoo 失败诊断区分通用请求失败、超时和限流，并只记录异常类型等有限元数据。缓存日志只记录命中、未命中、刷新/绕过及 provider 名称；运行日志记录运行/策略 ID、状态、诊断码以及 `data_sources`、`calendar_as_of`、`market_data_through`。不记录配置金额、原始响应、异常消息或环境变量。后端还会通过稳定的 `messageKey` 返回可读诊断，由日中词典显示。

V1 不连接券商或提交真实订单，不提供投资建议，不做公网部署、账户/云端同步或跨进程并发保证；运行结果保存在本机数据库，规范化数据缓存只在进程内。live smoke 只做显式的只读数据检查。
