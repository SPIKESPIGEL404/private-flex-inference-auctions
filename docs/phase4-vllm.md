# 阶段四：本地 scheduler + Chutes 原生 vLLM

本阶段把真实 GPU 推理放在已有的私有 Chutes 副本，本机只运行 Rust scheduler、journal/spool、签名合成计划和独立本地 durable sink。BitRouter 的接口设计与接入仍为阶段五。

当前固定配置与合成负载已验收，见 [实际验收报告](acceptance/2026-11-02-phase4.md)、[校准 profile](acceptance/phase4-runtime-profile.json) 和 [独立审计](acceptance/phase4-audit.json)。

## 组件与协议

```text
本地：签名 fixture → scheduler → 物理 spool → 本地 durable sink / ACK
                         ↓ HTTPS + Bearer
Chutes：固定实例启动身份的入口 → 原生 vLLM → GPU
```

- [vllm.rs](../src/vllm.rs)：固定 HTTPS origin、敏感 Bearer header、有界控制响应、profile/session 核对与真实 runner。
- [mock_http.rs](../src/mock_http.rs)：复用既有单写入者、stream reader、持久化确认与无自动重试的派发循环。原 MockHttpRunner 仍只允许 loopback。
- [部署入口](../deploy/chutes/chute.py)：保留官方模板的原生 vLLM 启动，提供受 Chutes 私有认证保护的 scheduler 专用 Cords；未修改 vLLM Scheduler、EngineCore、KV 管理或 GPU worker。
- [真实验收程序](../examples/phase4_chutes.rs)：使用公开测试签名种子，只适用于合成验收，不是 BitRouter 授权实现。

### 固定配置与 epoch

`VllmProfile` 绑定模型 revision、镜像 ID、实测 vLLM 包版本、engine args 摘要、tokenizer 文件摘要、chat template 摘要、GPU 类型、输入/输出/结果空间限制与后端并发上限。镜像的 tag 不等于 vLLM 的包版本；两者分别记录。

整个 profile 的摘要进入 `scheduler_policy_version = external-gate-v1-<profile_digest>`，随计划签名和 journal config 一起固定。仅 tokenizer 相同不足以接受不同的镜像、引擎版本或启动参数。不能在重开时自动接受新配置。

每次远端启动生成新的随机 `engine_epoch`。Runner 在派发前后核对 profile/session，每条生成流还必须以 `flex.identity` SSE 事件绑定 epoch、完整 profile 摘要和原 ExecutionBinding 摘要。缺失、重复或不匹配的身份事件在任何 token 进度生效前被拒绝；未知执行保持 UNKNOWN，不重发。

首个可信生成/终止消息必须回显与冻结输入完全相同的 `prompt_token_ids`。生成 IDs、response ID、模型、choice、输出上限、终止、最终 usage、DONE 和正常 EOF 继续由既有有界解析器核验。普通文本、控制身份事件和响应头都不能开门。

### Chutes 网关边界

Chutes 的标准 vLLM 路由会强制改写 model 和 `continuous_usage_stats`，而已有副本的分类不会随源码更新切换。因此保留其分类和模块锁定，使用 **外层平台路由信封 + 内层冻结 ExecutionRequest**：允许平台处理外层 model/stream/usage 路由字段；它们绝不直接作为推理参数。

原生 `/v1/chat/completions`、`/v1/completions` Cords 不对外注册，只开放 `/scheduler/completions`。入口验证内层完整请求摘要、epoch/profile/原身份绑定和限制，从已验证的冻结请求构造全部原生 vLLM 参数，显式关闭 continuous usage。客户端增加的未知推理参数不接受；token IDs、sampling、namespace、输出上限和 request ID 不会被平台的外层改写替代。该边界有独立 Python/Rust 契约测试。

同一 boot 内的 execution ID 至多接纳一次；去重集合和 trace 都有 1024 项上限，满时拒绝新增，运维核对并重启后换 epoch。它不是 GPU durable exactly-once：跨 boot 的旧 envelope 由 epoch 不匹配拒绝，原 intent 的不确定性仍由本地 journal 和恢复协议处理。

