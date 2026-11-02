# External Prefill Gating Scheduler：独立设计审阅

- 日期：2026-11-02。
- Reviewer：独立 `gpt-6-astra` agent；未继承前序讨论，读取当前 spec、README 和一手资料后审阅。
- 本文整理 reviewer 的完整主要意见；原 spec 与 README 未因本次 review 修改。
- 审阅对象：[Scheduler Spec](../specs/2026-11-02-external-prefill-gating-scheduler.md)、[README](../../README.md)。下文行号对应本次审阅快照。
- Spec SHA-256：`d37061e247f3ee63b054ef5e110c359b1265ab9eff3de042d429025176dffb44`。
- README SHA-256：`22cf12654ef4dc4abf2511afafc2aa4e5f0d3a301c7aa50244d5a305cc7f4244`。
- 范围：设计审阅，未运行 GPU、性能或 TEE 验收。

## 总体结论

接受网关外部 prefill 门控作为 MVP 执行方向。第 12 节中的价格与退款决策需要修改后确认。

VCG 应归 **auction 模块**。数学上“计算顺序”的 allocation rule 与工程上“执行冻结顺序”的 scheduler 应在名称和接口上区分。Auction 和 scheduler 可以分服务；MVP 建议先在一个可信服务内保持独立模块、一个金融提交事务边界和一个调度写入者，vLLM 为本机独立进程。

最优先的四项修改是：买家级付款到逐 grant 结算的映射、可复现的 auction contract、结果存储容量闭环，以及恢复后的重新激活协议。

## Findings

### F1 — [P1] 买家级 VCG 付款到逐 grant 收费/退款的映射未定义

位置：spec 第 104、275、281–282 行，README 第 98 行。

counterfactual 按 buyer 同时归零是正确方向，但结果是一个 **buyer-batch 总付款**。`ExecutionGrant` 却保存 `priority_payment`、`hold_id`，第 9 节又按请求成功收费、失败退款。同一买家在一批中有两个请求、只有一个成功时，现稿无法决定应收多少、退多少，以及由哪个授权或 hold 承担。

不能把同一买家的请求分别当成不同买家定价。例如，三个互不共享前缀的请求中，A 拥有出价 10、8 的两个请求，B 的请求出价 6，位次权重为 1、0.5、0。A 的买家级付款为 6；若错误地逐请求独立定价，会得到 7、3，合计 10。

建议二选一：

1. **最小 MVP：**每个认证买家每批最多一个请求；保留 buyer-level 接口。
2. **保留多请求：**新增 `BuyerBatchObligation`，保存买家总付款、总授权、holds 与结算版本；冻结 grant 之间的记账分摊规则，保证分摊之和等于总付款、各请求不超授权。分摊不称为“逐请求 VCG”；部分失败退款另行规定。

两种方案均应在冻结前完成资金准入，在 commit 前验证全部授权不变量。不能清算后发现超限，再截断付款或删除请求继续执行；那会改变机制。

### F2 — [P2] 缺少可复现的 auction contract 与价格 oracle

位置：spec 第 90、273、299 行，README 第 78 行。

平均出价排序和付款直觉尚不足以规范机制。需要精确的福利函数、请求辅助叶子、重复/前缀请求的处理、namespace 如何构造树、并列规则、金额精度与舍入；否则不同实现可能产生不同顺序和价格。

建议另立 auction spec，由 scheduler spec 引用，至少规定：

\[
x_r(\sigma)=\frac{n-\operatorname{rank}_{\sigma}(r)}{n-1},\qquad
W(\sigma;b)=\sum_r b_r x_r(\sigma),\qquad
\sigma^*\in\arg\max_{\sigma\in D(T)}W(\sigma;b).
\]

其中 rank 从 1 开始。`n=1` 单独规定零 priority payment；所有实际分配与 counterfactual 使用相同的请求集合、buyer 归属、namespace、树和可行集合。每个请求拥有独立辅助叶子。采用确定性的并列规则和整数/有理数计算，单独定义金额舍入及其理论影响。

加入小规模穷举 oracle：枚举树允许的全部 DFS 顺序，验证福利最大、buyer-level counterfactual、付款非负和付款上界。覆盖单请求、全零、并列、重复 prompt、前缀 prompt、单买家及多请求。

### F3 — [P2] 有界结果 spool 缺少空间预留和保留期限

位置：spec 第 173、247 行。

现稿限制排队输入和在途 context，但已完成结果在执行容量释放后仍需保留。持续提交且不取结果的买家可以填满 spool。“存储故障停止新派发”没有保证已承诺请求仍有输出空间，也没有给断线后领取结果的承诺划定期限。

建议增加：

- 全局与逐买家的结果存储配额；
- 执行前最坏情况输出空间预留；
- 明确的保留期限、领取和清理规则；
- 有界 SSE parser、单事件大小及事件队列；
- 存储满时，分别处理未派发、在执行和已终止请求。

