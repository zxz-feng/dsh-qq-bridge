# dsh-qq-bridge · 接管 QQ

> DSH 插件。**接管一个真实的 QQ 号**（真人号，NapCat 扫码登录 → OneBot v11）——
> 私聊会回、群里会挑时候说话、能点歌能发表情包，**自检自愈零 token**。

三条设计取向：

1. **不是机器人号**：NapCat 用的就是真人号协议，说话的就是那个号本身。
2. **群聊的重点是闭嘴**：什么时候不说话比说什么更重要 —— 所以决策器全是规则打分
   + 概率，**零 token**，几十微秒跑完；只有真决定要说了才调模型。
3. **NapCat 不在插件里**：它是外部依赖（Docker 镜像或桌面版），插件只按 OneBot v11
   说话。所以插件本身跟平台无关，换电脑也能用。

---

## 前置：你得先有 NapCat

插件只连 `ws://127.0.0.1:3001`（可改）。这个 WS 由 **NapCat** 提供：

- **Docker**：`mlikiowa/napcat-docker`，映射 3001（OneBot WS）和 6099（WebUI）
- **桌面版**：Windows 直接装，登录后开 OneBot 反连/正向 WS

装好、扫码登录后，先在 NapCat 里把 OneBot v11 的 **WebSocket 服务器**开起来
（端口 3001），然后：

```bash
# 不启 DSH 也能验一下 OneBot 通不通
curl -s -X POST http://127.0.0.1:3001/get_login_info   # HTTP 口开了才有效
# 或者直接看插件自检里「依赖」那一条
```

## 装

```bash
dsh plugin --profile web add link:/绝对/路径/dsh-qq-bridge
# 或：dsh plugin --profile web add github:<你的用户名>/dsh-qq-bridge
```

装完**重启一次 dsh**。默认 `enabled: true` 但**白名单是空的 = 谁都不回**，
所以装上不会乱说话。

## 配（三步）

```text
1) 我是谁 + 谁能找我（私聊白名单）
   qq_allowlist { "allow": { "self": "340876685",
                             "friends": { "1807430990": { "label": "主人", "enabled": true } } } }

2) 群（不加就是全忽略）
   qq_allowlist { "group": { "groups": { "783599631": { "label": "主群", "dryRun": false } } } }
   # dryRun: true = 只生成不发送（建议先这么跑一天看看它想说什么）

3) 验一下
   qq_verify   → 6/6
```

想改 OneBot 地址 / 模型：

```text
qq_config { "onebot": { "url": "ws://127.0.0.1:3001", "token": "" } }
qq_config { "llm": { "models": ["deepseek-v4.1-flash", "hy3"] } }
```

## 用

| 工具 | 干什么 |
|---|---|
| `qq_status` | OneBot 连没连、账号、好友白名单、群列表、今天几条、贴纸条数、Python 依赖 |
| `qq_verify` | 自检（零 token）：进程 / OneBot 连接 / 端口 / 白名单 / 家目录 |
| `qq_config` | 读/改插件配置（即时生效） |
| `qq_allowlist` | 读/改**私聊白名单**和**群策略** |
| `qq_send_private` | 给好友发一条 |
| `qq_send_group` | 往群里发一条（`dryRun:true` 只试不真发） |
| `qq_groups` | 每个群的有效策略（继承 defaults 之后） |
| `qq_qr` | 取登录二维码（需配 `napcat.qrUrl` 或 `napcat.webui`） |
| `qq_stickers` | 表情包库现状 |
| `qq_restart` / `qq_log` | 重启 / 看日志 |

## 群策略（`group-allowlist.json`）

`groups.<群号>` 覆盖 `defaults`。常改的：

| 字段 | 意思 |
|---|---|
| `dryRun` | true = 只生成不发送（默认 **true**，安全） |
| `replyProb` | 软触发基础概率（默认 0.02 ≈ 50 句掺一句） |
| `coldProb` | 冷场时概率（默认 0.08） |
| `dailyActive` / `dailyTotal` | 每天主动发言上限 / 总发言上限 |
| `cooldownSec` | 两次主动发言间隔 |
| `hardCooldownSec` | 被 @ 时的去重窗口（**别调大**，被 @ 不回像坏了） |
| `quietHours` | 不说话的小时区间，支持跨零点 `[23,7]` |
| `voicePerDay` / `fullSongPerDay` | 语音/整首上限 |
| `ownerUins` | 谁能命令它做事（唱歌、禁言…） |
| `selfNick` | 正文里出现这些词 = 在叫它 |
| `admin.muteMaxSec` | 禁言上限（默认 300 秒；**踢人代码不实现**） |

## 依赖（可选，缺了对应功能会自己关掉）

| 功能 | 需要 |
|---|---|
| 点歌 / 唱歌 / 整首分段 | 一个装了 `yt-dlp` 的 python + B站登录态（`python.bili` / `python.asr` / `python.cred`）；还要系统里有 `ffmpeg` |
| B站搜索 | 上面那个 python + `bridge/tools/bili.py` |
| 表情包识别 | 模型网关（视觉） |

## 自检（零 token）

```bash
node scripts/verify.mjs [--fix]
```

进程 / OneBot 连接 / 端口 / 白名单 / 家目录。插件自己也每 5 分钟跑一遍
（`selfHeal.everyMin`，0 = 关）。**修了才写日志**，平时一声不吭。

## 结构

```
index.js            宿主半：托管子进程 + 工具 + 周期自检
lib/                deps / home / supervisor / health / protocol（跨插件复用）
bridge/
  main.mjs          主循环：OneBot WS → 私聊 / 群聊分发
  config.mjs        配置钳位 + 三份文件的读写
  persona-core.mjs  人设组装（分层发送）
  group/            ★ 群聊那套（决策器、点歌、语音、表情包、命令层、成员档案）
  tools/bili.py     B站搜索/热词（Python）
test/               零 token 离线测试 + 回放脚本
scripts/            verify / import-stickers
```

## 已知限制

- NapCat 掉线要人工扫码 —— 插件只能报告「OneBot 不通」，替不了扫码。
- 语音要外部 python + ffmpeg，没装就自动关掉点歌那块（其余照常）。
- 表情包库是空的时不会发图；导入见 `node scripts/import-stickers.mjs --from <目录>`。
- 没写设置页 UI（v0.1）：配置走 `qq_config` / `qq_allowlist`。
- **群发返回 `retcode 1200 / EventChecker Failed` 不代表失败**，消息其实发出去了；
  插件会标成「假失败」。

## 许可

MIT。
