# 单卖家推理拍卖与 Agent 任务评估规格

- 状态：方向已确认，分阶段实施中；真实付款与实验结论仍待验收。
- 日期：2026-11-14，America/New_York。
- 读者：Kelsen 与负责 Market、钱包、agent runtime 和实验的实现者。
- 对应工作：[Issue 16 拍卖机制](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/issues/16)、[Issue 15 任务与经济实验](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/issues/15)、[PR 17 固定供应比较](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/pull/17)。

本轮接受的方向是：保留固定价格比较基础，先证明 agent 使用自己的资金完成真实模型与工具任务，再加入单卖家竞价分配，最后检验竞价在什么条件下改善任务结果。首个机制目标是让合格且有资金支持的较高出价获得下一次执行机会。整体按时任务完成率、买方成本和卖方收益是否改善，由实验回答。

已确认架构约束：浏览器首版使用内存模式，不要求跨刷新恢复任务，不新增后端 agent session persistence，也不自建客户端持久化层。fx 管理当前对话，just-bash 管理当前任务的内存文件；Market 与钱包保留交易、授权及资金恢复所需的权威状态。

已确认展示方式：直接复用主交互界面，不另设 task runner 页面。后续真实链验收先用 NEAR testnet；网络选择不代表已授权本金、gas 或真实供应成本。本轮主界面受控验收见[记录](../acceptance/2026-11-14-main-workspace-client-tasks.md)。

下文给出实现合同与验收提案。第 13 节列出待 review 的参数和产品选择；本文不启用真实付款或部署，不把提案视为已经完成的能力。

## 1 范围与既有规格的关系

首版使用一个卖方、一个固定模型配置和一个窄服务类别。采用短窗口、密封出价、第一价格拍卖；卖方底价固定，买方在授权内自主报出倍率。成交后按冻结单价对实际用量结算，预付最大责任并退回差额。

保留[Agent 自主竞价与 MPP 推理整合规格](2026-11-14-agent-mpp-inference-integration.md)中的独立 agent 钱包、任务授权、MPP 推理入口、模型与工具循环及原操作恢复原则。本稿将其买方采购决策扩展为真正的跨买家分配；本稿拟选择 native NEAR 逐单预付退差，替代旧稿尚未选定的支付资产和价格合同候选，具体选择见第 13 节。跨链注资仍是独立的低频准备步骤。

任务运行采用客户端所有权：本稿不沿用 P2 服务端 session、fx journal、工具执行及 workspace 存储作为新路径的依赖。旧路径的停用与历史记录保留须在迁移中明确，不通过删除旧表完成本稿实现。

不纳入首版：多个卖方、双向拍卖、动态卖方底价、抢占已执行请求、任意异构任务的最优分配、自动充值、跨 agent 调拨资金、押金与罚没机制。首版不声称激励相容、真实报价、全局福利最优或抗 Sybil。

较高出价改变执行准入机会与等待时间，不承诺 GPU 更快地产生 token，也不改变已成交合同。

## 2 实现基线与需要补齐的能力

代码分析基线固定为 PR 17 的 `e2641db6f764af061059abe16a56794d3a021dac`。后续实施必须记录实际 base/head、Market 上游版本与本地补丁摘要。

| 部分 | 基线行为 | 本稿要求 |
| --- | --- | --- |
| Comparison runner | 固定 A 后 B，共享绝对 deadline；文本请求比较 | 均衡顺序、等量任务时间预算、独立阶段计时 |
| 完成记录 | 查询 Market head 和 receipt 后记录结束；费用和任务成功尚未填充 | 先持久化可用结果，再异步补全财务及任务验收 |
| NEAR bridge | 绑定审核过的单个请求 hash，完整响应验签后释放 | 保留请求比较；任务层逐调用绑定新的请求与授权 |
| P2 buyer policy | 根据预算、偏好和报价决定接受或等待 | 经济 bid 独立于 cap；每 agent 自主策略 |
| P2 payment | controlled 路径和钱包 fixture | 实际 native 钱包付款、gas、结算、退款和恢复 |
| P2 task runtime | fx 通过服务端 session/journal/tool 接口恢复工作区 | fx 与 just-bash 在客户端内存运行，页面生命周期内保留实例 |
| Market | 既有供给、采购、资金、执行与结算基础 | 同一权威内跨买家分配、共享容量预留和拍卖合同 |

现有注册顺序处理不能被称为 bid-ranked auction，也不假定是严格 FIFO。受控测试、历史真实供应验收与新整合构建的真实验收分别标注。

