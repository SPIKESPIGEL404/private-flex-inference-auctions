# Controlled agent preview release acceptance

Runtime source: `bea14549f5b18b78a35bf2755ee3cb02be9ac3d2`. The original P0–P2 integration is main PR #8; this release adds a persistent, explicitly controlled preview beside the retained Phala gateway. It does not deploy the unfinished P3 signing implementation.

The Linux amd64 image uses PostgreSQL 18 for the current billing-audit schema. The official PGDG signing-key fingerprint is frozen in the packaging guide. The local container ran with 1536 MiB / 1 CPU, a read-only root, no capabilities, a private new data volume, and a dedicated ordinary bridge. Only port 3000 was published. This bridge is not an egress firewall. Provider, wallet and RPC targets are loopback fixtures, without live credentials or real broadcast.

Two real fx turns produced 42 and 19, each with one durable tool mutation and a paid continuation. The controlled ledger confirmed four payment actions and four refunds before the snapshot; both task and parent reservations reached zero. After restart, completed-turn replay preserved counts, charged budgets, configuration/catalog/state hashes, ledger hash and artifacts. There was no automatic refill or duplicate effect. Separate local browser checks exercised the actual WASM fx/terminal UI and preserved both completed artifacts after reload.

- [Container evidence](2026-11-14-agent-preview-container.json)
- [Image/archive binding](2026-11-14-agent-preview-image.json)
- [Additive overlay assertions](2026-11-14-agent-preview-preservation.json)

The image records both the local containerd manifest digest and the classic Docker config digest. The latter is derived from the saved archive's actual config bytes and is the target CVM's image pin. The retained deployed image's archive config was independently checked to match its existing classic Docker pin.

The preservation report is a primary-agent structural comparison against the private backed-up app-compose: original service definitions, six volumes, existing networks, allowed sealed environment names, remaining manifest fields, and old pre-launch prefix stay equal. The reviewer receives the report and synthetic preservation tests, not private deployment backups.

This is controlled acceptance, not real NEAR/provider, G1, or P3 acceptance. In particular the inherited sponsored v2 wallet fixture is not a correct proof that an actual NEP-366 transfer spends the agent's principal. Hosting the fixture does not change that limitation. Existing gateway hardware/channel verification is a separate check; no new paid inference or chain operation is part of deployment acceptance. Public preview TLS terminates at the Phala gateway and is not end-to-end TEE TLS.

Pre-deployment evidence above does not itself claim a successful live deployment. The final release receipt records the independently computed expected compose hash and post-update checks.

Independent GPT-6-Astra verdict: **SCOPED_PREDEPLOY_CONTROLLED_PREVIEW_ACCEPTED**, bound to the runtime source above. The reviewer independently checked archive/config/manifest binding, restarted the same local container, read the confirmed ledger and workspace state without resetting it, and checked actual resource/network/port restrictions. See the [final review](2026-11-14-agent-preview-review.json). No live deployment or real P3 claim is included.
