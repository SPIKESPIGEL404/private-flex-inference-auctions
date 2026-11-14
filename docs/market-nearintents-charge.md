# 标准 NEAR Intents charge 入金

本实现使用官方 `@defuse-protocol/nearintents-mpp-sdk@0.4.1` 的 `nearintents.charge`，搭配其 peer 版本 `mppx@0.17.0`。支持标准 `method=nearintents`、`intent=charge`、源链交易 hash Credential 和带源/目标交易引用的 Receipt；不使用 Agent API 私密回执替代标准凭证。

Rust 宿主继续负责应用认证和资金查询；Node stdio 适配器调用官方方法。买方认证仍放在 `Authorization: Bearer`，MPP Credential 使用 Challenge 指定的 `Payment-Authorization`。SDK 服务只在宿主派生的私有子进程中运行，没有公开的内部验款接口，也不持有买方钱包私钥。

## 资金与恢复

- FundingIntent 固定 buyer、金额、支付配置和随机资源身份。相同 key 的不同金额被拒绝。
- 额度取目标链 `EXACT_OUTPUT` 的已验证金额；源链金额保留其原始精度，不以浮点市价换算。当前仅支持六位精度目标资产、单笔最多 10,000,000 microUSD 的试点报价。
- SDK 的 quote cache 按 FundingIntent 隔离；deposit/hash 防重仍为全局。不同买方充值同一金额不会共享地址或 externalId。
- SDK 的 atomic store、付款消费、原 `credit_accounts`/`credit_ledger_entries` 入账、原 Redis outbox 和 MPP Receipt 在**同一个 PostgreSQL 事务**内提交。没有第二个可花用余额，也不修改原资金触发器。
- Credential 验证前另写入持久尝试日志；验款/现金事务回滚后仍可取得原证据。账本故障会同时回滚 SDK 的 consumed 状态。
- COMMIT ACK 丢失、重复凭证和重启都恢复原资金记录。SDK 已完成的付款不会因再次验证 spent quote 而失去入账结果。
- SDK 暂不可用/超时可用原证明重试；失败、退款和少付不入账。发生过付款尝试的资源不再返回新的 402，引导客户端再次转账。
- `/reconcile` 可重呈原 Credential，或使用本资源已保存的最后一份证明，在原有效期内重新验证。过期或异常结算保留 `reconciliation_required`，**尚无自动退款或跨过期窗口的自动入账**。

一次验款为保持 SDK 状态和现金的原子性，会在最长 120 秒结算预算内持有该用户的资金 fence；不同用户仍可独立工作。当前按需启动 Node 子进程，每宿主最多 4 个并发适配操作，150 秒进程截止。生产容量与长期运维尚未验收。

## 配置

先在 `services/mpp-nearintents` 执行 `npm ci --ignore-scripts --no-audit --no-fund`。开启新实例前设置：

```text
PRIVATE_MARKET_MPP_METHOD=nearintents
PRIVATE_MARKET_MPP_NEARINTENTS_CONFIG=/absolute/path/to/public-payment-config.json
MPP_SECRET_KEY=<至少 32 字符的服务端随机密钥>
```

`ONE_CLICK_JWT` 为可选的服务端 1Click 凭证。费用以真实报价为准。上述配置不能与 `PRIVATE_MARKET_MPP_TEST_API` 同时启用。

公开支付配置示例：

```json
{
  "mode": "live",
  "originAsset": "near:mainnet/nep141:wrap.near",
  "destinationAsset": "near:mainnet/nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "destinationRecipient": "<verified merchant NEAR account>",
  "refundTo": "<verified payer NEAR account>",
  "realm": "private-market",
  "expiresWindow": 300,
  "settlementTimeout": 120,
  "pollInterval": 2000
}
```

正式配置只允许官方 `https://1click.chaindefuser.com`；`mode=controlled` 必须显式指定 `http://127.0.0.1:<port>` 的受控 backend，且不能配合 live Provider。配置及服务端 secret 的摘要在初始化时固定，改变时拒绝启动/操作，不能把已有款项重新解释成新商户或新资产。启动核验先于 Market 工作线程；拒绝启动时关闭数据库的后台任务，避免等待已启动的资金或执行工作线程退出。

支持全新、从零余额初始化的试点实例；尚无给旧测试积分数据库自动补装真实支付的迁移。Node 服务文件和锁定依赖须随宿主部署；容器中可通过 `PRIVATE_MARKET_MPP_NEARINTENTS_BRIDGE` 指定绝对入口路径。原机密部署/身份验收不自动覆盖新镜像与配置。

当前 live 试点仅向宿主第一名固定 buyer 开放资金入口，匹配其已验证的固定退款地址；其他 buyer 在资金 API 被拒绝。受控模式可测试多 buyer 隔离。开放多名真实买方之前，必须补上逐 buyer 的钱包/退款地址认证和冻结，不能让多个买方共享一个静态退款目的地。

## 验收与客户端

```bash
bash scripts/accept-market-nearintents.sh \
  --evidence /tmp/private-market-nearintents-evidence.json
```

该命令使用官方服务端和客户端 SDK、真实 PG/Redis、受控 1Click 与受控原生 seller；不签署链上交易，不转移真实资产。结果见[验收记录](acceptance/2026-11-13-nearintents-charge.md)。

`services/mpp-nearintents/client.mjs` 的 `presentDeposit` 接收**已经发送**的交易 hash 和显式支付 policy，通过官方客户端提交证明。它不持有密钥、不发起第二笔转账，并禁用 redirect。非 EVM 来源可由买方自己的受限 signer 发送存款，再提交 hash；试点尚未把 NEAR signer 接进浏览器/fx。

无资金报价检查：

```bash
node services/mpp-nearintents/preflight.mjs /absolute/path/to/public-payment-config.json 10000
```

它只请求官方 token 列表和 `dry: true` 的 EXACT_OUTPUT 报价，不生成存款地址，不签名或发送资产。真实 402 报价也已进行无转账预检；历史预检的临时地址及本地数据库不能用于之后付款，正式试点必须在持久宿主中重新准备报价。

## 仍保留的边界

正式资产/费率/退款政策仍需作为产品合同冻结。未消费平台额度退款、到期付款异常恢复、商户资金对账和真实外部客户 onboarding 未完成。当前动态 bid 仍为成交前状态基础，不自动接纳/派发。不能把本次入金验收扩大成私密竞价、自动成交或生产资金上线的完成声明。

协议来源：[官方方法文档](https://mpp.dev/payment-methods/nearintents)、[官方 SDK](https://github.com/defuse-protocol/nearintents-mpp-sdk)、[1Click 报价 API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)。
