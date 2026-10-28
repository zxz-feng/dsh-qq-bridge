# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-qq-bridge`（中文名「**接管 QQ**」）：让 DSH 接管**一个真实 QQ 号**
（NapCat → OneBot v11），私聊会回、群里挑时候说话、能点歌能发表情包。

## 帮使用者装的时候，按这个顺序

1. **先确认 NapCat 在跑**（插件不带它）：
   - Docker：`mlikiowa/napcat-docker`，映射 3001（OneBot WS）+ 6099（WebUI）
   - 桌面版：装好登录，开 OneBot v11 正向 WS（3001）
   - 不通就先解决这个，别急着装插件
2. **装**：`dsh plugin --profile web add link:<绝对路径>` 或 `github:<user>/dsh-qq-bridge`
3. ⚠️ **提醒他重启一次 dsh**（bundle 层要重启才组装）
4. `qq_allowlist` 写 `self`（自己的 QQ 号）+ `friends`（谁能找它）—— **不写就谁都不回**
5. 要进群：`qq_allowlist` 写 `groups`，**先 `dryRun: true` 跑一段**，看它想说什么再改 `false`
6. `qq_verify` 应该 6/6；不通就看哪一条：「依赖」= OneBot 端口不通

## 必须提前说清的四件事

- ⚠️ **`dryRun` 默认是 true**。别一上来就 `false` 往真群发 —— 先用 dry-run 看日志里
  `[dry-run] 会发: …` 那几行，觉得像人话再开。
- ⚠️ **群发「失败」可能是假的**：NapCat 常返回 `retcode 1200 / EventChecker Failed`，
  但消息已经发出去了。看到这个**别重发**，会刷屏。
- ⚠️ **别同时跑两个桥**（比如插件 + 旧脚本）。两个都连同一个 OneBot 会各回一遍。
  装了插件就把旧的 `systemctl` 服务停掉。
- ⚠️ **禁言上限 300 秒，踢人代码根本不实现**。别答应使用者"让它踢人"。

## 自检/自愈是零 token 的

`qq_verify` 和每 5 分钟的自动自检只查进程、TCP、白名单、家目录，**不调模型**。
诊断别去调 `qq_send_group` 试（那会真发到群里）。

## 常见故障

| 现象 | 先查什么 |
|---|---|
| 一句话不回 | `qq_verify` → 「依赖」OneBot 通不通；`qq_status` 白名单是不是空 |
| 群里从不说话 | 群策略 `dryRun` 还是 true？`dailyActive` 用完了？`quietHours` 里？ |
| 说了但没发出去 | 日志里 `发送失败` 后面是不是 `retcode 1200`（假失败）；`mode` 是不是 `off` |
| 点歌没声 | 没配 `python.asr`（装 yt-dlp 的那个 python）或没有 `ffmpeg` |
| 表情包不发 | 库是空的（`qq_stickers` 看 count），`scripts/import-stickers.mjs --from <目录>` |
| 二维码拿不到 | `qq_qr` 需要 `qq_config` 里配 `napcat.qrUrl` 或 `napcat.webui`+`token`；否则让他直接在 NapCat WebUI 扫 |

## 别做的事

- 别把 `config.json` / `allowlist.json` 里的东西贴到对话里（有账号信息和密钥）
- 别在 dry-run 阶段就承诺"它已经在群里正常说话了"
- 别为了测试往真群里发消息；要测就用 `qq_send_group` 的 `dryRun: true`
