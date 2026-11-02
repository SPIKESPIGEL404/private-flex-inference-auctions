# 阶段三：有界结果 spool 与持久化交接

状态：已实现并本地验收。基线为阶段二提交 `085a09b`；对应 [spec 13.1 第 3 项](specs/2026-11-02-external-prefill-gating-scheduler.md)。[验收报告](acceptance/2026-11-02-phase3.md)、[恢复 runbook](runbooks/scheduler-recovery.md)。

```bash
bash scripts/accept-phase3.sh
# 单独运行 walkthrough，路径必须全新：
cargo run --locked --example phase3_spool -- --db /tmp/fresh-phase3/journal.sqlite
```

这是本地 Rust API、loopback mock HTTP 和本地文件存储。真实 pinned vLLM、GPU、tokenizer 空间校准与性能属于阶段四；实际 BitRouter 认证/transport 留待阶段五先讨论对齐，再实现。Auction、VCG、资金与 settlement 仍由 BitRouter 拥有。

## 创建与恢复

```rust,ignore
let policy = SpoolPolicy {
    acknowledged_retention_ms: 60_000,
    max_artifact_bytes: 1_048_576,
    max_physical_bytes: 67_108_864,
    max_owner_physical_bytes: 16_777_216,
};
let mut scheduler = Scheduler::open_with_spool(db_path, config, policy)?;
scheduler.reconcile_spool(verified_freshness_evidence)?;
scheduler.activate(verified_activation_evidence)?;
```

所有 open 都记录 `SESSION_OPENED`，进入 `RECOVERY_REQUIRED`。启用 spool 的 journal 每次重开都必须经过本次进程的 `reconcile_spool` 才能激活；用 metadata-only `open` 不能降级绕过此约束。Spool 配置与配置摘要同时绑定于 journal 和文件目录，不允许重开时偷偷改变配额或保留窗口。

阶段四的真实 vLLM 适配及阶段五的 BitRouter 服务适配均必须使用 `open_with_spool`；metadata-only `open` 保留给历史元数据核对和阶段一、二的限定验收。

阶段一、二 journal 仍可读取与重放。已提交过执行但没有实际结果文件的旧 journal **不能启用 spool 并补称结果可靠**；应保留旧实例供核对，在阶段五对齐 BitRouter 连续计划流后使用新的执行流/配置；阶段四的真实引擎验收使用独立的新 fixture 执行流。全部请求仍为 UNSENT 的旧 journal 可在兼容 profile 下启用 spool。已存在绑定的 spool 不能被没有对应 journal policy 的新数据库自动接管；缺失 root/binding 也拒绝自动重建。

## 空间与文件格式

对于请求声明的逻辑上限 `R = max_result_bytes`：

```text
slot capacity = R
physical reservation = ceil(R / 4096) * 4096
artifact bytes = 40 + Σ(8 + UTF-8 delta bytes + 4 * delta token count) + 32
```

文件名为执行身份的 SHA-256，目录默认为 `<canonical-db-path>.spool`，而不是由外部输入提供路径。目录权限 0700，文件权限 0600，另有独占 writer lock；拒绝 slot/root symlink、非普通文件、未知目录项、绑定不一致与摘要不一致。

| 部分 | 内容 |
| --- | --- |
| Header，40 字节 | `FLEXR01\n` + 完整 ExecutionBinding 的 32 字节摘要，包含 epoch、plan/manifest、grant、execution、request digest。 |
| Delta record | 文本长度 u32、小端 token 数 u32、UTF-8 文本、各 token 的小端 u32。重复 token 与空文本都保留。无 token 的终止信号不添加空 record。 |
| Footer，32 字节 | 三个 usage u64 + record 数 u64，小端编码。 |
| Artifact digest | 对 header + 有效 records + footer 的原始字节计算 SHA-256；不包含预留尾部填充。 |
| `artifact_ref` | `spool:<execution-key-hash>`，是 opaque 引用；内容摘要另在 `digest` 中。 |

`fs2::FileExt::allocate` 在 macOS/Linux 申请实际空间，检查实际分配字节必须等于 4096 对齐的预留量；仅 `set_len` 或稀疏文件不算预留。其他 OS 或分配粒度不兼容的文件系统拒绝派发。本次实际验收平台是 macOS/APFS；Linux 后端未在本次运行。

逻辑配额与物理 slot 配额分别有全局和逐 owner 限制，仍只考察队首，不跳过大请求。`Capacity` 同时报告 `reserved_spool_bytes`、`physical_spool_bytes` 及对应 owner 汇总。已终止请求释放在途/context 预算，但完整、未 ACK、已 ACK 尚未清理的 slot 都继续占额度。清理完成后才释放；不会按实际短输出提前缩小预留。

物理配额计算的是 slot 数据分配，不包含 SQLite/WAL、目录/inode、文件系统快照/复制开销和 mock sink。部署需为这些开销独立留空间；此配额不是整个进程磁盘使用量的上限，也不能保证 COW 文件系统后续写入永不 ENOSPC。Journal 的历史元数据目前没有归档/裁剪。

单 artifact 上限可配置在 72 B 至 64 MiB 之间。启用时要求 profile 的 per-token 开销至少为 12 B、固定开销至少为 72 B；这只是编码最低要求。真实 tokenizer 的最大文本展开、输出上限、单 token 多字节文本和编码开销仍须保守校准，不能把最低值当作生产上界。实际越界被明确标为结果不可用并停派，不静默截断已授权输出。

## 写入、门控与完整结果