专用入口只能约束其支持的协议；持有提供商管理/调用凭据的操作者仍必须遵守“仅一个 scheduler、没有旁路提交”的部署条件。Fixture 签名和 Chutes Bearer 认证不能替代未来 BitRouter 的生产授权或 TEE attestation 验证。

## 本地检查

无需本机 GPU 或模型权重。Python 只需 Chutes SDK 来检查部署/请求契约：

```bash
# 在独立 Python 环境安装 deploy/chutes/requirements.txt。
CHUTES_PYTHON=/path/to/chutes-venv/bin/python bash scripts/accept-phase4.sh
```

默认脚本只运行本地 Rust/Python 检查，不启动或调用付费 GPU。HTTPS 客户端禁止 redirect、重试、proxy 和跨实例 fallback；不关闭证书校验。HTTP 错误不会被推断为未执行。

## 更新已有副本与等待就绪

```bash
# 先准备并检查生成的 request.json / before.json：
/path/to/chutes-venv/bin/python deploy/chutes/manage.py \
  --key-file /private/path/chutes.key --output /tmp/chutes-update
# 已授权更新后，明确应用；固定现有 chute ID，accept_fee=false：
/path/to/chutes-venv/bin/python deploy/chutes/manage.py \
  --key-file /private/path/chutes.key --output /tmp/chutes-update --apply
```

工具固定为现有私有副本、单 RTX PRO 6000、最多一个实例，保留原 $2.25/GPU-hour 选择上限；这是配置/报价约束，不是实际账单。更新采用 recreate，会有冷启动。管理 API 接受更新、硬件 verified、实例 active 和 profile 可读是四个不同事实；只有 profile 就绪并通过完整校验后才提交推理。

密钥从仓库外文件读取，不放入 URL、部署源码、journal、运行报告或命令行参数值。命令只传凭据文件路径。本地客户端的控制重试仅限等待就绪的读取，生成 POST 从不自动重试。Chutes 内部转发次数不由此客户端控制；入口在同一 boot 内去重 execution ID，向其他 boot 的重放由 epoch 不匹配拒绝，不能把客户端一次 POST 等同于已经证明平台只转发过一次。

## 真实校准与结果交接

以下命令会使用真实 GPU，需明确的运行授权和有效凭据：

```bash
cargo run --locked --example phase4_chutes -- \
  --key-file /private/path/chutes.key --out /new/private/run-directory --mode accept
```

程序使用远端固定 tokenizer/chat template 生成最终 token IDs，签署完整计划，分别以 1、2、4 在途请求各执行三轮四请求测试，再测试相同/不同 cache namespace。每轮验证：

1. 输入 IDs、原 execution/request 绑定、逐次门控与完整结果；在引擎侧 trace 中，下一请求 admission 晚于前一请求生成或终止。
2. 本地 journal 的在途峰值不超过限制；同时采集原生 running/waiting、KV/cache、usage 和 latency 指标，独立验证 GPU 请求确有重叠。
3. 短请求 B 在长请求 A 结束前完成；不能仅用客户端缓冲造成的时间差证明 GPU 并发。
4. 结果文件完整后才 RESULT_DURABLE，独立 sink 文件与目录同步后才 ACK，再清理；重复 ACK 不重复提交事件。
5. 重开进入 Recovery、原 intent 不再次 POST、sink 在本地 spool 清理后仍可读取。

也可显式选择 CPU fixture 输入：先用 `wait_ready.py --key-file ... --session /new/session.json` 取得本次 boot，再使用独立环境安装 `requirements-tokenizer.txt`，运行 `render_prompt.py --session /new/session.json --output /new/prompt.json`，最后向验收程序传 `--prompt-file /new/prompt.json`。Renderer 只下载固定 revision 的两个 tokenizer 文件，核对与远端相同的文件摘要和 chat template 摘要；保存渲染参数与来源，不下载模型权重。Fixture 绑定完整 profile 和当次 epoch，换 boot 后必须重新确认，不能自动沿用旧 epoch。

