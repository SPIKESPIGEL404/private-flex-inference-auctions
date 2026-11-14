# P3 OutLayer native NEAR run plan

状态：**独立 OutLayer 实现已有本地验收；真实完整任务/P3 NOT_ACCEPTED。**

实现、运行方式和分层证据见 [P3 实现记录](../agent-mpp-p3.md)。钱包层真实 testnet 的普通 Transfer、agent gas、exact NEP-413 和冻结后退款已通过组件验收；本地双任务/请求级资格/owner setup 已通过，均不等于真实 provider 或浏览器 owner 闭环。

2026-11-14 钱包层从 Agent API 改为 OutLayer Custody。已完成独立 testnet 钱包五项原语测试，以及普通 Transfer、exact NEP-413 和冻结后退款的真实 testnet 组件验收；浏览器 owner、真实推理联合验收和 mainnet 尚未通过。具体 API、policy、编码和 Unknown 合同以 [OutLayer 迁移规格](2026-11-14-outlayer-custody-migration.md)为准。

## 1. 当前付款与控制权合同

- 每 agent 独立、无 binding OutLayer custody wallet；用户是各 policy 的链上 controller。
- Agent 使用账户自身的 native NEAR（24 位精度）支付 inference 本金和实际 payment gas。
- MPP `bitrouter-near-direct/charge` v1 保留单笔 exact Transfer、同 key 的 NEP-413 原订单绑定、独立 FINAL receipt 图及原资金权威全局消费。
- Merchant 向原 agent 退回所有正数应退本金，单独承担 refund gas；不扣 dust、不自动变为平台额度、不自动跨链。
- NEAR 直充或独立 1Click source → native destination funding 是准备阶段，不在每轮 inference 热路径。
- 不依赖 Agent API partner key/grant、不使用 personal binding/lease、项目托管 agent 私钥、NEP-366 或 gas-key signer。

NEP-366/gas-key 研究与 P0–P2 fixtures 保留历史标签，不能作为 OutLayer 当前路线验收。原 Agent API 存量责任保留旧 binding 以只读/恢复方式核清，不自动转移资金或删除旧凭证。

## 2. 已有的 testnet 原语证据

[脱敏证据](../acceptance/2026-11-14-outlayer-wallet-policy-evidence.json)：两个隔离 custody 钱包、controller 策略上链、允许小额付款、越额拒绝、非白名单拒绝、冻结后拒绝；5/5 通过。支付 signer 与 native balance 算术证明 agent 自付本金/gas。四笔成功 OutLayer 交易均经独立 RPC 验证 FINAL。

Controller 也是测试 custody 钱包，不是用户浏览器钱包。仅此测试已获测试币授权并完成；不能据此授权 mainnet 或真实 provider 花费。当前 spec 修订不执行新增外部资金动作。

## 3. G1 当前缺口

真实 MPP 发送前完成：

1. 用户浏览器 NEAR owner 登录，创建独立钱包，直接签 OutLayer policy store，读回 controller/密文/version/hash；无 policy、错误 controller、未知创建状态时不允许注资。
2. 原 Challenge message/recipient/32-byte nonce → OutLayer sign-message → 本地 NEP-413 验证及 v1 Credential。实测 address hex、sign-message base58 与现有 verifier 的转换；错误域、nonce、key、txHash 拒绝。
3. Native `/transfer` 的原 key/body 去重：并发、body 冲突、ACK 丢失、服务重启、保留期。不得直接套用 withdraw 文档或 Agent API SDK 恢复合同；无原 ID 的歧义发送在资格关闭前只进入 review，不自动再 POST。
4. 持久状态机：发送前可能已发标记、UUID request_id、查询嵌套 result/hash、成功/失败/processing/needs_review、429/超时与付款后签名失败。Unknown 不释放/重付。
5. 原 Market writer 内跨任务本金与 gas 预留、actual gas 一次记账、exact FINAL 实收与一次接纳；gas 超估如实记录并停止新采购。
6. 真实 merchant 退款：退差、晚到/失败款、最小正金额、ACK 丢失与 agent 已冻结/key 失效。入账 FINAL 后才恢复相应可用本金；agent gas 已花，不被退款清零。

Gas reserve 是估计/停购阈值，不是链上费用硬上限。冻结后拒绝签名不等于撤回在途付款；控制权、付款、订单到期和链上有效性分开处理。

## 4. 分步真实验收

### T1：testnet 完整 MPP

- 先实现并验证 G1 adapter/owner/signature/恢复；可用已确认 policy 的测试账户 NEAR 直充隔离跨链影响。
- 一个真实 agent 调 Proxy chat/completions，完成一次 402 → Transfer → NEP-413 → 原请求重呈 → 原 Market 执行/用量 → 商户退差。
- 再运行两个独立 fx 任务，其中至少一个工具续轮；每轮证据关联原 task/call/quote/payment/admission/usage/refund。
- 真实 provider 调用、输出/USD 上限、merchant principal/refund gas 和截止时间预先冻结。没有可用 provider 时只测试支付，不冒充完整任务 PASS。
- 完成 G1 故障矩阵和源版本对应的本地/服务验收；测试钱包/策略状态与证据保留，不能靠手动改余额消除 Unknown。

### T2：mainnet funding + 双 agent

在可审阅运行清单中冻结：

| 范围 | 必填 |
| --- | --- |
| 版本/网络 | 当前 source、adapter/method/policy schema、OutLayer base/contract、NEAR RPC chain ID、实际 provider/model/tokenizer/rates |
| Owner | 用户控制的 NEAR controller、浏览器签名钱包兼容性、policy storage/gas 费用来源与上限 |
| Funding | source chain/asset/precision、总本金/每 agent 分配、每 leg 最低 native 净到账、fee/slippage 上限、source refund destination、原 operation identity |
| Agent | 每个 wallet/payer/key/policy/binding、任务/单次本金上限、gas estimate/floor/stop、任务截止时间；无隐式补充资金 |
| Merchant | 商户 payer、退款本金储备、退款 gas 预算、原目的地及 durable recovery/outbox |
| Provider/部署 | 真实凭证的安全引用、请求/输出/USD 限额、部署目标与费用上限；不在 plan 中保存原始密钥 |
| 验收 | 实际 task 产物、费用/资金对账、原操作恢复、独立审阅；若验收任务要求 reviewer，单独启动并记录其真实结果 |

再验证受支持链的两条原 1Click funding leg 最终交付 native NEAR，然后运行双 agent 真实任务及至少一次工具续轮。Testnet 无 Intents solver，不能替代这项 mainnet 证明。直充单调用通过也不等于跨链 funding 验收。

## 5. 当前阻塞条件

不再需要有效 Agent API partner key。OutLayer adapter、owner-controller 配置接口、原账本 gas/退款/恢复与有界执行器已实现并通过本地验收。仍需真实浏览器 owner、真实 provider 与链上资金联合验收、mainnet source wallet/solver、有界运行授权，以及 hosted native 幂等故障验证。Unknown 继续禁止自动重发；不能用本地去重测试证明 hosted retry 安全。

[整合主规格](2026-11-14-agent-mpp-inference-integration.md) · [P0 合同](2026-11-14-agent-mpp-p0-contract.md) · [OutLayer 调研与迁移合同](2026-11-14-outlayer-custody-migration.md)