```text
allocate + header write + file sync + directory sync
  → durable DISPATCH_INTENT
  → one HTTP POST
  → validate whole SSE event
  → append text/token IDs + file sync
  → atomic journal checkpoint + gate/terminal observation
  → complete terminal + usage + DONE + normal HTTP EOF
  → STREAM_FINISHED(COMPLETE_PROTOCOL)
  → write footer + file sync
  → RESULT_DURABLE(binding, digest, usage, artifact_ref)
```

`CompletionDecoder` 只在整个事件有效后交出文本与 token delta；worker 等单写入者确认，再继续处理观察。`observe_delta` 在改文件前先验证 core 状态转换；同 observation 的重放还核对文本摘要，冲突会锁存完整性故障。无效迟到数据不会覆盖已完成的文件。

Journal checkpoint 记录已提交前缀的长度、摘要、records、token/text 数。文件中超过该前缀的写入不能开门或补充 usage。崩溃后只核对已提交前缀；协议摘要完整且 terminal 的 Pending 结果可由本地前缀重新生成 footer 与 `RESULT_DURABLE`，不重新 POST。

| 状态 | 含义 |
| --- | --- |
| `PENDING` | 结果尚无完整持久化证据；即使执行已终止也可能停在此处。 |
| `DURABLE_COMPLETE` | 终止、usage、DONE、正常 EOF、完整文件与摘要均已确认。 |
| `HANDED_OFF` | 匹配结果已由可信接收端确认可靠存储。 |
| `UNAVAILABLE` | 结果失败/丢失/隔离关闭；不等于执行从未发生。 |
| `cleanup_complete = true` | 本地文件删除已同步，journal 确认完成并释放预留；保留原结果/ACK 元数据。 |

文件写入、sync、读取校验或上界失败会记录 `STORAGE_FAILED`、结果不可用并停派。Journal 仍可用时继续读取原 stream、记录真实 terminal；若 journal 也写失败，则 handle poisoned，停止使用并按 runbook 核对，不能承诺继续持久化终止证据。

当前逐 delta 同步并重新校验前缀，存在 I/O 与累计校验成本。本阶段没有生产吞吐/TTFT 或掉电耐久性承诺；目标存储和 GPU 性能在后续校准。

## 读取、ACK 与清理

```rust,ignore
let artifact = scheduler.get_result_artifact(execution_id, trusted_owner_ref)?;
// BitRouter adapter 在自己的 durable sink 写入 artifact + usage + digest，
// 同步/提交后生成持久化的 sink_receipt_ref。随后：
scheduler.ack_result(execution_id, trusted_owner_ref, &artifact.metadata.digest,
                     sink_receipt_ref, trusted_now_ms)?;
scheduler.collect_results(trusted_now_ms)?;
```

`ResultArtifact` 返回原 ExecutionBinding、完整文本、token IDs、usage 和摘要；每次读取校验全部文件。错误 owner 被拒绝。Artifact 刻意没有 Debug 实现，公共事件不带输出文本/token IDs。

这些 API 供可信适配器调用。`owner_ref` 相等是隔离检查，**不是身份认证**；sink receipt 是可信接收端的持久化声明，本地库不能独立证明 BitRouter 的存储已经提交。阶段五必须把调用身份、owner 映射、receipt 校验和服务端时钟绑定到实际 BitRouter 通道；阶段四仍以独立 durable mock sink 验证交接。

同 execution/digest/receipt 的 ACK 幂等；冲突摘要、owner 或 receipt 不接受，重复 ACK 不延长原 `cleanup_after_ms`。失去 ACK 响应时可以重读并重放同一 receipt，不再次推理。默认没有未 ACK TTL、静默 eviction 或后台删除；停止消费时，以持久化事件和 `Blocked` 容量结果向集成层暴露背压，告警投递由后续服务集成承接。

ACK 后到达固定保留窗口时，显式调用 `collect_results(now_ms)`：

```text
journal CLEANUP_STARTED
  → unlink slot + sync directory
  → journal RESULT_CLEANED
  → release logical + physical reservation
```

若删除后最后的 journal 提交失败，额度仍保留；重开根据已持久化 cleanup intent 幂等完成。文件删除不代表物理介质安全擦除；journal 内的历史私有 token IDs/元数据仍受原访问控制与保留政策管理。

缺 usage/DONE 等已终止的不完整结果不自动作为完整结果读取或清理。受控运维可先 `declare_result_unavailable(execution_id, evidence_ref)`，记录已核对的丢失事实，再 `discard_unavailable_result`。UNKNOWN 必须取得真实 terminal 或旧 epoch 的有效隔离证明，才能关闭执行责任并清理。

## 代码与测试

- [spool.rs](../src/spool.rs)：本地存储、实际空间预留、固定文件编码、完整性校验和本地故障注入。
- [results.rs](../src/results.rs)：checkpoint、reconciliation、完整结果、owner 约束、ACK 与可恢复清理。
- [state.rs](../src/state.rs)、[journal.rs](../src/journal.rs)：纯状态转换、配额和原子 journal；新增 None 字段不改变旧编码。
- [phase3.rs](../tests/phase3.rs)：实际文件/HTTP、ENOSPC/sync/DB 故障窗口、进程退出、ACK 丢失、损坏和配额回归。
- [旧阶段二 journal](../fixtures/phase3/README.md)：从独立构建的 `085a09b` 捕获的原始记录，验证读取兼容性。
- [phase3_spool.rs](../examples/phase3_spool.rs)：独立 mock sink 同步后 ACK、清理、背压恢复及重开零重发。