来源：[比较计划](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/blob/e2641db6f764af061059abe16a56794d3a021dac/services/inference-comparison/core.mjs)、[runner](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/blob/e2641db6f764af061059abe16a56794d3a021dac/services/inference-comparison/runner.mjs)、[NEAR bridge](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/blob/e2641db6f764af061059abe16a56794d3a021dac/services/inference-comparison/near-bridge.mjs)、[P2 authority](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/blob/e2641db6f764af061059abe16a56794d3a021dac/services/mpp-near-direct/p2/authority.mjs)。

## 3 系统职责与权威边界

| 组件 | 责任 |
| --- | --- |
| Owner 与网页 | 连接钱包、注资、授权、暂停任务、查看自己的结果 |
| Task runner | 在 agent 客户端组合 fx、工具和采购 transport，管理当前运行的逻辑调用、内存工作区与最终产物 |
| 每 agent autobidder | 在自身授权内提交、修订、撤回 bid，等待或停止 |
| MPP client 与 proxy | 认证请求，传递等待、分配、付款和结果状态，绑定原操作 |
| Market | 接受 bid，冻结轮次，分配，定价，预留资金与容量，发放执行许可 |
| 钱包执行器 | 独立校验冻结条款和授权，执行受限付款，恢复原交易 |
| 执行与结算 | 按原合同推理、保存结果、计量、结算和退款 |
| 实验记录与 UI | 从权威记录投影指标，不另建可支配余额或分配权威 |

后端不提供新 task session 的 claim、heartbeat、journal append、workspace snapshot 或 tool execution 服务。最小任务授权记录可以保存 principal、授权 ID、预算、deadline、撤销版本及已预留/已支出金额；它用于强制执行支出边界，不保存模型轮次、对话、工具状态或控制 agent 循环。客户端任务 ID 只是关联标识，不能自行创建或扩大授权。

拍卖不得在 gateway 选出 winner 后再调用普通采购接口争抢同一容量。所有可能销售同一 GPU 容量的路径必须共用同一容量权威，或在启用前明确分区且验证分区总量不超出可用资源。

Market 内部必须原子提交 allocation、内部资金责任、容量预留、冻结合同及后续操作意图。链上付款和外部 GPU 执行通过持久化操作记录与幂等 worker 推进，不属于同一个数据库原子事务。余额观测不等同于链上锁款。

现有 host 的 P2 构建通过 materialization 应用拥有者源码补丁。实施应在拥有资金和容量状态转换的模块增加窄接口，并记录来源；不得直接修改 Cargo 共享 checkout、生成目录或通过旁路 SQL 构造另一套可支配资金。[源码组装基线](https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/blob/e2641db6f764af061059abe16a56794d3a021dac/scripts/materialize-market-p2.py)

## 4 服务类别与价格合同

### 4.1 服务类别

每个不可变 `service_class_version` 至少绑定：模型 checkpoint、量化、tokenizer 和模板摘要、engine 配置摘要、输入 token 范围、输出 token 上限、允许的请求特性、基础 input/cache-input/output rates、费用版本、交付条件、容量池与资格证据。

首版建议一个窄类别、一个可同时执行的槽位。输入上下界、输出上限和真实供应容量在资格验证后冻结，不从历史样本推导任意请求均可承载。工具续轮的上下文必须落在同一受支持范围；超出时明确拒绝，不静默改模型或截断请求。

槽位代表一个受控执行准入单位，不代表吞吐率保证。多个 ask 指向同一 GPU 时引用相同 `capacity_pool_id`，不能各自创造独立可售容量。由外部流量共享的 GPU 必须隔离流量或明确将其作为实验干扰记录。

### 4.2 出价与授权

`bid_multiplier` 表示买家本次经济报价；以下限制独立执行：单调用最大费用、任务剩余额度、agent/owner 适用的共享上限、钱包可用余额、gas 额度、未结责任及未来步骤预留。提高授权上限不自动提高 bid；修改 bid 不扩大授权。

示例：三个合格买家出价 1.1、1.4、1.2 倍，且仅一个槽位可用。1.4 倍买家获胜并按自己的成交单价付费。若其共享资金不足，则记录不分配原因并继续检查下一位。

### 4.3 整数金额与结算

建议倍率分母 `M = 1_000_000`，底价倍率固定为 M。倍率和金额通过十进制整数字符串传输。基础费率单位延续 `microUSD per 1M tokens`；native NEAR 使用 yoctoNEAR，精度为 24。浏览器浮点只可用于展示。

提议采用以下固定规则，所有中间乘法执行范围检查，溢出时拒绝：

```text
effective_rate[k] = ceil(base_rate[k] * bid_multiplier / M)
service_micro = ceil(
  ((input_tokens - cached_tokens) * effective_rate[input]
   + cached_tokens * effective_rate[cache_input]
   + output_tokens * effective_rate[output]) / 1_000_000
)
total_micro = service_micro + versioned_platform_fee(service_micro)
```