运行目录必须全新，权限 0700，结果与配置文件使用 0600；失败后保留原 journal，不覆盖、不复用 execution ID 来重试推理。API token 不进入这些文件。输出只包含合成数据的绑定、摘要、usage、计数和指标。

测量分别记录计划登记与派发、派发到首 token 接收、首进度持久化、下一派发、终止与协议完成。客户端时间包含 HTTPS/网关/网络和本地持久化开销；引擎原生指标单独保存，不能冒称 GPU kernel 时间或精确 prefill-complete 时间。

校准结果只支持实测镜像、GPU、请求长度、输出长度和参数范围；不因此承诺所有 32K 请求、更多并发、生产吞吐或 TTFT SLA。

完成后可独立核对证据并汇总测量：

```bash
/path/to/chutes-venv/bin/python scripts/audit-phase4.py \
  --run-dir /private/accept-run --recovery-dir /private/recovery-run \
  --output /new/private/audit.json
python3 scripts/summarize-phase4.py \
  --run-dir /private/accept-run --output /new/private/calibration.json
```

审计脚本不调用服务：独立核对 Ed25519 授权、配置/请求/manifest 摘要、journal 哈希链和门控先后，再以持久化 sink 的文本、原 token deltas 与 checkpoint 重建每个 spool 前缀及完整 artifact；核对 ACK/cleanup 次序，并独立解析保存的 Prometheus 文本。恢复证据摘要必须对应 journal 的原 epoch fence。它不验证 TEE quote，也不能独立证明管理平台的声明。

汇总把首进度事件进入 reader 后的队列/spool/journal 时间、门控后的容量等待、容量满足到派发间隔分别列出；commit 时间来自单写入者完成提交的时刻，未把 worker 收到 ACK 的调度延迟当作实际 commit。

## 真实中断与恢复验收

```bash
# 等首进度已持久化后，取消原真实连接；保留 UNKNOWN 与预算：
cargo run --locked --example phase4_chutes -- \
  --key-file /private/path/chutes.key --out /new/private/recovery-run --mode interrupt

# 显式运维操作：关闭旧 admission，核对 native running/waiting=0，
# 用 owner API 暂停此私有单实例 Chute，确认旧 instance 已移除，
# 再启用并等待不同的新 verified instance 和 boot epoch：
/path/to/chutes-venv/bin/python deploy/chutes/restart.py \
  --key-file /private/path/chutes.key --run-dir /private/recovery-run \
  --evidence /new/private/isolation.json

# 绑定证据关闭原 UNKNOWN，再仅派发原 next-unsent：
cargo run --locked --example phase4_chutes -- \
  --key-file /private/path/chutes.key --out /private/recovery-run --mode resume \
  --isolation-evidence /private/isolation.json
```

Seal 是本次 boot 的永久关闭，不提供重新开放接口。旧实例 native idle、入口已关闭和管理平台报告旧 instance 已移除共同构成受信运维证据；新健康检查本身不够。SDK 的断流 producer 可能仍保留前端 active bookkeeping；工具如实记录该字段，不据此捏造执行终止，以实际旧实例移除作为隔离前置条件。`/instances` DELETE 属于 miner API，因此使用已验证只有一个实例的私有 Chute 的 owner disable/enable 操作。重启工具不会重发推理；若操作或响应不确定，检查平台现状及 `.prepared.json` / `.removed.json` 后再处理，不盲目重复。

替换期间必须最终只剩一个实例，包括 pending 实例也不能额外存在；profile 前后均核对同一唯一实例。若暂停/启用已完成而就绪等待中断，核对 `.removed.json` 后，可在同一命令追加 `--wait-replacement` 只恢复读取等待；它不会再次 seal / disable / enable。额外实例、profile 漂移或旧实例重新出现时保持本地 Recovery，不派发剩余请求。

这些证据仍依赖 Chutes 管理面和调用通道的可信性，不是本程序验证过的 GPU/TEE 硬件关闭证明。权限不足、无法 drain、旧实例未移除、profile 漂移或新实例未 ready 时，本地 scheduler 必须保持 Recovery。

更完整的操作原则见 [恢复 runbook](runbooks/scheduler-recovery.md)。
