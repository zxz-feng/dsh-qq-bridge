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

> ⚠️ 如果报 `ERR_PNPM_IGNORED_BUILDS`（pnpm 12 把"跳过的构建脚本"当错误）：
> 加一个开关 —— `dsh plugin --profile web add <本仓库地址> --config.strict-dep-builds=false`。
> 不编译那几个可选原生加速件对本插件没有影响。

## 配（三步）

```text
1) 我是谁 + 谁能找我（私聊白名单）
   qq_allowlist { "allow": { "self": "10001000",
                             "friends": { "20002000": { "label": "主人", "enabled": true } } } }

2) 群（不加就是全忽略）
   qq_allowlist { "group": { "groups": { "123456789": { "label": "主群", "dryRun": false } } } }
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
| `qq_style` | 看/切某个群的说话风格档（`normal`/`sunbar`/`tsundere`/`cold`/`genki`，可 `heavy`） |
| `qq_stickers` | 表情包库现状 |
| `qq_restart` / `qq_log` | 重启 / 看日志 |

## 设置页（在 Web GUI 里点，不用敲工具）

装好插件、重启 DSH 之后：**设置 → QQ 小鲸鱼**（跟「刷B站」并排，排在它后面）。

| 分区 | 能改什么 |
|---|---|
| 现在什么状态 | 进程 / OneBot / 账号 / 今天几条 / 贴纸数 / 家目录（只读，每 10 秒自己刷） |
| 连接 | 总开关 `enabled`、OneBot 地址与 token、模式 `auto/draft/off`、模型链、NapCat WebUI、扫码登录 |
| 群 | 一群一卡：启用 / 真发·演练 / 风格档 + 强度 / 接话概率 / 冷场概率 / 每天几条 / 冷却 / 免打扰 / 语音与整歌上限 / 群主 QQ / 静音谁 / 认自己叫什么 —— **留空的项继承 `defaults`** |
| 说话风格 | 每档一句话说明 + 现在哪档生效（数据来自 `persona/styles/*.md` 的 front-matter） |
| 私聊白名单 | 谁能让机器人回私聊（加 / 删 / 停用，可标「主人」） |
| 运维 | 跑自检 / 看日志 / 重启桥 / 刷新二维码 |

改完点保存 → **下一句群消息就按新配置走**，不用重启。宿主那半边只做三件事：读写那几份
JSON、把切风格交给桥的 `main.mjs style` 子命令、把 `qq_verify` / `qq_log` 的输出原样转回来。

> 服务只绑 `127.0.0.1`，每个路由都过同源检查；token 返回时打码，原样存回**不会**把打码串
> 写进文件（这条有测试盯着）。

## 找东西 / 找资源（带缩略图）

群里说「帮我找个黄油 / 找个 galgame / 来张壁纸，要缩略图」——**谁都能让她找**（跟点歌一样，
只要是在跟她说话）。她会走这条链：

```
DLsite 搜索 → 取作品页 og:title / og:image → 下载封面 → 压到 520px → 真的发出去
回复：标题 ||| 作品链接
```

- 只发**店铺公开的封面图**，不抓内容、不搬运资源本体。
- 直连拿不到会自动改走本地代理重试（`GOODS_PROXY`，默认 `http://127.0.0.1:17890`）。
- 认得的说法：`帮我找个X` / `给某人找个X` / `找个X` / `推荐个X` / `来个X` / `求个X`；
  资源词要有（黄油/galgame/游戏/本子/番/资源/漫画/画师/作品/壁纸/图/封面/缩略图）。
- 语序太绕的（「黄油有吗」）不认，会落到普通聊天 —— 她可以反问一句。

## 说话风格档（性格随便换）

风格是**目录即注册表**：`persona/styles/*.md` 里放一个文件就多一档，不用改代码、不用重启。
自带五档：

| 档 | id | 一句话 |
|---|---|---|
| 正常 | `normal` | 默认，温柔短句（不注入任何东西，最省） |
| 孙吧 | `sunbar` | 短、损、反问收尾，被怼立刻加倍还嘴 |
| 傲娇 | `tsundere` | 嘴上不认，「才不是」「谁要」，被夸炸毛 |
| 冷淡 | `cold` | 2~6 字，句号收尾，不接梗不解释 |
| 元气 | `genki` | 语气上扬，短句带感叹号，爱接话 |

怎么切（只有主人号能切）：

```
群聊里：  #风格 傲娇        ← 切档（也认 开孙吧模式 / 换成冷淡 / 切成人格 元气）
          #风格 傲娇 重      ← 带「重/狠/猛」= heavy 强度
          #风格 关           ← 回正常（也认 关掉孙吧 / 正常）
          #风格              ← 看现在哪档 + 有哪些档
命令行：  node scripts/style.mjs <群号> <档> [mid|heavy]      # 切
          node scripts/style.mjs <群号> --list                 # 列
DSH 工具：qq_style { gid, style: "tsundere", intensity: "mid" }
```

切档不只是换语气，决策器也跟着变（数值写在档位文件的 `bias:` 里）：

| 档 | 接话概率 | 冷场插话 | 全局冷却 | 每人冷却 | 刷屏判定 |
|---|---|---|---|---|---|
| normal | ×1 | ×1 | 60s | 5min | 8 条/10 分钟 |
| sunbar | ×4 | ×2 | 20s | 30s | 20 条/2 分钟 |
| tsundere | ×2.5 | ×1.5 | 30s | 2min | 12 条/5 分钟 |
| cold | ×0.4 | ×0.6 | 120s | 8min | 6 条/15 分钟 |
| genki | ×1.8 | ×1.5 | 45s | 3min | 10 条/10 分钟 |

强度 `heavy` 会把概率再抬一档、冷却再砍一半。

### 加一档 = 写一个文件

`persona/styles/<id>.md`：

```markdown
# 显示名
---
id: tsundere
name: 傲娇
aliases: 傲娇, 大小姐, 嘴硬
short: 一行压缩版（每轮都发，务必 <60 字）
persona: 顶掉默认「温柔」那句的精简人设
bias: replyProbMul=2.5,cooldownSec=30
---
## 语气
（完整说明，只在完整人设那轮发）
## 例句
- 才不是呢
## 词表
- 哼
```

改文件即时生效（按 mtime 缓存，不重启）。缺文件会自动从插件自带的那份补上，**改过的不会被覆盖**。

### 省 token 的三层

1. 每轮只发 `short`（一行，~60 字）；
2. 完整说明 + 例句 + 词表，只在「完整人设」那轮发（首次 / 每 8 轮 / 改人设后）；
3. 例句和词表**按天轮换**（8 条 / 6 条），不整锅倒进去。

### 语料：只提炼语感，不搬内容

`scripts/style-corpus.mjs` 从 GitHub 公开语料里提炼「语感特征」，生成档位文件的初稿：

```
node scripts/style-corpus.mjs --list           # 看能用的语料库
node scripts/style-corpus.mjs --analyze <库>   # 统计（句长/句尾/口头词/反问率）
node scripts/style-corpus.mjs --draft sunbar   # 出初稿到 /tmp，人工挑
```

**底线：政治内容一律不进语料、不进档位文件。** 抓取阶段按词表硬过滤（政治人物/事件/宣传），
提炼阶段只取「句长、句尾语气、口头词、反问比例」这类统计量，不复制原句。
这条不是可选项 —— 群是公开场合，沾上就没法收拾。

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
| 更强的联网搜索 | DSH 里装了搜索插件并配了 key（见下） |

## 联网搜索：四个源，谁有结果算谁的

群里那句「XX 是什么意思」背后跑的是四条并发线路：

| 源 | 靠什么 | 拿不到时 |
|---|---|---|
| **宿主搜索** | 借 DSH 自己的 `ctx.web`（装了搜索插件、配了 key 才有） | 静默跳过 |
| **DDG lite** | `lite.duckduckgo.com` + Lynx UA，免 key | 静默跳过 |
| **B站** | `tools/bili.py` + B站登录态 | 静默跳过 |
| **维基百科** | 官方 API，免 key | 静默跳过 |

桥是**独立子进程**，拿不到 DSH 的 `ctx`。所以宿主进程开了一个只绑 `127.0.0.1`、
带随机 token 的小门（`lib/host-api.mjs`），把地址经 `HOST_API_URL` / `HOST_API_TOKEN`
交给桥（`bridge/group/hostsearch.mjs` 是桥这边的客户端）。

**没有搜索插件也能跑** —— 小门会老实回 `NO_PROVIDER`，桥退回 DDG lite + B站 + 维基。
反过来，光装搜索插件、不接这条通道，桥也用不上它。

## 自检（零 token）

```bash
node scripts/verify.mjs [--fix]
```

进程 / OneBot 连接 / 端口 / 白名单 / 家目录。插件自己也每 5 分钟跑一遍
（`selfHeal.everyMin`，0 = 关）。**修了才写日志**，平时一声不吭。

## 结构

```
index.js            宿主半：托管子进程 + 工具 + 周期自检 + 设置页路由
client.js           浏览器半：设置页那一栏（自注册 __ModuleLoader__，只认 react）
lib/                deps / home / supervisor / health / protocol（跨插件复用）
lib/api.mjs         设置页的 HTTP 接口（13 条路由，读写 JSON / 转 qq_verify / 切风格）
lib/http.mjs        小工具：sendJson / readBody / sameOriginOk / mask
lib/host-api.mjs    宿主小门：把 ctx.web 借给子进程（可选，起不来不影响桥）
bridge/
  main.mjs          主循环：OneBot WS → 私聊 / 群聊分发
  config.mjs        配置钳位 + 三份文件的读写
  persona-core.mjs  人设组装（分层发送）
  group/            ★ 群聊那套（决策器、点歌、语音、表情包、命令层、成员档案）
    goods.mjs       找资源 + 缩略图（DLsite → og:image → 发图）
    hostsearch.mjs  找宿主借联网搜索（127.0.0.1 小门，可选）
    search.mjs      四源并发：宿主 / DDG lite / B站 / 维基
    style.mjs       风格档注册表：读 persona/styles/*.md + 提示词注入 + 决策偏置
  persona/styles/    ★ 风格档（一个 .md 一档，丢文件就多一档）
    normal.md sunbar.md tsundere.md cold.md genki.md
  tools/bili.py     B站搜索/热词（Python）
test/               零 token 离线测试：run（桥）/ api（接口真 HTTP）/ client（假 React 渲染）/ 回放
scripts/            verify / import-stickers / style（命令行切档）
```

## 已知限制

- NapCat 掉线要人工扫码 —— 插件只能报告「OneBot 不通」，替不了扫码。
- 语音要外部 python + ffmpeg，没装就自动关掉点歌那块（其余照常）。
- 表情包库是空的时不会发图；导入见 `node scripts/import-stickers.mjs --from <目录>`。
- 设置页只有 web 平台这一份；Telegram 插件还没做同样的页（只能走工具）。
- 设置页改的是「文件 + 桥」，**改不到 NapCat 自己**（掉线还是得扫码）。
- **群发返回 `retcode 1200 / EventChecker Failed` 不代表失败**，消息其实发出去了；
  插件会标成「假失败」。

## 许可

MIT。