只对服务 token rates 应用倍率；平台费用按其冻结的版本计算。预付款使用可信输入计量或保守输入上限、最大输出量、保守缓存假设及适用费用，保证所有合格实际用量的总价不超过预付本金。没有验证缓存计量时不得提前假定缓存折扣。

若兑换率为 `fx_nano_usd_per_near`，建议冻结成交时兑换率和来源有效期，并使用：

```text
principal_yocto = ceil(total_micro * 1_000 * 10^24 / fx_nano_usd_per_near)
refund_yocto = prepaid_principal_yocto - actual_principal_yocto
```

实际结算沿用原合同兑换率和舍入规则，不因退款时汇率变化重算。付款 gas 单独受授权约束；商户退款 gas 单独记入卖方成本。任何用量超界或不可信计量进入争议/恢复状态，不能直接补扣或把金额截断成正常结算。

`AuctionPricingContract` 必须保存确切有效单价、倍率、reserve、费用/兑换/舍入版本及最大本金。不得覆盖全局 seller offering rates 来表达某个 winner 的价格。

## 5 权威记录与客户端状态

具体 URL 与 wire schema 在实现时沿用既有版本管理，以下身份和幂等语义必须一致。

| 记录 | 必需内容 |
| --- | --- |
| AuctionBid | owner/agent/Market principal、task 和 logical_call、request hash、service class、倍率、总价 cap、授权版本、expiry、revision、服务器接受序号 |
| AuctionRound | round ID、cutoff、轮次规则与服务版本、候选修订集、供给和可用容量快照、资金资格证据、结果摘要 |
| AuctionAllocation | bid revision、round、胜出理由、冻结合同、容量与资金责任、付款期限、准入期限、原订单与执行身份 |
| PaymentOperation | 原 allocation/order、链/资产/收款人、付款人及退款目的地版本、应付本金、交易恢复标识和确认结果 |
| TaskRun 与 LogicalCall | 浏览器内存记录实验身份、当前调用关联、工具证据、产物与验收结果，引用权威授权和采购 ID；实验客户端可导出证据文件 |

前四类记录由 Market/钱包权威持久化；TaskRun 和完整 LogicalCall 状态归客户端，浏览器不要求落盘。后端只保留每次采购必要的 logical call 标识、请求绑定、授权和订单/结果恢复信息。既有原请求结果留存遵循执行恢复合同，不扩展为完整 agent 对话或工具工作区备份。

提交 bid 不收推理费。相同幂等键与相同内容返回原记录；相同键不同内容返回冲突。买方修订和撤回使用 expected revision/CAS，身份来自认证绑定而非请求体自报。

同一 logical call 同时最多有一个有效 bid 或一个未完成 allocation；修订不能生成第二次采购。`request_hash` 与 service class 在 bid 生命周期内固定，改变请求需要新的 logical call，并先处理原调用责任。

未分配时返回可恢复的 waiting 状态和原 bid ID，不签发可付款合同。分配提交后才可发出绑定该 allocation 的 MPP challenge。重复呈交付款凭证恢复原订单；凭证不能用于另一轮或另一任务。等待过程使用有上限的轮询退避或事件订阅，不能通过紧密重试产生新订单。

## 6 轮次与确定性分配

### 6.1 截止与修订顺序

服务器时钟和持久化接受序号决定 membership，客户端时间仅作诊断。每个类别同一时间只允许一个有权提交的 clearing worker，使用现有 writer fence 或等价的数据库并发控制。

bid 接受、修订、撤回与轮次冻结必须在同一可序列化边界确定先后。建议只接受在 cutoff 前完成权威接受的命令；cutoff 时刻及之后进入下一轮。不能只比较客户端时间或事务启动时间，否则会把稍后提交的修改追溯插入已经冻结的轮次。

冻结后保留完整修订引用。新修订、撤回或供给变更不得改写已提交结果；截止后的撤回可禁止未来参与，但已经分配的责任按 allocation 取消规则处理。分配前检查 bid expiry；分配后按冻结合同的付款/准入期限与任务授权执行，不用旧 bid expiry 改写成交合同。授权撤销仍必须在执行前检查，禁止绕过撤销继续消费。

### 6.2 分配算法

在权威事务中：

