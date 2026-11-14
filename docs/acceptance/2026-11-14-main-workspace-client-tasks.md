# 主交互界面内存任务验收

日期：2026-11-14。结果：本地受控验收通过；未部署，未发送链上交易，未调用真实模型供应商。

## 实现与边界

基线为 `e2641db6f764af061059abe16a56794d3a021dac`，工作分支 `codex/single-seller-auction-agent`。实现对应[规格第 8 节](../specs/2026-11-14-single-seller-auction-and-agent-evaluation.md)，后续真实链验收网络已选择 NEAR testnet。

首页 `/` 直接复用 App、TaskPane、Activity、任务设置和 owner 钱包入口。原 `/memory` 地址重定向首页，不再维护独立任务页面或登录表单。运行时由 App 的 [MemoryTaskController](../../clients/market-playground/src/memory-tasks.ts) 持有；隐藏、缩放或卸载终端 pane 不会终止 fx/just-bash。终端展示对话和工具结果，每个 pane 的同一状态行更新采购进度；Activity 展示本人订单、bid、付款、退款和本页工作区文件。

任务预算授权与经济出价倍率分别配置。首次显式运行才创建最小金融授权，其请求仅包含 agentId、operation、budgetNano、callCapMicro、deadlineMs；prompt、对话、工具文件不进入授权记录。显式暂停中止本地循环并撤销原授权，撤销未知时保留待确认状态。刷新后可查询金融历史，但不恢复本地任务、文件或自动采购。

新路径不依赖后端 agent session/journal/tool 服务，不读取 IndexedDB、localStorage 或 sessionStorage。现有后端的旧任务路径仍由 capability 选择。本次控制服务器使用拥有者 Market schema 和真实 PostgreSQL，供应、付款与退款适配器为 fixture；owner 登录复用现有 NEP-413 Auth，Testnet 网络绑定已接入。浏览器使用受控 owner cookie，NEP-413 签名验证另由 PostgreSQL 集成测试覆盖，链上公钥查询使用 fake RPC。

## 验收结果

| 验证 | 结果与范围 |
| --- | --- |
| 主界面 Chromium 闭环 | 真实浏览器 fx WASM 与 just-bash；3 个任务、6 个原模型调用、6 个原订单；独立验证 JSON 结果 42、19、19 |
| pane 生命周期 | 拦截首个已完成模型响应，隐藏运行中的第三个 pane，释放响应后继续采购下一轮；恢复 pane 后任务完成，文件仍在 |
| 出价与预算 | A 的预算上限 $0.02、起始倍率 1.1，B 为 $0.01、1.0；冻结合同按各自倍率，预算没有替代经济出价 |
| 资金投影 | 受控订单分别展示 execution/payment/settlement；预付款等于扣费与已退本金之和；列表不泄露原模型结果或付款 challenge |
| 刷新与隔离 | 持久存储访问 0；旧 task API 调用 0；刷新后自动采购 0，历史订单 6，结果文件未恢复；旧地址重定向不采购 |
| 现有入口 | 钱包弹窗显示 Testnet；受控模式不提供真实注资按钮；Activity 导出本页证据 |
| 移动端 | Chromium 390×844，文档宽度 390，无页面横向溢出；终端完成 resize 后检查截图 |
| 前端自动化 | 10 个测试通过，含 controller 生命周期、撤销 ACK 丢失、owner 切换与旧钱包回归 |
| 既有 gateway 回归 | 17 个测试通过，含认证与 owner 隔离 |
| 任务/拍卖单元测试 | 24 个测试通过，含真实本地 fx/tools、原操作重试、授权与报价合同；链适配器使用 fake provider |
| 拥有者 PostgreSQL 集成 | 14 个测试通过，含并发分配、恢复/fence/退款、共享责任、NEP-413 登录与最小金融授权 |
| 构建 | TypeScript 与 Vite production build 通过；git diff --check 通过 |

合计 65 个自动化测试，另加完整 Chromium 场景。浏览器结果及源码摘要见[机器可读证据](2026-11-14-main-workspace-client-tasks.json)，拥有者 schema/binary 摘要见[受控 Market 记录](2026-11-14-single-seller-auction-controlled.json)。截图与下载文件在本地 `output/playwright/`，不包含私钥。

这些证据仅证明客户端与协议接线、工具执行、受控金融状态和生命周期行为。S1/S4 的真实钱包本金/gas/供应付款、真实模型资格验证，以及 S5 的机制统计实验仍待完成；不能由本轮结果推导真实链或生产验收通过。

## 复现

使用 Node 24、PostgreSQL、Redis，并先按仓库现有 P2 materialization/build 流程生成 opt-in auction schema 对应的 `private-market-host-p2` binary。避免用其他 schema 模式的 binary。分别在 buyer-gateway、market-playground、mpp-near-direct 执行 `npm ci` 后运行：

```sh
npm test --prefix clients/market-playground
npm test --prefix clients/buyer-gateway
node --test services/mpp-near-direct/client/test/*.test.mjs services/mpp-near-direct/auction/test/*.test.mjs
npm run build --prefix clients/market-playground
python3 scripts/accept-single-seller-auction.py /absolute/path/to/private-market-host-p2 --evidence docs/acceptance/2026-11-14-single-seller-auction-controlled.json --serve
```

`--serve` 在测试通过后启动本地 4180 端口受控后端；授权 fixture 仅存活 10 分钟。另一个终端启动 Vite：

```sh
npm run dev --prefix clients/market-playground -- --port 4517
```

使用 Playwright CLI 和已安装的 Chromium 新开专属浏览器 session，再执行 [browser 场景](../../scripts/accept-main-workspace.browser.mjs)：

```sh
playwright-cli --session auction-review open http://127.0.0.1:4517 --config /absolute/path/to/playwright.json
playwright-cli --session auction-review run-code --filename scripts/accept-main-workspace.browser.mjs
```

配置指定本机 Chromium executablePath、browserName=chromium、viewport=1280×900。每次完整重跑使用新 browser context 与全新的受控后端，避免混入历史 fixture 订单；运行时间超过授权窗口时重建受控环境。脚本拒绝真实付款 capability，并只使用本地 fixture 身份。
