# MPP 入金与动态报价：第一批受控实现

后续已经增加[标准 nearintents.charge 实现](market-nearintents-charge.md)。本文保留第一批 `bitrouter-test` 基础实现与回归运行方式，不再表示标准支付方法仍未接入。

对应[评审规格](specs/2026-11-13-mpp-funded-dynamic-bidding.md)。本批实现官方 Rust `mpp = 0.20.0` 的 Challenge/Credential/Receipt 外层交互、受控付款验证、现有现金账本入金及成交前报价状态。

本地受控结果见[验收记录](acceptance/2026-11-13-mpp-controlled-foundation.md)及其机器可读证据。

支付方式为项目测试方法 `bitrouter-test`，资产固定为 `test:USD6`。测试 authority 在进程外签署 Ed25519 receipt；宿主只持有其公钥。此方法不转移真实资金，不验证 NEAR Agent API 回执，也不代表 `nearintents.charge` 或 `bitrouter-near-agent` 已实现。未完成跨 SDK conformance 验收。

## 实现范围

- 默认关闭的认证 API；显式启用时只能连接 controlled Provider，宿主仍只监听 loopback。
- 全新受控实例从零余额启动，不预发测试积分；现有未启用实例继续保留原行为。
- 不可变入金条款、随机 challenge、独立 `Payment-Authorization`、签名验证及底层 payment ID 防重。
- 同一 PostgreSQL 事务保存证明、消费身份、原现金分录、原账户余额和原 Redis mutation outbox；原资金触发器保持启用。replay/restart 通过原 cache reconciliation 恢复。
- 同一 buyer 的一笔受控入金可支付多次现有原生 Market 采购；不创建第二个可花用钱包。
- 持久 ProcurementIntent、报价 revision 与历史、CAS 更新、操作幂等、绝对时间阶梯调价、deadline 和取消。
- 手动报价修改会设置 `manual_override=true`；后续 tick 不再自动提高该 intent 的报价。当前没有恢复自动模式的接口。

**自动撮合接纳、任务预算占用、竞价器自动 dispatch、真实支付、退款和浏览器接线尚未启用。** 报价响应明确返回 `admission_enabled: false` 和 `provider_dispatched: false`；创建/调价/取消报价不产生 Provider 调用。后续需在 owning source 接上 spec 第 9 节要求的接纳、资金和任务授权事务，不能把当前报价状态直接变成执行许可。

## 运行受控验收

需要 Rust、Node、Python 3、PostgreSQL 及 Redis 命令行工具。脚本创建并清理自己的 loopback PG/Redis、测试 authority 和原生 seller，不接管现有服务，不使用真实资金或外部推理。

```bash
bash scripts/accept-market-mpp.sh \
  --evidence /tmp/private-market-mpp-evidence.json
```

脚本覆盖零余额、默认关闭、认证隔离、402、签名和 challenge 篡改、并发重呈、同一付款跨 intent 防重、原账本/outbox、多次原生采购、报价 CAS/幂等/上限/调价/取消及进程重启。

## 启用条件和身份

只在全新测试实例初始化前设置：

```text
PRIVATE_MARKET_MPP_TEST_API=1
PRIVATE_MARKET_MPP_TEST_PUBLIC_KEY=<32-byte Ed25519 public key in hex>
```

公钥在初始化时写入受控配置，serve 时必须匹配。不能通过重启更换付款 authority，不能在已有测试积分实例中补装该 schema，不能与 live Provider 同时启用。私钥仅由测试脚本的临时 authority 持有，不存入宿主配置或返回给客户端。初始化生成的原 buyer bearer token 继续拥有账户归属；付款 `source` 不授予身份。

状态与出入金记录命名为 `controlled_*`，明确区别于待实施的真实钱包。`funds` 返回原账本现金余额、原 Market 推理预占与扣费、累计受控入金及守恒检查；不会把另算的余额作为采购权威。

## API 合同

各写入 JSON 金额采用无前导零的正十进制字符串。入金上限为单笔 `10000000` microUSD 测试额度。所有资源按认证 buyer 隔离；请求不允许 query 或 namespace 覆盖。

| API | 本批行为 |
| --- | --- |
| `POST /market/v1/funding-intents` | `Idempotency-Key` + `{"amount_micro_usd":"10000"}` 创建条款；同 key 改金额冲突 |
| `GET /market/v1/funding-intents/{id}` | 查询原条款、入账及 projection 状态 |
| `POST /market/v1/funding-intents/{id}/pay` | 未付时 402；原 Credential 验证后入账；已付时返回原结果，不再要求付款 |
| `GET /market/v1/funds` | 查询原账本及该 buyer 的受控资金审计视图 |
| `POST /market/v1/procurement-intents` | 创建固定原生需求与阶梯报价；不占用现金或供给 |
| `PATCH /market/v1/procurement-intents/{id}/bid` | 幂等 key + `expected_revision` + `provider_cap_micro_usd`；CAS 成功后暂停自动调价 |
| `POST /market/v1/procurement-intents/{id}/tick` | 幂等 key + `expected_revision`；按数据库绝对时间推进计划，未跨步长不新增 revision |
| `POST /market/v1/procurement-intents/{id}/cancel` | 幂等 key + `expected_revision`；关闭未接纳报价 |

到期只能关闭/查询，不延长授权；创建接口的原 key 在到期后仍能查询原资源。持久配置变化、数据库/Redis 不可用或入账确认丢失时不得在客户端生成新付款。受控方法不产生实际款项；真实方法所需的迟到款负债、proof pending、退款及现金新鲜性验收仍需实施，不以本批替代。

测试 Credential 的 payload 为 `{receipt, signature}`。receipt 的字段顺序和签名域由 `procurement/funding.rs` 的版本化类型与 `SIGNING_DOMAIN` 固定；签名只用于受控 fixture。生产方法必须另行定义和审查完整的可信证明与 canonical settlement identity。
