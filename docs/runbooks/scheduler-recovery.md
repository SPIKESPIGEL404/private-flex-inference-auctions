# Scheduler 恢复 runbook

适用：单写入者、单目标引擎、有序计划流和本地阶段三 spool。所有 evidence refs 都是可信运维的外部证据关联；API 不会自行隔离真实 vLLM、验证 TEE、证明状态新鲜度或检查金融状态。阶段四先结合固定 vLLM/目标 GPU 验证引擎隔离与恢复步骤；阶段五讨论 BitRouter 适配后，再对齐真实计划、事件和结果交接恢复。

## 1. 立即停止新增提交并保存证据

1. 正常 handle 可用时调用 `pause(evidence_ref)`；runner 中断或 storage/transport 故障已记录停派时，确认 `mode = RECOVERY_REQUIRED`。Journal 写失败的 handle 为 poisoned，停止使用。
2. 隔离旧 scheduler writer，确认进程/入口不会继续提交；不要与旧进程同时打开第二个可写实例。新开 journal 会再次要求恢复，文件锁不能代替跨主机 writer 隔离。
3. 保持尚存的健康原 stream 收集；缺少可信 terminal 的执行保持 UNKNOWN 和预算。不得因 HTTP 断开、过期、退款、文件删除或买家断线就改成 UNSENT。
4. 保存 SQLite 数据库及其 WAL、配置、spool 的一致恢复材料；不要只拷贝一个运行中的 `.sqlite` 主文件，不要删除 WAL，不要手工编辑摘要、状态或游标。避免把私有内容输出到公共日志。

## 2. 核对状态新鲜度与旧引擎

1. 用部署认可的 freshness/anti-rollback 机制确认 journal、spool、已发布计划、已消费事件与 BitRouter receipt 属于同一当前执行历史。文件 hash chain 只检查内部一致性，不能证明整套快照未被回滚。
2. 列出原 `(plan_id, execution_id, request_digest, engine_epoch)` 的 dispatch intent、gate、terminal、stream report、result、ACK 和 cleanup 事件。已有 intent 永远不重发 POST；缺 intent 才可能仍为 UNSENT。
3. 若存在 UNKNOWN，先尝试获取原执行的可信 terminal；无法取得时，真实停止并隔离旧 epoch 的进程、GPU worker 与入口，确认它不可能继续接受/完成旧提交。
4. 仅在实际隔离证据成立后调用 `record_epoch_isolation(old_epoch, evidence_ref)`。此方法只记录声明，不执行 kill/fence。它关闭原执行责任并将不能恢复的结果标为 UNAVAILABLE；迟到观察只追加为 late evidence。

## 3. 重开与 spool reconciliation

```rust,ignore
let mut scheduler = Scheduler::open_with_spool(db, approved_config, approved_spool_policy)?;
// 此时仍 RECOVERY_REQUIRED，禁止将 replayed intent 发往网络。
scheduler.reconcile_spool(verified_spool_freshness_ref)?;
```

`reconcile_spool` 按以下顺序执行：

1. 完成已有 `CLEANUP_STARTED`，缺文件的 unlink 幂等，目录同步后提交 `RESULT_CLEANED` 才释放额度。
2. 移除没有任何已提交 intent 引用的孤立 slot；不会将它们推断为一次已提交推理。
3. 核对未清理的已提交前缀或完整 artifact，包括原身份、epoch、长度、record 数和摘要。未知目录项、symlink、绑定/配置不匹配都停止流程。
4. 对 terminal + COMPLETE_PROTOCOL + Pending 的执行重新生成 footer，并提交缺失的 `RESULT_DURABLE`；整个过程只读写本地结果，不执行网络推理。
5. 提交 `SPOOL_RECONCILED`；这只满足本次进程的存储前置条件，还未激活派发。

| 发现 | 操作 |
| --- | --- |
| 文件缺失/损坏、prefix 不匹配 | 保留恢复状态和原配额，记录 UNAVAILABLE；核对实际执行状态并把结果丢失事实交给 BitRouter。不可重试推理来“补文件”。 |
| 已记 UNAVAILABLE 且已 terminal/fenced | 用 `discard_unavailable_result(execution_id, evidence_ref)` 显式清理，再重新 reconcile。该操作不表示收费/退款。 |
| 已 terminal，但缺 usage/DONE/EOF | 不发布 RESULT_DURABLE；核对后用 `declare_result_unavailable` 记录关闭，再按上一行清理。不能为 UNKNOWN 调用此关闭来绕过隔离。 |
| 已 ACK 但保留窗口未结束 | 继续保留本地文件；在可信当前时钟达到原 deadline 后 collect。重复 ACK 不改变 deadline。 |
| 完整结果尚未 ACK | 继续占 spool，交接可重放；不按结果年龄删除。 |
| bound spool 缺失，或 marker 存在却没有 journal policy | 不自动重建/接管。恢复经过 freshness 验证的一致 journal + spool；不能只创建空数据库。 |
| 首次启用时，marker 已同步而 SpoolEnabled 提交失败 | 属于初始化未完成。确认 journal 从未启用/派发、目录只有 marker/lock、旧 writer 已隔离且状态新鲜后，由受控运维归档该空初始化目录，再重新启用；库不会自动删除 marker 或接管旧目录。 |
| 持续 ENOSPC/同步失败 | 保持停派；修复存储余量/故障后重开核对。不可通过调大 quota、丢弃未 ACK 完整结果或清空 journal 强行恢复。 |

无法证明一致新鲜状态时保持停止。不要把删除 marker/数据库视为通用修复方法。

## 4. 重放交接

1. BitRouter 按原事件游标重放：同事件 ID 去重，与执行责任、结果 ACK 分开处理。公开事件不得用来重新构造已有 POST。
2. 对 `DURABLE_COMPLETE` 调用 `get_result_artifact`；原 owner/执行绑定、完整性校验通过后，将完整 artifact/usage/digest 提交到 BitRouter 的可靠存储。
3. 接收端可靠提交后，重放同一 `(execution_id, digest, sink_receipt_ref)` ACK。ACK 已提交但响应丢失时返回 AlreadyRecorded；ACK 未提交时仍由 scheduler 保留输出。
4. 到保留窗口后 collect；核对 CleanupStarted/ResultCleaned、文件与额度。执行完成和结果已交接都不会重排后续计划或触发金融动作。

## 5. 激活与验收

1. 确认旧 writer/engine 隔离、所有执行责任已核对、spool reconciliation 成功、源计划连续、状态新鲜、批准 profile 未变，且 `capacity.inflight_requests = 0`。
2. 使用从未用过的新 `engine_epoch` 和完整 `ActivationEvidence` 调用 `activate`；缺证据、旧 epoch、完整性冲突或未完成核对都不得绕过。
3. 核对恢复后的 next-unsent 仍为原游标，已提交 execution 不重新成为 UNSENT；只有新的 intent 可以触发下一次 POST。
4. 记录证据关联、恢复前后快照、事件游标和交接结果。使用 [阶段三验收脚本](../../scripts/accept-phase3.sh)复现本地失败窗口；这不替代真实旧引擎隔离、掉电、备份恢复或 TEE 验收。