1. 固定本轮 rule/service/supply 版本、有效修订集与可用容量，记录资格判断所依赖的状态版本。
2. 排除过期、撤销、服务不兼容、低于 reserve、超过授权或不能支持最大责任的 bid，保存原因。
3. 按倍率降序、当前修订的服务器接受序号升序排序；使用稳定 ID 作为最后防御性排序键。
4. 按此顺序逐个尝试分配。每接受一个 winner，立即在本轮计算中扣减容量以及全部适用的共享额度；不能先选 top K 再各自验资。
5. 对可接受的 winner 生成确切合同、资金与容量预留、原订单/执行身份和操作意图，一并提交。
6. 保存每个候选的结果、受限审计快照和结果摘要。无可接受 bid 时记录 no-sale，不降低 reserve 或放宽授权。

并发重试必须读取原 round 结果。相同冻结输入与规则产生相同输出；数据库故障重试不能使用新状态悄悄重算一个已经存在的 round。事务冲突导致未提交的尝试可以重试，但不得留下部分 allocation 或发出付款挑战。

外部余额观测可在短事务前取得，并绑定账户、时点与新鲜度；内部责任预留必须在事务中重新检查。不得持有全局容量锁等待不受控的链 RPC。外部余额不能保证买家最终付款，相关风险按第 7 节处理。

### 6.3 落选与滚动参与

`lost` 是 round participation 的结果，不是 bid 的永久终态。未过期、未撤回且仍获授权的 bid 可以按原 revision 参加下一轮，每轮保留具体引用。修订产生新的接受序号，不继承旧修订的同价优先权。

没有可用容量时不授予不可兑现的未来执行位。轮次长度为版本化参数，分别测量窗口等待、空闲容量和到达顺序敏感性；不预设越短越好。

## 7 付款 执行与恢复

不要用一个 `complete` 或 `expired` 覆盖整个采购生命周期。至少分别保存以下维度：

| 维度 | 典型状态 |
| --- | --- |
| Bid | active、withdrawn、expired、allocated |
| 本轮参与 | ineligible、lost、won |
| Execution | reserved、ready、executing、result_available、failed、unknown、fenced |
| Payment | not_started、pending、confirmed、unknown、proven_not_sent |
| Settlement 与 refund | usage_pending、settled、refund_pending、refund_confirmed、unknown |

分配合同冻结付款预留窗口和执行准入期限。只有确认满足原订单支付条件、授权与服务仍允许执行，且当前 allocation 持有有效容量和执行 fence，才可派发。正常执行结束后释放容量；资金终结和退款可稍后完成。

付款窗口到期不证明交易不会成功。要释放尚未执行的容量，必须先持久化封禁该 allocation 的后续准入，并与支付确认/派发 worker 竞争同一权威 fence。若已经派发且结果未知，不能凭本地超时释放其执行容量，必须按原执行恢复。

被封禁后迟到的成功付款归属于原订单，进入原资产退款，不用于新一轮。对已经证明未执行且被永久封禁的订单，退回全部预付本金，不收推理费；买方已经发生的付款 gas 独立记录。未决资金责任保留至有证据解除；退款确认前不能作为可支配余额。第一版释放的可用容量回到下一轮，不做即时 runner-up 替补。

建议限制每 agent 同时一个未付款 allocation，并配置 owner 级总上限、提交/修订频率限制。高价反复不付款的测试必须覆盖容量损失；这些限制不构成抗 Sybil。若实际损失不可接受，另立预锁资金或押金合同，不在本稿隐式加入罚没。

恢复必须保持以下不变量：

- allocation 提交后的进程崩溃，恢复原 challenge/order，不创建新 winner。
- 交易提交或确认未知，查询原交易/操作；不能因 RPC timeout 重新付款。
- 付款确认后响应丢失，恢复原结果；工具续轮不应重复购买上一轮 inference。
- 用量未确定时不把预付款当作最终收入，也不推算全额退款。
- 退款提交或确认未知，恢复原退款操作；不能再次退款或提前释放责任。

## 8 Agent 任务与买方策略

### 8.1 复用原生能力的内存运行

保留 request runner 用于协议与性能资格验证。Task runner 是 agent 客户端的薄运行入口，组合现有 SDK、autobidder、MPP transport 和验收器，不再实现一套 session 管理系统。浏览器使用 fx 与 just-bash；自动化实验使用相同采购和任务逻辑的 Node CLI，运行在实验操作者控制的环境中。

| 组件 | 首版用法 |
| --- | --- |
| wterm | 显示和输入；切换 pane 时保留 runtime 实例，不把终端 scrollback 当作任务状态 |
| fx | 复用原生 agent 循环和内存对话；headless 使用 `createFxEngine()` 或浏览器默认 `memory()` 的 `createFxAgent()`，终端形态可复用 `createFxTerminal()`，不接持久化 sessionStore |
| just-bash | 每任务保留一个 `Bash`/内存文件系统实例，连续工具调用共享该实例的文件 |
| MPP transport | 在每次模型调用时执行授权内采购，绑定稳定 logical call、bid 和原订单 |