结果空间不足不能清除执行责任。验收增加长期不读取、磁盘满、spool 写失败和已结算结果到期等场景。

### F4 — [P2] 缺少 RECOVERY_REQUIRED → ACTIVE 的验收协议

位置：spec 第 260、265、310 行。

停止派发、隔离旧引擎和禁止盲目重发的方向正确，但尚未定义谁确认隔离、如何绑定 engine epoch、如何重建 cursor/容量、哪些未派发 grant 可以继续，以及如何处理旧连接迟到事件。只验证崩溃后停止不足以验证安全恢复。

建议提供 MVP 人工触发 runbook：关闭旧入口，确认旧进程不能继续执行，持久化旧 epoch 的关闭事实，逐项核对旧意图、终止、结果和金融责任，重建容量及下一 grant，再启用新 epoch。无法证明条件满足就保持停止。

补充旧进程仍存活、旧连接迟到、profile 变化、journal 写失败、退款后迟到终止、旧 epoch 事件重放等验收。负载均衡器切流和健康检查不能作为旧执行已经结束的证据。

## VCG：哪些已有理论依据，哪些需要额外设计

原论文讨论的本来就是 **prefill 准入位次**。固定 request-augmented radix tree 的 DFS 可行集合、线性且可加的 fractional-priority 价值及准线性效用，是其机制基础。Theorem 3.1 给出 average-bid DFS 的受限福利最优性；Definition 3.2 给出保留请求、将同一买家全部出价归零的付款。[Inference Auctions §2–3](https://arxiv.org/html/2609.40070v1#S3)

因此，decode 可并发或采用外部门控，**本身不会推翻 rank 模型内的 VCG 结论**。建议重写 spec 第 273–275 行，将三层问题分开：

| 层次 | 审阅判断 |
| --- | --- |
| 计算正确性 | 实现是否确实使用指定树、DFS 可行集合、线性 rank welfare 和 buyer-level payment；以 oracle 验证。 |
| 模型内激励相容 | 在上述固定请求/批次/可行集合及效用条件下，有现成理论依据。 |
| 产品真实效用 | rank 是否代表实际 TTFT 或完成时间价值，以及资金准入、部分失败、退款和身份策略对激励的影响，需要额外分析与测量。 |

不能把 average-bid DFS 的结论推广到任意福利目标。Reviewer 给出的反例：一个子树出价为 10、0，另一个子树只有 6；若位次权重改成 1、0.1、0，按平均出价先放 6，福利为 7；先放 10、0 再放 6，福利为 10。

第 9 节失败退款可以作为测试 credits 的业务政策，但不能自动继承全部成功情形的激励保证。固定 base quote 有助于隔离优先级机制，并不自动证明整个推理服务的个体理性。

## 第 12 节四个待定决策

原第 1 项是已选方向，下表对应第 2–5 项：

| 决策 | 建议 | 落地条件 |
| --- | --- | --- |
| 生成 token IDs 开门，合法终止退出 | **接受** | 锁定版本；验证 request ID 映射、单 choice、输入回显、错误优先级；保留生成 IDs 与 prompt IDs 的区分。 |
| 在途初值 4，context/timeout 校准后冻结 | **修改后接受** | 4 作为压测候选，不是未校准部署默认；比较 1、2、4，缺少有效 profile 时拒绝启动。保留不越队首、UNKNOWN 不释放预算。 |
| 实验 VCG 和失败退款 | **修改后接受** | 明确模型内定理；补齐 buyer 总付款和逐 grant 责任。优先考虑每买家每批一个请求，否则延后到多请求结算政策完成。 |
| 合成数据共享，私密请求按买家隔离 | **接受并补充约束** | namespace 参与冻结树结构和请求绑定；salt 由网关控制；隔离域不同不能合并成可共享前缀。使用密码学缓存 hash 并验证隔离。 |

token-ID 信号的证据来自 pinned [Completion protocol](https://github.com/vllm-project/vllm/blob/db7f2d7c44f12f8b690c930000d89e479f3838c0/vllm/entrypoints/openai/completion/protocol.py#L164) 和 [stream serving](https://github.com/vllm-project/vllm/blob/db7f2d7c44f12f8b690c930000d89e479f3838c0/vllm/entrypoints/openai/completion/serving.py#L317)。缓存隔离与 hash 风险见 [vLLM prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching/)。

## 模块职责与接口

| 模块 | 权威职责 | 不应承担 |
| --- | --- | --- |
| Auction | 固定请求集合与可行集合；allocation；buyer-level pricing；不可变分配及价格记录。 | 依据执行时缓存、延迟或完成顺序重新定价。 |
| Scheduler | 校验执行授权、完整登记、顺序/门控/容量、派发意图、执行事实。 | 读取原始 bid/budget、计算 VCG、决定退款金额。 |
| Ledger / Settlement | 余额、holds、授权上限、付款义务、幂等收费与退款；依据事实应用冻结政策。 | 从超时推断没执行，或通过退款清除执行责任。 |
| Result storage | 结果完整性、持久化、身份化交付、保留期限。 | 将终止信号等同于完整交付。 |

建议使用三类契约：

```text
CommittedAllocation / BuyerBatchObligation
    auction / ledger 私有：完整分配、经济字段、总授权和付款义务

ExecutionPlan
    scheduler 可见：顺序、输入绑定、限制、namespace、执行身份、版本、授权证明

ExecutionEvent / ResultEvidence
    scheduler / result 模块输出：原授权绑定的执行和结果事实
```

Scheduler 无需接收 `base_charge`、`priority_payment` 或 `hold_id`。可以接收不含金额的 `authorization_ref` 或 capability，证明计划已获有效授权；具体资金状态仍由 ledger 权威判断。买家身份可替换为必要的 opaque owner reference。

这是职责与最小披露建议：在同一个 TEE 内携带完整 grant 不自动构成漏洞；分服务后继续传完整经济字段，会扩大不必要的暴露面。

## Module 与 service 的选择

### MVP：同一可信服务，独立模块

建议一个可信应用服务，auction、scheduler、ledger/settlement 保持模块边界，使用一个金融提交事务边界和一个调度写入者。清算结果、资金义务和待执行计划可以原子提交，恢复范围较小。vLLM 仍可为独立本机进程。

逻辑模块分离不意味着必须各自部署，也不妨碍未来拆服务。

### 可以拆服务，但要显式增加协议

Auction 不必部署在 GPU 旁边。Scheduler 可以与 GPU/vLLM 就近部署，而 auction 在另一可信服务中。但跨服务调用需要至少覆盖：

1. **Durable commit：**auction/ledger 权威侧原子提交金融义务、完整不可变 manifest 和可发布记录。scheduler 只接受已提交计划。ack 丢失可重投登记消息，不能重投已有推理意图。
2. **完整 manifest：**规范序列化、成员数、顺序、请求摘要、限制、profile、策略与授权绑定。金融 manifest 和去除金融字段的 execution manifest 可分别摘要，并由提交记录绑定。
3. **顺序权威：**auction 唯一分配 commit sequence；scheduler 唯一分配 dispatch intent。后来的批次先到，不能越过缺失的更早批次；需要连续序列、前驱引用或可验证的 committed high-watermark。
4. **身份与幂等：**同 plan ID 同摘要幂等，不同摘要拒绝；事件绑定 grant/execution/engine epoch。消息与账本幂等不等于 vLLM POST 或 GPU exactly-once。
5. **独立恢复：**定义两服务分别崩溃、网络分区、ack 丢失、计划重放和旧 scheduler 存活的处理。授予新 writer 权限前必须有效隔离旧 writer。
6. **认证与 TEE：**服务身份必须绑定批准的代码与配置。跨 TEE 时，批准策略和密钥释放要覆盖 auction、scheduler 和执行环境；普通 mTLS 不能单独证明对端运行批准代码。

TEE 的 host 隔离也不等于阻止 guest 管理员读取数据；服务拆分后的受信组件与管理面需要一起纳入部署策略。[NVIDIA Trust and Threat Model](https://docs.nvidia.com/confidential-computing/virtual-machines/threat-model)

## 证据与不确定性

- **证据支持：**pinned vLLM 提供所需 token-ID 流字段；DONE 不能单独证明成功；论文的受限 rank-VCG 机制有明确公式与定理。
- **架构判断：**VCG 归 auction，scheduler 消费去除金融字段的 ExecutionPlan；MVP 同服务更易完成可靠提交与恢复。
- **待验证：**目标 GPU 上的并发数、真实 TTFT/吞吐/缓存效果、完整 TEE 部署，以及部分失败退款等扩展的经济性质。

现稿对进度屏障、终止与结果完整性的区分、UNKNOWN 停派、禁止盲目重发及金融责任分离已有较完整的基础。以上 findings 是设计补全要求，尚未成为实施变更或验收结果。

## 后续范围决定：Scheduler-only

用户随后确定本次设计与实现聚焦 scheduler，复用 BitRouter 已有的 auction 与 settlement。上文保留为原 SHA-256 快照的审阅记录，其行号不再对应更新后的 spec。

- F1/F2 的经济机制与金融接口所有权归 BitRouter，不要求本仓库新建 VCG、付款分摊或 settlement。现有 BitRouter 实现未因本次范围决定而被审计或证明正确。
- F3/F4 对应的结果空间、交接与恢复要求已纳入更新后的 scheduler spec；仍待实现和运行验收。
- 当前 [Scheduler Spec](../specs/2026-11-02-external-prefill-gating-scheduler.md) 定义 ExecutionPlan、ExecutionEvent 和 Result Handoff 边界；金融字段不再进入 scheduler 协议。
