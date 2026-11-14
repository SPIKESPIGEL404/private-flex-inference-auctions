# NEAR Intents charge 主网验收准备

- 状态：**钱包和无资金预检已完成；尚未注资、签名或转账。**
- 日期：2026-11-13，America/New_York。
- 对应[实现](market-nearintents-charge.md)与[验收范围](acceptance/2026-11-13-nearintents-charge.md)。

## 本机验收钱包

使用官方 `near-cli-rs@0.31.1` 的 `account create-account fund-later use-auto-generation save-to-folder`，为买方和商户分别生成独立 Ed25519 密钥。公钥解码后的 32 字节与各 implicit account ID 逐一匹配；凭证目录为 0700、凭证与私密生成日志为 0600。没有读取或使用既有钱包。

生成的买方、商户及买方退款地址保留在操作者本机公开清单中；实际凭证位于仓库外受限目录。本 PR 不发布钱包地址、凭证路径、私钥或 seed。执行试点前，应从本地清单核对角色与地址，再填写支付配置，不能使用文档中的占位符付款。

NEAR 主网 RPC 对两个地址均返回 `UNKNOWN_ACCOUNT`，因此目前只是本地生成了钱包地址，还没有激活链上账户。它们不是测试网已注资钱包。

## 已完成的无资金预检

1. 读取官方 1Click token 列表，确认 wNEAR 24 位、目标 NEAR USDC 6 位。
2. 使用这些真实公开地址请求 `dry: true`、`EXACT_OUTPUT` 的报价，目标为 `10000` USDC atomic units，即 0.01 USDC。
3. 在独立临时本地 PG/Redis 中，用本实现和官方 SDK 请求真实可执行报价，成功创建 FundingIntent，并由 `/pay` 返回标准 MPP 402 Challenge。
4. 全程没有提交存款 hash、签署或广播交易、入账现金或调用外部 Provider。临时本地宿主随后清理，历史报价不是可继续付款的订单。

观察时间为 2026-11-13 22:54:42 America/New_York，真实 402 报价的源链金额为 `4276710746386491665684` yocto-wNEAR，即 **0.004276710746386491665684 wNEAR**，目标精确收到 0.01 USDC。该报价已是历史证据；付款前必须重新取价并检查 policy，不能使用本文的金额或历史临时存款地址直接转账。

只读 RPC 还确认：`wrap.near` 和目标 USDC 合约的 `storage_balance_bounds.min` 均为 `1250000000000000000000` yoctoNEAR，即每个需要注册的账户 0.00125 NEAR。它是存储预留，不是 1Click 报价之外的已发生支出；是否需要注册应在执行前查询。

## 建议的有界真实试点

以下是**待审的准备额度和支出上限**，本轮没有执行或默认取得主网支付授权：

| 项目 | 建议 |
| --- | --- |
| 买方资金预留 | 0.05 NEAR，用于激活账户、必要注册、少量 wrap 和 gas；未使用部分仍归买方 |
| 商户资金预留 | 0.02 NEAR，用于激活账户、必要 USDC 注册及 gas；未使用部分仍归商户 |
| 单笔采购目标 | 一笔 MPP charge，购买 0.01 USDC 对应的推理额度 |
| 采购源资产硬上限 | 最多 0.01 wNEAR；报价超过上限则停止，不扩大预算 |
| 存储注册上限 | 仅已查证需要的买方 wrap.near 与商户 USDC 注册，各最多 0.00125 NEAR |
| 链上 gas 额外支出上限 | 合计最多 0.003 NEAR；执行前冻结实际交易列表和 gas 参数，超出即停止 |
| Provider 验收 | 本轮无新增真实 Provider 预算；受控 seller 已验证同一笔额度支持两次采购 |

0.05/0.02 NEAR 是给用户控制钱包的准备本金，不等于费用或商户采购收费。为新账户注资的源钱包及其发送费用仍需用户确定，项目不从本机其他钱包找钱，也不将测试网资产当主网本金。

执行顺序：确认资金来源和上述上限 → 注资并核对实际到账/链上激活 → 查询注册状态 → 仅按需要进行注册与 wrap → 在**持久保存**的 Market 宿主中创建新 FundingIntent → 验证原始条款和客户端 policy → 发送一次存款并保存链上 hash → 用官方客户端重呈原 hash → 核对 1Click SUCCESS、商户 USDC、MPP receipt、原账本入金及防重 → 保存完整私密证据及公开摘要。

买方签名工具只读取本次新生成钱包的本地凭证。主网存款与初始化交易需在实际执行前另行确认；出现 Unknown、超时、到期或失败时保留原责任，不重新付第二笔。成功报价不证明账户已经可收款、USDC 已到账或生产资金已验收。

官方工具：[NEAR CLI](https://github.com/near/near-cli-rs)、[fund-later 指南](https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md)、[1Click 报价 API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)。