不要求 IndexedDB、自建 journal、工作区快照事务、跨标签页写入租约或 checkpoint 导入导出。首版每个内存任务只有一个 runtime；另开页面不自动接管旧任务。工具调用按 fx 的执行流程推进，并配置 just-bash 原生执行/资源限制。若为 UI 响应性放入 worker，只作为执行适配，不引入新的持久化或恢复协议。工具不开放网络、宿主 shell 或钱包凭证；钱包执行器仍通过受限接口按授权付款。

```text
客户端 fx 内存对话 + autobidder + just-bash 内存工作区
  ├─ 工具执行 → 返回结果给 fx → 下一轮模型请求
  └─ MPP client → Market bid/allocation/order → 钱包付款 → 推理结果
```

模型调用前，客户端为该次调用生成并在内存中保留稳定 logical call/幂等标识；同一调用的网络重试复用原 ID。金额上限、订单幂等、bid revision、付款操作意图和防重由 Market/钱包权威持久执行，不能依赖页面内存保证资金安全。页面丢失 ID 后不自动生成新 ID 重放原任务。

Node 自动化实验需要会话持久化时，优先使用 `createFxAgent()` 与官方 `libfx/durable-local` 的 `local({ dir })`，不自建 session 数据库。fx 的会话恢复不自动恢复 just-bash 文件，也不保证外部付款恰好一次；首版遇到进程崩溃且工作区未保留时停止任务自动续跑，标记中断并核对原订单，不能盲目 resume 后重新执行。实验报告和产物可写入操作者的本地文件，不构成服务端 session persistence。

