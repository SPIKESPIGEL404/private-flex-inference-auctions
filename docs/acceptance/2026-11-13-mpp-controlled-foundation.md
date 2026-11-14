# MPP 额度入金与动态报价基础验收 — 2026-11-13

**PASS，仅限本地受控范围。** 使用官方 Rust MPP core 0.20.0 的外层协议、进程外 Ed25519 测试 authority、真实 PostgreSQL/Redis 和既有受控原生 Market。没有真实资金、外部 Provider 调用、新部署或链上费用。

对应[规格](../specs/2026-11-13-mpp-funded-dynamic-bidding.md)和[实现说明](../market-mpp-controlled.md)。[机器可读证据](2026-11-13-mpp-controlled-foundation-evidence.json)记录 21 项检查及本次源文件 SHA-256。该基础套件已在从 `main` 隔离的本 PR 分支上重跑，证据摘要对应本 PR 源码；标准方法的受控与真实报价范围另见[后续记录](2026-11-13-nearintents-charge.md)。

## 观察结果

| 项目 | 结果 |
| --- | --- |
| 受控初始本金 | 0，无初始积分分录 |
| 一次 MPP fixture 入金 | 10,000 microUSD 测试额度 |
| 八个并发原凭证重呈 | 只形成一个 payment consumption、一个 purchase ledger entry |
| 同一底层付款跨 intent 重呈 | 拒绝；另一买方余额仍为 0 |
| 同一余额支付两次原生采购 | 两次受控 seller 调用，重复原生请求不增加 submit effect |
| 两次采购累计实际现金扣费 | 74 microUSD；剩余 9,926；原账本守恒 |
| 入金 COMMIT 回执丢失 | PG 代理实际丢弃成功 COMMIT 的确认；首次返回 503，重呈原凭证后仍只入账一次 |
| 报价并发更新 | 两个相同 expected revision 的修改只有一个成功，另一个 409 |
| 调价与状态 | 操作幂等、硬 cap、手动覆盖、按绝对时间 tick、截止及取消通过 |
| 重启 | 原余额、回执、报价和起始时间保留；更换可信 authority 公钥被拒绝 |
| 竞价 dispatch | 未启用；单独创建或调价不会产生 Provider 调用 |
| 默认行为 | 关闭新 API 时返回 404；原三买方测试积分及原生采购行为保持 |

付款验证和实际现金事务使用了原 `credit_accounts`、`credit_ledger_entries`、用户 advisory fence 与 `redis_balance_mutations`，原数据库触发器保持启用。没有新增独立可花用余额，也没有改写固定 Cloud 依赖或其恢复代码。

## 执行的检查

```bash
bash scripts/accept-market-mpp.sh --evidence /tmp/private-market-mpp-evidence.json
cargo test --locked --manifest-path crates/private-market-host/Cargo.toml --bin private-market-host
bash scripts/accept-market-a.sh --evidence /tmp/private-market-a-after-mpp-evidence.json
```

- MPP 受控验收最终版本：21 项检查通过；包含真实 PG 协议层的入金 COMMIT ACK 丢失。
- Rust 二进制单元测试：1 通过，为新增阶梯调价边界/溢出检查；仅纳入本 PR 相对 `main` 的代码。
- `cargo clippy -- -D warnings` 与 Rust 格式检查通过；Python 编译检查通过。
- 原 batch A：三买方、三次 submit、原生 SSE、资金结算与回放通过。
- 另执行原 batch B 的 `lost_commit` 场景，确认可配置 fault marker 保留了原生结算丢 COMMIT 回执测试；未运行完整 batch B/kernel 全套。

全部验收创建并清理自己的 loopback 服务；测试私钥只保留在临时目录，证据不包含 bearer token、签名私钥或原始付款凭证。

## 尚未验收或实施

- 主网真实付款、NEAR Agent API 与 Tempo；标准 nearintents 的官方 SDK 互通已在[后续批次](2026-11-13-nearintents-charge.md)完成受控验收。
- 正式资产、信用换算、异常/迟到实收款责任与退款派发。
- 任务预算、Offer 撮合与资金预占的原子接纳，admission fencing 和自动 Provider dispatch。
- 后台自动 tick 与 browser/fx 钱包接线；本批由显式 tick API 驱动阶梯报价。
- 新版本机密部署、生产状态新鲜性、真实支付或真实模型质量。

本记录是第一批受控基础实现的证据，不是整份 spec、P1/P2 或生产上线的完成声明。
