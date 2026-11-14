# nearintents.charge 验收 — 2026-11-13

| 范围 | 结果 |
| --- | --- |
| 官方客户端/服务端 SDK + 真实 PG/Redis + 受控 1Click | **PASS**，21 项检查（包含无外部请求的 live-profile 买方隔离） |
| 官方 1Click token/dry quote + 标准 SDK 真实 402 报价 | **PASS，仅无转账预检** |
| 主网付款、商户真实到账、真实资金入账 | **尚未验收**，新钱包未激活/未注资 |
| 新版部署、自动竞价成交、生产资金上线 | 不在本轮通过范围 |

使用 `@defuse-protocol/nearintents-mpp-sdk@0.4.1` 和 `mppx@0.17.0`；没有修改包源码或自定义一套名为 nearintents 的凭证。SDK 的标准方法、hash Credential、付款 policy 与 Receipt 实际参与了测试。

## 本地受控证据

[机器可读记录](2026-11-13-nearintents-charge-evidence.json)包括从 `main` 隔离后的本 PR 源文件摘要、复验范围与以下检查：标准 SDK 客户端/服务端互通、EXACT_OUTPUT 额度、不同充值单报价隔离、buyer 隔离、并发重呈、源链 hash canonical 防重、一笔入金支付两次原生采购、余额守恒、重启回执恢复、真实 PostgreSQL COMMIT ACK 丢失、SDK consumed 与现金事务一起回滚、回滚后持久证明恢复、1Click 暂不可用与超时重试、错误 hash 拒绝、FAILED/REFUNDED/INCOMPLETE_DEPOSIT 不入账、不再次发起 402 收款，以及已发送 hash 的官方客户端路径。

主场景从零余额开始，一次受控精确入金 10,000 microUSD，执行两次受控原生推理后累计扣费 74、余额 9,926。原现金账本、Redis outbox 与资金守恒一致，没有真实资产移动或外部推理费用。

故障场景使用真实 PG 代理丢弃已成功 COMMIT 的确认；重呈后只入账一次。另在原 ledger 上安装受控故障触发器，让验款后的现金写入失败，验证 SDK hash consumption 同时回滚，先前独立写入的 Credential journal 保留，之后 `/reconcile` 可恢复。

## 正式服务的无转账预检

以下为本 PR 隔离前的历史工作区预检，使用相同锁定 SDK 与 bridge 组件；最终分支未重新请求外部报价。当前源文件摘要绑定本 PR 的受控复验，不将历史预检扩大为最终分支的主网验收。

从官方 `https://1click.chaindefuser.com` 取得 token 列表及 NEAR wNEAR → NEAR USDC 的 dry EXACT_OUTPUT 报价；随后本实现调用官方 SDK 创建真实可执行报价，并返回标准 `method=nearintents`、`intent=charge`、`Payment-Authorization` 和资源 scope 绑定的 402。

目标为 0.01 USDC。2026-11-13 22:54:42 America/New_York 的标准 402 报价请求源链 **0.004276710746386491665684 wNEAR**。此数字仅是当时的观察，不是长期价格、待支付指令或费用承诺。临时报价地址未公开作为付款目的地，本地临时状态已清理；正式付款必须重新准备。

生成钱包、真实 quote 和账户/存储 RPC 预检均未签署或广播链上交易。两个新地址的 RPC 状态为 `UNKNOWN_ACCOUNT`。钱包与后续试点边界见[主网准备计划](../nearintents-mainnet-acceptance-plan.md)。公开证据仅含钱包地址摘要、token 条款、观察值及摘要，不含私钥、seed、bearer token 或 MPP 服务端 secret。

## 运行与回归

```bash
bash scripts/accept-market-nearintents.sh --evidence /tmp/private-market-nearintents-evidence.json
cargo test --locked --manifest-path crates/private-market-host/Cargo.toml --bin private-market-host
python3 scripts/accept-market-mpp.py crates/private-market-host/target/debug/private-market-host
python3 scripts/accept-market-a.py crates/private-market-host/target/debug/private-market-host
```

标准方法 21 项检查、Node 配置单测 2 项、Rust 二进制单测 1 项（bid 阶梯边界与溢出检查）、旧测试方法 21 项及原 batch A 三买方回归均通过。`cargo clippy -- -D warnings` 通过；未声称运行完整 kernel/batch B 全套、CI 或部署验收。

原 funding API 仍默认关闭；nearintents 和旧测试方法互斥。金额、商户、资产、退款和 HMAC secret 的配置被持久固定；不能给旧演示积分改名后宣称有真实本金。

## 限制

自动退款、过期付款的自动入账和 owner 网页钱包接线未实现。验款在其有界结算时间内串行化同一用户的资金操作，尚未做生产吞吐/长时间运维验证。原 TEE 部署验收不覆盖新增 Node 组件与配置。当前通过结论不能扩大为主网资金结算或整份动态竞价 spec 完成。