能力依据：[fx 浏览器内存模式](https://fx.sh/docs/lib/webassembly)、[fx 原生本地持久化](https://fx.sh/docs/lib/durability)、[fx terminal adapters](https://fx.sh/docs/lib/terminal)、[just-bash 文件系统](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md#file-system-implementations)。研究基线为已安装的 libfx 0.0.16、just-bash 3.6.0、wterm 0.5.10；使用具体 API 时按锁定版本校验。

### 8.2 生命周期与恢复边界

浏览器关闭或被挂起时，agent 不再产生新的工具调用、模型轮次或 bid 修订；不承诺后台持续运行。Market 可以继续处理已经接受的有效 bid 和原订单，按冻结的 expiry、付款期限、执行与退款规则推进。关闭页面不等于撤销授权或取消已提交 bid；显式暂停应提交并确认撤回/暂停命令，不能依赖 unload 回调。

刷新或关闭页面会丢失浏览器对话、工具工作区和未导出的运行证据。重新打开后不自动恢复或重跑整项任务；UI 可通过重新认证后的权威订单查询展示原付款、推理结果和退款状态，但不能据此重建工具执行进度。用户显式发起新任务时使用新运行身份，仍受未决责任和剩余授权约束。首版不提供跨设备同步、完整任务迁移或浏览器 checkpoint 恢复。

页面关闭不影响已经提交交易的服务端恢复责任。客户端连续运行时的断网重试、原订单查询和金融恢复仍须验收；跨刷新恢复 agent 任务不属于通过条件。

主界面实现合同：

- 首页 `/` 复用现有终端 pane、钱包、任务设置和 Activity；旧 `/memory` 地址仅重定向首页。
- runtime 由 App 级 controller 持有，pane 只负责输入和展示。隐藏、缩放、切换或卸载 pane 不销毁任务；显式暂停停止本地运行并撤销原金融授权，未知撤销结果须继续显示未确认。
- 终端展示任务、工具调用和结果；每个 pane 用同一采购状态行显示等待、出价、付款及完成，轮询不追加重复日志。pane 同时展示 spent、held 与 task cap。
- 任务设置分别填写预算授权、起始经济倍率、倍率上限和买方策略；增加 task cap 不自动加价。首次显式运行才申请最小金融授权，prompt、对话与文件不发送给授权接口。
- Activity 展示本人 bid、原订单、付款、结算、退款以及当前页面的工作区文件，支持导出本页证据。刷新后只查询权威金融历史，不重建工具工作区、不自动创建授权或采购。
- 复用现有 owner 钱包登录，按后端能力使用 Testnet 认证。受控模式明确标记模拟供应和付款，不能提供被误解为已启用真实资金的入口。

### 8.3 真实任务与策略

首个真实任务至少包含两次模型采购和一次真实工具执行：读取客户端虚拟工作区中的数据，通过工具计算，生成可由独立检查器验证的 JSON 产物。

每次模型调用都有独立 logical call 和 request hash，继承任务剩余额度与原 deadline。工具输出改变下一轮 messages，因此不得把整项任务绑定为一个固定文本请求 hash。允许合格的 tool-call-only 模型响应；工具调用终态、文本终态和最终任务成功分别验证。

工具结果返回 fx 后才进行依赖该结果的下一次模型采购，不为此增加持久化 barrier。首个任务仅使用虚拟工作区中的读写/计算工具，页面关闭后不重放工具。独立验收器读取实验操作者保留的原始输入和客户端导出产物验证正确性，不信任模型声称完成或客户端自报成功。它属于实验验收流程，不要求后端保存或恢复 session。

比较三个版本化的买方策略：

| 策略 | 规则 |
| --- | --- |
| Fixed | 各轮维持既定倍率，不跟随授权上限自动加价 |
| Step up | 落选后按冻结步长及间隔增加倍率，到授权/策略上限即等待或停止 |
| Task aware | 根据剩余时间、可用资金、未决责任和未来必要步骤预留决定出价 |

策略仅使用自身结果与明确公开的延迟/聚合市场数据，不读取他人 bid 或 private cap。task-aware 的未来预留与阈值必须版本化，不能借“紧急”绕过预算。deadline 初版是资格及买方策略输入，不作为卖方免费优先级。

任务暂停/撤销阻止新的 bid、付款和执行授权；已经发生的资金/执行操作继续恢复和结算。策略决定、输入快照、版本和原因均进入受限证据。复杂策略是否优于简单策略是实验结果，不是验收前提。

## 9 比较工具与测量修正

### 9.1 时间与顺序

拆分实验授权截止、报价有效期和每任务时长预算。单请求 A/B 比较从各组启动时独立计算等量时间；负载实验从各任务预定到达/释放时刻计算 deadline，不能等 worker 有空才启动计时。若授权有效期不足以覆盖预定预算，在分配实验任务前重新安排该次实验，不缩短后执行组的预算。已分配但未开始的任务也必须留在分母并记录状态。

任务端到端计时从连接/attestation 前开始；持久记录以下时间点及可用范围：任务开始、连接验证完成、bid 接受、round cutoff、allocation、付款提交/确认、准入、派发、首个可见内容、完整可用结果、结果验证、任务产物验收、结算、退款。

此处持久记录指实验 runner 的证据文件及 Market/钱包权威记录，不要求浏览器运行时另建存储。浏览器关闭前未导出的时间点标为 missing；已分配的实验任务仍留在预先保存的 manifest 中，并记录中断或结果未确定，不能从分母删除。需要完整可重复证据的批量比较使用 Node 实验 runner。

在有效终态到达时立即保存 `usable_result_at` 与原始结果摘要；随后单独查询 receipt/结算。财务查询失败不能把已经可用的结果重新标成推理未知。重启可继续补全原请求的财务记录，而不重新购买。

本地持续时间使用单调时钟；跨服务使用带来源的 UTC 时间戳并记录时钟不确定性，不能直接相减得出虚假精确阶段耗时。NEAR 买家可见首内容时间包含完整响应验证等待，不标为原生模型 TTFT。

### 9.2 实验计划与报告

plan 固定 workload、policy、顺序、随机种子、每任务预算与期限、价格和模型配置。A/B 使用均衡的 AB/BA；B/C 使用隔离运行或均衡时间块，明确热身、缓存处理与后台流量。相同 seed 和 temperature 不保证真实模型输出完全一致。

报告将 `response_state`、`task_outcome`、`payment_state`、`settlement_state` 分开。保留拒绝原因与 unknown 的阶段，不把所有异常折叠为无解释的失败。missing/unknown 均显示为未确定，不填零。

从经过身份及原操作绑定校验的权威结算证据填充实际费用；receipt 存在或签名有效本身不等于已经最终结算。tariff estimate、实际买方付款、上游账单分别记录。提供只恢复/补证的命令，禁止其派发新采购。

## 10 实验设计与经济指标

| 实验组 | 供应与定价 | 用途 |
| --- | --- | --- |
| A | NEAR AI 固定价格产品 | 外部产品参照 |
| B | 固定自托管配置，固定费率和明确准入规则 | 同供应控制组 |
| C | 与 B 相同供应，固定底价，买方第一价格拍卖 | 价格与分配组合处理组 |

A/B 不隔离拍卖机制效应；B/C 是主比较。B 与 C 固定 checkpoint、量化、engine、资源配额、工作负载到达过程和初始任务预算。建议 B 用明确实现的 FIFO 准入，复用 C 的容量、付款窗口、计量和恢复路径；不得把现有 driver 假称 FIFO。B 的固定费率需做合理敏感性检查，不能选择明显不合理的价格制造优势。

首轮将 C 的效果称为“价格与分配组合效果”。若以后要归因于价格或排序中的单项变化，必须设计独立消融并说明支付规则改变可能反过来改变出价行为。先使用 fixed bid 评估机制，再比较 step-up 和 task-aware，避免同时调机制和策略。

工作负载覆盖低负载、接近容量和突发，包含不同预算和 deadline。任务级比较固定初始任务、工具、预算、时限和独立成功标准，允许自然形成不同模型/工具轨迹；请求级比较固定完整请求。用 pilot 估计变异，再冻结评估样本数、重复次数与停止规则，禁止只保留成功运行。

| 指标 | 定义与边界 |
| --- | --- |
| 按时正确完成率 | deadline 内通过独立产物验证的任务数 / 所有已分配实验任务数 |
| 每个按时成功任务成本 | 所有已分配任务的最终买方服务费用与付款 gas 之和 / 按时正确完成数；零成功时报告无有限值并保留总费用 |
| 买方资金 | 最终费用、付款 gas、已确认退款、预付占用、holds 和未决责任分列 |
| 卖方经济 | 最终收入与实际供应成本、空闲期间成本、平台/基础设施/退款 gas 分列 |
| 延迟 | 准入等待、执行、可用结果、任务完成和退款延迟分别统计 |
| 容量 | 完成有效工作的占用、未付款预留、执行未知占用、空闲时间分别统计 |
| 分配公平性 | 按预算组报告等待、超时、落选和长期饥饿，不只给总体平均 |
| 后续步骤阻塞 | 因预付占用或退款未确认而无法继续模型采购的次数与时间 |

最终买方服务费用包含冻结的平台费用；退款不再从已按实际用量确定的最终费用中重复扣除。预付、到账和退款另作现金流核对。注资成本作为独立端到端口径披露；若折算为共同计价币种，冻结转换方法并保留原资产数量。

未决资金使净成本无法最终确定时，报告已确认部分、未决规模及可证明的区间；不将未决失败算作零成本，也不把全额预付款直接当成最终费用。平台费、merchant receipt 与 provider bill 分账核对，避免同一笔转移在总成本中重复计数。补贴和 credits 与无补贴成本并列。

B/C 单位成本、卖方收入、低预算等待可能出现不同方向的变化；无需所有指标同时改善才能完成实验。报告样本量、分布和不确定性，并保留负结果。GPU telemetry 只提供对应实例/窗口的运行背景，不能单独证明任务成功或逐任务资源归因。

## 11 私密性与可审计证据

密封出价的最低要求是买家无法读取他人的 bid、cap、任务内容或钱包授权。买家可读取自身 allocation、成交价格、原因和原订单状态；公共统计采用冻结的延迟/聚合策略，小样本可能泄露出价时应抑制发布。

完整 round 候选与资金资格证据仅供受限审计，用于重放排序和分配。审计导出与公开导出分离，公开结果使用去标识化引用，避免直接暴露钱包到账、任务或出价关联。UI 隐藏字段不构成 operator-blind；若主张对运营方保密，需要单独的 attestation、数据路径及访问控制证据。

至少建立如下可追踪链：

```text
experiment → task → logical_call → request_hash → bid_revision
           → round → allocation → pricing_contract → MPP order
           → payment operation → execution → usage → settlement → refund
```

manifest 包含 code/image、上游补丁、模型/engine/tokenizer、服务类别、策略、轮次参数、工作负载与验收器版本，以及 controlled/real 的证据范围。UI 以这些记录为依据，显示缺失、过期与未决状态。

任务和工具证据由客户端显式导出，与 Market 的交易回执通过稳定 ID 关联。可保存经过授权的实验报告/产物以供 review，但它们不是运行时 session 数据库，不能用于后台续跑。客户端任务证据与服务端金融证据分别标注来源；金融回执不证明客户端确实执行了工具或产物正确。

## 12 实施批次与验收

| 批次 | 交付 | 必须通过的验收 |
| --- | --- | --- |
| S0 比较基础 | 修复 PR 17 的计时、顺序、状态和补证恢复 | A/B 获得相同时长；receipt 延迟不改变结果时间；重启补证不新增调用 |
| S1 固定价真实任务 | 客户端 fx/just-bash 内存运行，普通 owner 钱包注资到 agent，MPP 付款与独立验收 | 不依赖服务端 session/journal/tool 接口或浏览器持久存储；真实本金与 gas、结算退款；存活页面内重试无重复采购；可验证产物 |
| S2 分配合同 | 服务类别、整数价格、bid/round/allocation、确定性规则 | 一槽多买家、同价排序、no-sale、共享资金约束、重放一致；只加 cap 不改变 bid |
| S3 Market 事务 | 分配与资金/容量原子提交，支付与执行 fence | 并发 clearing、截止修订/撤回、崩溃、重复命令、其他采购路径抢占均不超售或双花 |
| S4 真实多买家 | 两至三个独立注资 agent 争夺一条受限供应 | bid 变化确实改变 winner；每位 winner 的价格可解释；付款、推理、结算和退款可核验 |
| S5 机制实验 | A/B/C、买方策略比较、财务与任务展示 | 同供应 B/C、全部任务核算、经济与公平性权衡、冻结 manifest 和可重放导出 |

S2 的纯分配实现可以与 S1 独立推进；真实拍卖启用依赖 S1、S2、S3 均通过。S4 是机制验收，不足以替代 S5 的统计比较。Issue 16 以拍卖机制与恢复验收为主；Issue 15 以真实任务、比较实验和证据展示为主；PR 17 继续承担固定供应基础。

重点故障用例包括：同 owner 多 agent 同时耗尽共享预算；修订/撤回恰在 cutoff；提交成功但 ACK 丢失；付款过期后到账；支付确认与执行封禁竞争；GPU 派发后未知；用量返回后 receipt 查询失败；退款成功但 ACK 丢失；高价反复不付款；未来工具轮因预付占用被阻塞。

客户端另需覆盖：多轮工具调用共享内存文件；切换 pane 不重建任务；断网重试复用原调用 ID；刷新后不自动续跑或重买；原订单、付款和退款仍可通过权威查询核对。验收时禁用旧 session/journal/tool API，并禁止浏览器持久存储访问，证明新路径不隐式依赖它们。Node 若启用官方 local durability，验证其与工具工作区丢失、MPP 原订单核对的边界；不把它当成完整任务自动恢复的证据。

真实验收运行计划必须在执行前冻结网络/资产、商户、agent 数量、每 agent 与整次运行的本金/gas/供应成本上限、截止条件和未知操作处理。具体额度由运行授权给出，不能从本文或历史付费测试推导。

## 13 Review 决策表

以下为建议值或待资格验证的选择，review 后写入版本化配置和验收 manifest。

| 决策 | 建议 | 取舍与确认点 |
| --- | --- | --- |
| 首个机制目标 | 更高合格出价取得下一次执行准入 | 任务完成率提升作为待检验假设 |
| 已确认的 session 边界 | 浏览器使用 fx 与 just-bash 原生内存能力，不新增后端 session persistence 或客户端持久化层 | 不要求跨刷新恢复；Node 按需使用官方 local durability；Market 金融恢复保留 |
| 服务类别与容量 | 一模型配置、一窄类别、一个槽位 | 具体输入范围和输出上限由真实工具续轮及供应资格验证确定 |
| 价格 | 第一价格 token rates，固定 reserve 为 1 倍 | 暂不加入动态卖方底价或独立优先费 |
| 倍率与舍入 | 分母 1,000,000；有效单价及结算按第 4 节向上取整 | 最大倍率与金额上限需与现有整数类型一起冻结 |
| 付款资产 | native NEAR 预付退差，成交时冻结兑换率 | agent 支付付款 gas；退款 gas 计入商户成本；不把赞助流当作 agent 自付验收 |
| 轮次窗口 | 先用 1 秒做受控试验候选 | 真实窗口依据等待与空闲损失 pilot 冻结；1 秒不是性能结论 |
| 付款窗口与准入期限 | 根据真实链确认及交付 pilot 冻结 | 未测量前不承诺具体秒数；先封禁准入再安全释放容量 |
| 滚动参与与同价 | 有效原 revision 自动滚动；修订重置同价序号 | 不因重复提交获得额外排队优势 |
| 未付款限制 | 每 agent 一个；owner 上限随批准 agent 数冻结 | 另设 revision 频率限制，观察不付款占用 |
| B 的基线 | 明确定义并实现 FIFO，复用资金/容量/恢复路径 | 固定价格做敏感性检查；不假定旧 driver 的顺序 |
| 首个真实任务 | 沙箱数据计算与可独立校验 JSON，至少两次模型调用 | 先验证闭环，再扩展任务种类 |
| 公共统计 | 默认只显示本人结果及不会泄露个体的延迟聚合 | 聚合窗口、最小样本门槛、审计访问者在公开启用前冻结 |

Review 完成条件是明确上述选择及仍需 pilot 决定的参数，并允许按 S0 到 S5 分批实施。批准机制方向不等于批准任何真实资金额度，也不等于实验结论已经成立。
