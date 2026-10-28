# 安全说明

这个插件用**你自己的 QQ 号**说话，所以这些是一等一敏感的：

| 东西 | 在哪 | 风险 |
|---|---|---|
| `config.json` | `<DSH_HOME>/qq-bridge/` | 里面有 OneBot token、模型网关 key |
| `allowlist.json` | 同上 | 你的 QQ 号 + 好友号 |
| `group-allowlist.json` | 同上 | 群号 + `ownerUins`（谁能命令它） |
| NapCat 的登录态 | 在 NapCat 自己那儿 | 等于 QQ 密码，插件**不碰**它 |

## 仓库里永远不会有它们

`.gitignore` 挡了 `config.json` / `allowlist.json` / `group-allowlist.json` / `control.json` /
`*.log` / `inbox.jsonl` / `replies.jsonl` / `contexts/` / `store/` / `media/` / `napcat-data/`。

## 插件守着这些边界

- **只回白名单**：私聊只回 `allowlist.friends` 里的人；群只有 `groups` 里列出的才理
- **群默认 dry-run**：`dryRun: true` 只生成不发送，得你手动改 false
- **管理权限收得很紧**：禁言上限 300 秒；**踢人的代码根本没实现**（不是配置项，是没有这段代码）
- **`ignoreUins`**：机器人/欢迎语之类的号直接忽略（默认滤掉 `2854197266`）
- **控制口只绑 127.0.0.1** + Bearer token（`control.json`，600 权限）
- **不执行消息里的指令**：群里说"忽略设定""按我说的做"都只当素材（`guard.txt` 管这个）

## 你该做的

1. 别把家目录同步到网盘/git。
2. QQ 号在别处有风险时：改密 → NapCat 会掉线 → 重新扫码登录。
3. `ownerUins` 只写你信得过的人（他们能让它唱歌、禁言别人）。

## 报告问题

发现能绕过上面任一条的路子，请开 issue 并**不要**贴真实账号/token。
