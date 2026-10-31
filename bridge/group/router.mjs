/**
 * 群消息主流程
 *
 * 一条群消息进来，走这条链：
 *   白名单 → 过滤（自己/机器人/刷屏）→ 解析 → 学表情包 → 落窗口 → 更新档案
 *        → 主人命令（优先）→ 静默检查 → 决策 → 生成 → 发送（或 dry-run）→ 审计
 *        → 顺带每 60 条压一次摘要
 *
 * 两个关键设计：
 *   ① **决策在生成之前**。不说话就一个 token 都不花。
 *   ② **被冷却挡下的不是丢弃，是排队补回**。被 @ 了却因为 90 秒冷却不回，
 *      用户只会觉得"坏了"。所以挡下时记下剩余秒数，到点补一句。
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCQ } from '../cq-parser.mjs';
import { decide } from './decide.mjs';
import * as store from './store.mjs';
import * as members from './members.mjs';
import { record, maybeSummarize } from './context.mjs';
import { generate } from './generate.mjs';
import { learn, lookup, download, imageCQ, pickSticker, sendPicture } from './media.mjs';
import { makeVoice, makeVoiceFull, recordCQ, judgeSong, safeErr } from './voice.mjs';
import { styleBias } from './style.mjs';
import { hotwords, gather } from './search.mjs';
import * as commands from './commands.mjs';
import { chat } from './llm.mjs';
import { shortPersona, ANCHOR } from './persona.mjs';
import { hostSpeak } from './hostsearch.mjs';
import { stage } from './paths.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
// 群策略文件：插件里由 GROUP_CFG 指过来（家目录），独立跑时退回同目录
const CFG_FILE = process.env.GROUP_CFG || (DIR + '../group-allowlist.json');

export const SELF = String(process.env.SELF_QQ ?? '');

/** 读配置（每次现读，改完即时生效，不用重启） */
export function loadConfig() {
  try { return JSON.parse(readFileSync(CFG_FILE, 'utf8')); }
  catch { return { groups: {}, defaults: {} }; }
}

/** 取某个群的策略（groups 里的覆盖 defaults） */
export function policyFor(gid) {
  const cfg = loadConfig();
  const key = String(gid);
  // 私聊用伪 gid（p + QQ号）：让同一套命令/生成/表情包流程直接复用。
  // 策略单独放 cfg.private，默认「有问必答」——私聊本来就是一对一，没什么好冷场的。
  if (key.startsWith('p')) {
    const p = cfg.private;
    if (!p || p.enabled === false) return null;
    return { ...(cfg.defaults ?? {}), ...p, admin: { ...(cfg.defaults?.admin ?? {}), ...(p.admin ?? {}) } };
  }
  const g = cfg.groups?.[key] ?? null;
  if (!g || g.enabled === false) return null;
  return { ...(cfg.defaults ?? {}), ...g, admin: { ...(cfg.defaults?.admin ?? {}), ...(g.admin ?? {}) } };
}

function audit(gid, obj) {
  const d = `${store.STORE}/groups/${gid}`;
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  try {
    appendFileSync(`${d}/audit.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch { /* 审计写失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * NapCat 的 send_group_msg 经常返回 retcode 1200 / "EventChecker Failed /
 * NTEvent ... onMsgInfoListUpdate / rich media transfer failed"，
 * 但消息**其实已经发出去了**（群里能查到）。
 *
 * 这是 NapCat 4.18 在群聊里的回执 bug，不能当成失败：
 * 当成失败会导致重复补发、日志里全是假警报。
 * 判据：status==='ok' 或 retcode===0 → 成功；
 *       消息体里有 "EventChecker Failed" → 也当成功（实际已投递）；
 *       其他才算真失败。
 */
function sendOk(r) {
  if (!r) return false;
  if (r.status === 'ok' || r.retcode === 0) return true;
  const msg = String(r.message ?? '') + String(r.wording ?? '');
  if (/EventChecker Failed/i.test(msg)) return true;
  return false;
}

// ── 被冷却挡下的消息：排队，到点补回 ──────────────────────
const deferred = new Map();   // gid → { msg, evt, timer }

function scheduleDeferred(gid, msg, sec, policy, callApi, evt, hard = false) {
  const cur = deferred.get(gid);
  const merged = cur
    ? { ...msg, text: `${cur.msg.text}\n${msg.text}`, name: msg.name, uin: msg.uin }
    : msg;
  if (cur?.timer) clearTimeout(cur.timer);
  const wait = Math.max(1, Math.ceil(sec)) * 1000 + 300;
  const timer = setTimeout(() => {
    deferred.delete(gid);
    console.log(`  [group] 冷却结束，补回刚才被挡的那句`);
    void respond({ gid, policy, msg: merged, evt, callApi, isDeferred: true, hard })
      .catch((e) => console.error('  [group] 补回失败:', e.message));
  }, wait);
  deferred.set(gid, { msg: merged, evt, timer, hard });
  console.log(`  [group] 被冷却挡下 → ${(wait / 1000).toFixed(0)}s 后补回`);
}

// ── 主入口 ───────────────────────────────────────────────

export async function handleGroupMessage(evt, { callApi, isPrivate = false }) {
  const gid = String(evt.group_id ?? '');
  if (!gid) return;

  const policy = policyFor(gid);
  if (!policy) return;                        // 不在白名单

  const sender = evt.sender ?? {};
  const uin = String(evt.user_id ?? sender.user_id ?? '');
  if (!uin || uin === SELF) return;           // 自己发的

  const name = sender.card || sender.nickname || uin;

  // 群管机器人 / 系统消息：不回
  const rawMsg = String(evt.raw_message ?? '');
  if (/\[CQ:markdown/.test(rawMsg)) {
    console.log('  [group] 跳过机器人消息（markdown）');
    return;
  }
  const ignore = (policy.ignoreUins ?? []).map(String);
  if (ignore.includes(uin)) {
    console.log(`  [group] 跳过机器人 ${name}（ignoreUins）`);
    return;
  }

  const parsed = parseCQ(evt.message ?? rawMsg);
  const text = (parsed.text ?? '').trim();
  if (/^\[markdown\]/.test(text)) return;
  if (!text && !parsed.images?.length) return;

  // 私聊里每一句都算「点了名」：一对一不需要先 @ 才回答
  const atMe = isPrivate || (parsed.at ?? []).some((x) => String(x) === SELF);
  const replyMatch = rawMsg.match(/\[CQ:reply,id=(-?\d+)\]/);
  const replyToMe = replyMatch ? store.isMyMessage(gid, replyMatch[1]) : false;
  const hasImage = (parsed.images?.length ?? 0) > 0;

  // ── 刷屏判定（主人豁免；阈值/静默时长跟风格档走）──
  // ⚠️ 2026-10-29 实际故障：对骂时对方 8 条/分钟就被判刷屏、锁 10 分钟，
  //    之后连 @ 都不回 —— 用户看到的是"骂不过就不说话了"。
  //    现在：① 硬触发（@/回复/叫名字）**不受刷屏静默影响**；② 孙吧档放宽到 20 条/2 分钟。
  const bias = styleBias(gid);
  const hardTrigger = atMe || replyToMe
    || (policy.selfNick ?? []).some((n) => n && text.includes(n));
  const spam = commands.isOwner(uin, policy)
    ? { spam: false }
    : members.checkSpam(uin, { threshold: bias.spamThreshold, seconds: bias.spamSeconds });
  if (spam.spam) {
    console.log(`  [group] ${name} 在刷屏，静默到 ${new Date(spam.until * 1000).toLocaleTimeString('zh-CN')}`
      + (hardTrigger ? '（但他点了名 → 照回）' : ''));
  }

  // 表情包：先查库，没命中才调视觉
  let imageDesc = '';
  if (hasImage) {
    for (const img of parsed.images.slice(0, 2)) {
      const buf = await download(img.url);
      if (!buf) continue;
      const hit = lookup(buf);
      if (hit) {
        imageDesc += `\n[${name}发了表情包：${hit.desc}]`;
      } else {
        const r = await learn(buf, { from: uin, hint: img.sticker ? '表情包' : '图片' });
        if (r) {
          imageDesc += `\n[${name}发了${img.sticker ? '表情包' : '图片'}：${r.desc}]`;
          // 记着这条消息的图是什么 —— 之后有人引用它问"这图里是谁"，得答得上来
          store.rememberMedia(gid, evt.message_id, { desc: r.desc, uin, name, kind: img.sticker ? '表情包' : '图片' });
        }
      }
    }
  }

  // 引用：QQ 只给 [CQ:reply,id=]，被引用的内容不在消息体里。
  // 自己发过的图、别人刚发过的图我们都记着 —— 直接摆给模型看，别让她装瞎。
  if (replyMatch) {
    const qm = store.lookupMedia(gid, replyMatch[1]);
    if (qm?.desc) {
      imageDesc += `\n[他引用了这条：${qm.name ?? '某人'}发的${qm.kind ?? '图片'}「${qm.desc}」]`;
    } else if (store.isMyMessage(gid, replyMatch[1])) {
      imageDesc += '\n[他引用了小鲸鱼自己发的一条消息]';
    }
  }

  // 落窗口 + 更新档案
  const displayText = (text + imageDesc).trim() || '[发了个表情包]';
  const gapSec = store.lastMessageAt(gid) ? store.nowSec() - store.lastMessageAt(gid) : 0;
  record(gid, { uin, name, text: displayText, kind: hasImage ? 'image' : 'text' });
  const member = members.noteMessage(uin, { nick: sender.nickname, card: sender.card, atMe, text });

  // 「被无视」计数
  const stats0 = store.loadStats(gid);
  if (stats0.awaitingReply) {
    if (atMe || /小鲸鱼/.test(text)) {
      stats0.ignoredStreak = 0;
      stats0.awaitingReply = 0;
    } else if (store.nowSec() - stats0.awaitingReply > 120) {
      stats0.ignoredStreak = (stats0.ignoredStreak ?? 0) + 1;
      stats0.awaitingReply = 0;
    }
    store.saveStats(gid, stats0);
  }

  // ── 主人命令（优先于一切，包括静默）──
  if (commands.isOwner(uin, policy)) {
    const cmd = commands.parseCommand(text);
    if (cmd) {
      const done = await runCommand(cmd, { gid, uin, name, policy, callApi, at: parsed.at ?? [], evt, isPrivate });
      if (done) return;
    }
  }

  // ── 找资源（谁都能让她找，跟点歌一个道理）──
  // 起因（2026-10-29）：秦始皇让她「帮lcarus找个黄油，要缩略图」，她嘴上答应了没动。
  // 两条原因：① 命令层只认主人；② 她根本没有"搜到图发出去"的出口。
  // 现在：非主人只要是在跟她说话 + 说的是找东西，就走 find（谁都能点歌，谁都能找货）。
  {
    const toMe = atMe || replyToMe || /小鲸鱼|肥鱼大小姐/.test(text);
    if (toMe) {
      const look = commands.parseLookup(text);
      if (look) {
        const done = await runCommand(look, { gid, uin, name, policy, callApi, at: parsed.at ?? [], evt, isPrivate });
        if (done) return;
      }
    }
  }

  // ── 点歌（谁都能点，确定性路径，不经过模型）──
  // addressed = 这条是不是冲着小鲸鱼说的；"光秃秃一个放"必须被叫到才算点歌
  const addressed = atMe || /小鲸鱼/.test(text) || commands.isOwner(uin, policy);
  let songReq = commands.parseSong(text, { addressed });
  if (songReq) {
    // ① 先确认"这是不是在点歌"。规则可能把"搞错号了"认成歌名，让模型复核一次。
    const v = await judgeSong(text);
    if (!v.isSong) {
      console.log(`  [group] 模型判定不是点歌 → 交给聊天`);
      audit(gid, { gid, uin, name, text, songRejected: true, guess: songReq.query });
      songReq = null;
    } else if (v.title) {
      songReq.query = v.title;          // 用模型抽出来的歌名，通常更干净
      if (v.artist) console.log(`  [group] 判定是歌：《${v.title}》${v.artist}`);
    }
  }
  if (songReq) {
    const done = songReq.full
      ? await runFullSong(songReq, { gid, uin, name, policy, callApi, evt })
      : await runSingleSong({ ...songReq, raw: text }, { gid, uin, name, policy, callApi, evt });
    if (done) return;
  }

  // ── 被主人要求闭嘴期间 ──
  const sil = commands.isSilenced(gid);
  if (sil) {
    console.log(`  [group] 静默中（到 ${new Date(sil.until * 1000).toLocaleTimeString('zh-CN')}），不回`);
    return;
  }

  // ── 决策 ──
  let hw = [];
  try { hw = await hotwords(); } catch { /* 拿不到就算了 */ }

  // 风格偏置：开了孙吧模式就更爱接话（×4 概率、主动额度≥8、冷却缩短）
  const policyForDecide = bias.replyProbMul === 1 ? policy : {
    ...policy,
    replyProb: Number(policy.replyProb ?? 0.02) * bias.replyProbMul,
    coldProb: Number(policy.coldProb ?? 0.08) * bias.coldProbMul,
    dailyActive: Math.max(Number(policy.dailyActive ?? 3), 8),
    ...bias.policy,
  };

  const d = decide({
    text: displayText,
    atMe,
    isOwner: commands.isOwner(uin, policy),
    isWhale: members.isOtherWhale(name, policy.otherWhales?.pattern ?? '鲸鱼'),
    replyToMe,
    gapSec,
    policy: policyForDecide,
    stats: store.loadStats(gid),
    member: hardTrigger ? { ...member, spamUntil: 0 } : member,
    lastSpoke: store.lastSpokeAt(gid),
    hotwords: hw,
    hasImage,
  });

  console.log(`  [group] ${name}: ${displayText.slice(0, 40)}`
    + `\n          → ${d.speak ? '说' : (d.deferSec ? '稍后补' : '不说')}（${d.reason}）`);

  audit(gid, {
    gid, uin, name, text: displayText, atMe, hasImage,
    speak: d.speak, deferSec: d.deferSec ?? 0, reason: d.reason, score: d.score,
  });

  maybeSummarize(gid).catch(() => {});

  if (d.speak) {
    await respond({
      gid, policy, msg: { uin, name, text: displayText, atMe, replyToMe }, evt, callApi, hard: d.hard,
    });
    return;
  }
  if (d.deferSec) {
    scheduleDeferred(gid, { uin, name, text: displayText, atMe, replyToMe }, d.deferSec, policy, callApi, evt, d.hard);
  }
}

// ── 生成 + 发送 ──────────────────────────────────────────

/**
 * 私聊入口：把私聊伪装成一个「群」，复用整条群聊链路。
 *
 * 为什么这么干：群聊那条链上挂着命令解析、四源搜索、贴吧、找资源、点歌、
 * 表情包、风格档、上下文摘要……重写一份必然漏。所以只做两件事：
 *   ① gid 换成 `p<QQ号>`，策略读 cfg.private；
 *   ② callApi 包一层，把 send_group_msg 翻成 send_private_msg。
 * 其余逻辑一个字不改。
 */
export async function handlePrivateMessage(evt, { callApi }) {
  const uid = String(evt.user_id ?? evt.sender?.user_id ?? '');
  if (!uid || uid === SELF) return;
  const gid = `p${uid}`;
  if (!policyFor(gid)) {
    console.log('  [private] 私聊未开启（group-allowlist.json 里 private.enabled）');
    return;
  }
  const shim = (action, params = {}, timeoutMs) => (action === 'send_group_msg'
    ? callApi('send_private_msg', { user_id: Number(uid), message: params.message }, timeoutMs)
    : callApi(action, params, timeoutMs));
  return handleGroupMessage({ ...evt, message_type: 'group', group_id: gid }, { callApi: shim, isPrivate: true });
}

async function respond({ gid, policy, msg, evt, callApi, isDeferred = false, hard = false }) {
  const sil = commands.isSilenced(gid);
  if (sil) { console.log('  [group] 静默中，放弃这次回复'); return; }

  let out;
  try {
    out = await generate({ gid, policy, msg });
  } catch (e) {
    console.error('  [group] 生成失败:', e.message);
    return;
  }
  if (!out.parts.length) {
    // 被叫到却沉默 = 用户眼里"坏了"。硬触发一律兜一句，不给自己 pass 的权利。
    if (hard) {
      const line = pickDeflect();
      console.log(`  [group] 模型想 pass，但这是硬触发 → 兜一句: ${line}`);
      if (policy.dryRun !== false) console.log(`  [dry-run] 会发: ${line}`);
      else {
        const quote = evt?.message_id ? `[CQ:reply,id=${evt.message_id}]` : '';
        const r = await callApi('send_group_msg', { group_id: Number(gid), message: quote + line });
        const ok = sendOk(r);
        if (ok) store.pushSentId(gid, r?.data?.message_id);
        console.log(`  [group] ${ok ? '已发' : '发送失败'}: ${line}`);
      }
      store.pushSpoken(gid, line);
      const st0 = store.loadStats(gid);
      st0.total = (st0.total ?? 0) + 1;
      st0.awaitingReply = store.nowSec();
      store.saveStats(gid, st0);
      audit(gid, { gid, uin: msg.uin, passed: true, fallback: line, deferred: isDeferred });
      return;
    }
    console.log('  [group] 模型选择不说话（[[pass]]）');
    audit(gid, { gid, uin: msg.uin, passed: true, deferred: isDeferred });
    return;
  }

  const dry = policy.dryRun !== false;
  const quote = !isDeferred && (msg.atMe || evt?.message_id) ? `[CQ:reply,id=${evt.message_id}]` : '';

  // ── 要语音就真发语音 ────────────────────────────────────────────────────
  // 嗓子长在宿主进程里（dsh-voice 插件），桥只能通过宿主小门借。
  // 借不到就**照常发文字**，绝不让"语音失败"变成"没回复"。
  /**
   * 从「发个语音，内容是：“X”」「语音说 X」「念一下 X」里抠出**要念的原话**。
   * 为什么必须抠：模型经常先评论一句（「我是AI，没嗓子啊」），然后这句话被合成成语音发出去，
   * 听起来就是「她用语音说自己没嗓子」。有引号/明确动词时，原话优先于模型输出。
   */
  const spokenPayload = (text) => {
    const s = String(text || '')
    if (!/语音|念|读|说/.test(s)) return ''
    const q = s.match(/[“"「']([^”"」']{2,120})[”"」']/)
    if (q) return q[1].trim()
    const m = s.match(/(?:语音说|语音念|念一下|读一下|说一句|内容是)[：:，,]?\s*(.{2,120})$/)
    return m ? m[1].trim() : ''
  }

  const wantVoice = /(发|来|用|说)(条|个|句)?(语音|声音)|语音(说|回)|念(给我|一下)|读出来|听听你的?声/.test(msg.text || '');
  let voiced = false;
  if (wantVoice) {
    const spoken = spokenPayload(msg.text) || out.parts.join('，');
    const v = await hostSpeak(spoken, policy.voicePreset);
    if (v?.path) {
      console.log(`  [group] 语音合成成功（${v.ms}ms${v.cached ? '，命中缓存' : ''}）`);
      if (dry) console.log(`  [dry-run] 会发语音: ${spoken.slice(0, 40)}`);
      else {
        // ⚠️ 语音**不带回复引用**：QQ 把 [CQ:reply]+[CQ:record] 渲染成一个空气泡
        // （2026-10-30 实测：同一条音频单独发能听，带 reply 就成了「空消息」）
        const r = await callApi('send_group_msg', { group_id: Number(gid), message: recordCQ(stage(v.path, 'voice')) });
        const ok = sendOk(r);
        console.log(`  [group] 语音${ok ? '已发' : '发送失败'}`);
        if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
        if (ok) { store.pushSentId(gid, r?.data?.message_id); voiced = true; }
      }
      if (dry) voiced = true;
    } else {
      console.log('  [group] 语音没合成出来（没装 dsh-voice / 合成超时 / RVC 未连上）→ 退回文字');
    }
  }

  for (let i = 0; i < (voiced ? 0 : out.parts.length); i += 1) {
    const body = (i === 0 ? quote : '') + out.parts[i];
    if (dry) {
      console.log(`  [dry-run] 会发: ${body}`);
    } else {
      const r = await callApi('send_group_msg', { group_id: Number(gid), message: body });
      const ok = sendOk(r);
      if (ok) store.pushSentId(gid, r?.data?.message_id);
      console.log(`  [group] ${ok ? '已发' : '发送失败'}: ${out.parts[i]}`);
      if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
    }
    if (i < out.parts.length - 1) await sleep(700 + Math.random() * 900);
  }

  // 表情包
  if (out.stickers.length && Math.random() < 0.6) {
    const st = pickSticker(out.stickers[0]);
    if (st) {
      await sleep(500 + Math.random() * 700);
      if (dry) console.log(`  [dry-run] 会发表情包: ${st.desc}`);
      else {
        const r = await callApi('send_group_msg', { group_id: Number(gid), message: imageCQ(st.path) });
        const ok = sendOk(r);
        if (ok) store.rememberMedia(gid, r?.data?.message_id, { desc: st.desc, name: '小鲸鱼', kind: '表情包' });
        console.log(`  [group] 表情包${ok ? '已发' : '发送失败'}: ${st.desc}`);
        if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
      }
    }
  }

  // 找来的图（[[look:]] 的结果）：真发出去，别只在嘴上说"找着了"
  if (out.pictures?.length) {
    for (const pic of out.pictures.slice(0, 1)) {
      await sleep(600);
      if (dry) { console.log(`  [dry-run] 会发图: ${pic.url}`); continue; }
      const r = await sendPicture(gid, pic.url, callApi);
      if (r.ok) {
        store.rememberMedia(gid, r.messageId, { desc: pic.caption || '找来的图', name: '小鲸鱼', kind: '图片' });
        console.log(`  [group] 图已发（${pic.from}）`);
      } else {
        console.log(`  [group] 图没发出去：${r.reason}`);
      }
    }
  }

  // 语音：**只走确定性点歌**，模型自己塞的 [[voice:]] 一律不执行。
  // 之前就是这个口子让它在闲聊里乱发语音（"搞错号了" → 发了一首歌）。
  if (out.voices.length) {
    console.log(`  [group] 模型想发语音（${out.voices[0]}）→ 已忽略（语音只走点歌流程）`);
  }

  // ── 模型自主要唱（2026-10-28）──
  // 起因：群里让它"整个活"，它回了「唱首歌吧，别嫌难听」「这就来」然后**什么都没发**，
  //       连续三次放空炮。根因是"想唱"没有确定性出口 —— 点歌规则只管"别人点"。
  // 现在模型想唱必须带 [[sing:歌名]]，由这里真的去扒音频发出去（说了就得做到）。
  if (out.sings?.length) {
    const title = out.sings[0];
    console.log(`  [group] 模型自己要唱《${title}》→ 走点歌流程`);
    try {
      await runSingleSong({ query: title, raw: '', quiet: true }, { gid, uin, name, policy, callApi, evt });
    } catch (e) {
      console.error('  [group] 自主唱歌失败:', safeErr(e));
    }
  } else {
    // 没标记却答应了要唱：记一条，方便以后查（不改它的词，只留证据）
    const promisesSing = /(唱|哼).{0,4}(首|个|段|一下)|这就唱|这就来|来一首/.test(out.parts.join(' '));
    if (promisesSing) console.log('  [group] ⚠️ 它答应了要唱但没给 [[sing:歌名]] —— 不会发音频');
  }
  // 她自己想出声（[[voice:要念的话]]）：以前这里写死 if (false)，一律丢掉。
  // 结果就是「只有人明说要语音，她才有嗓子」，还学会了拿嗓子自嘲。
  // 2026-10-31 放开：2~40 字 → 掷骰子（默认 45%）→ 每天上限内就真发。
  if (!voiced && out.voices.length) {
    const say = String(out.voices[0]).replace(/\s+/g, ' ').trim().slice(0, 40);
    const used = store.loadStats(gid).voice ?? 0;
    const cap = Number(policy.voicePerDay ?? 12);
    const prob = Number(policy.voiceProb ?? 0.45);
    if (say.length < 2) {
      console.log('  [group] 语音文本太短，跳过');
    } else if (used >= cap) {
      console.log(`  [group] 今天语音已发 ${used}/${cap}，这条只发文字`);
    } else if (!dry && Math.random() > prob) {
      console.log(`  [group] 想发语音「${say}」→ 掷骰子没中（${Math.round(prob * 100)}%），只发文字`);
    } else {
      const v = await hostSpeak(say, policy.voicePreset);
      if (!v?.path) {
        console.log('  [group] 语音没合成出来（语音插件/RVC 未连上）→ 只发文字');
      } else if (dry) {
        console.log(`  [dry-run] 会自主发语音「${say}」（${v.ms}ms）`);
      } else {
        const r = await callApi('send_group_msg', { group_id: Number(gid), message: recordCQ(stage(v.path, 'voice')) });
        const ok = sendOk(r);
        console.log(`  [group] 自主语音${ok ? '已发' : '发送失败'}「${say}」`);
        if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
        if (ok) { store.pushSentId(gid, r?.data?.message_id); store.bumpStat(gid, 'voice'); }
      }
    }
  }

  store.pushSpoken(gid, out.parts.join(' '));
  const st = store.loadStats(gid);
  st.total = (st.total ?? 0) + out.parts.length;
  if (!hard) st.active = (st.active ?? 0) + 1;
  st.awaitingReply = store.nowSec();
  store.saveStats(gid, st);
  members.noteReply(msg.uin, out.parts.join(' '));

  audit(gid, {
    gid, uin: msg.uin, name: msg.name, reply: out.parts,
    stickers: out.stickers, voices: out.voices,
    dry, model: out.model, usage: out.usage, searched: out.searched, deferred: isDeferred,
  });
}

// ── 主人命令执行 ─────────────────────────────────────────

async function runCommand(cmd, { gid, uin, name, policy, callApi, at, evt, isPrivate = false }) {
  const dry = policy.dryRun !== false;
  const quote = evt?.message_id ? `[CQ:reply,id=${evt.message_id}]` : '';
  const send = async (body) => {
    if (dry) { console.log(`  [dry-run] 会发: ${body}`); return; }
    const r = await callApi('send_group_msg', { group_id: Number(gid), message: body });
    const ok = sendOk(r);
    if (ok) store.pushSentId(gid, r?.data?.message_id);
    console.log(`  [group] ${ok ? '已发' : '发送失败'}: ${body}`);
    if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
  };

  console.log(`  [cmd] ${isPrivate ? '私聊' : '主人'} ${name} → ${cmd.kind}${cmd.arg ? ' ' + cmd.arg : ''}`);

  // 禁言/撤回是群管动作，私聊里没有这个语义 —— 直接说清楚，别让它发一条失败的 API
  if (isPrivate && (cmd.kind === 'mute' || cmd.kind === 'recall')) {
    await send('私聊里没有禁言和撤回呀，那是在群里才有的');
    return true;
  }

  const r = await commands.execute(cmd, {
    gid, uin, name, policy, callApi, at,
    lastSentId: store.lastSentId(gid),
  });
  if (!r.handled) return false;

  if (r.action === 'voice' && cmd.full) {
    await runFullSong({ query: r.arg }, { gid, uin, name, policy, callApi, evt });
    return true;
  }

  if (r.action === 'voice') {
    if (!r.arg) { await send('唱什么呀，给个歌名'); return true; }
    await runSingleSong({ query: r.arg, full: false }, { gid, uin, name, policy, callApi, evt });
    return true;
  }

  if (r.action === 'sticker') {
    const st = pickSticker(r.arg || '');
    if (!st) { await send('表情包还没攒够诶'); return true; }
    if (dry) console.log(`  [dry-run] 会发表情包: ${st.desc}`);
    else await send(imageCQ(st.path));
    audit(gid, { gid, uin, cmd: cmd.kind, sticker: st.desc });
    return true;
  }

  if (r.action === 'search') {
    let block = '';
    try {
      const g = await gather(r.arg);
      block = g.hasResult ? g.block : '（什么都没搜到）';
      store.bumpStat(gid, 'search');
    } catch { block = '（搜索失败）'; }
    let answer = '';
    try {
      const out = await chat([
        { role: 'system', content: shortPersona() },
        { role: 'user', content: `主人让我查「${r.arg}」。下面是查到的：\n${block}\n\n用 1~2 句短话告诉他那是什么，别念百科、别列条目。` },
        { role: 'system', content: ANCHOR },
      ], { maxTokens: 800, temperature: 0.7, effort: 'low' });
      answer = out.text.replace(/\|\|\|/g, ' ').slice(0, 120);
    } catch { answer = block.slice(0, 100); }
    await send(quote + answer);
    audit(gid, { gid, uin, cmd: 'search', arg: r.arg, answer });
    return true;
  }

  if (r.reply) {
    // 命令回复也支持 ||| 分多条（跟生成那条路一致，2026-10-29 补）
    const parts = String(r.reply).split('|||').map((x) => x.trim()).filter(Boolean).slice(0, 3);
    for (let i = 0; i < parts.length; i += 1) {
      await send((i === 0 ? quote : '') + parts[i]);
      if (i < parts.length - 1) await sleep(600 + Math.random() * 700);
    }
  }
  audit(gid, { gid, uin, cmd: cmd.kind, arg: cmd.arg, reply: r.reply });
  return true;
}

/**
 * 标题清理：优先用用户点的那个词（标题里含它就直接用它），
 * 其次取「」里的（B站常用「」标歌名），最后才取《》，否则截断。
 * 例："《崩坏：星穹铁道》OP：「不眠之夜」" 点的是"不眠之夜" → 显示"不眠之夜"
 */
function cleanTitle(t, query = '') {
  const raw = String(t);
  const q = String(query).replace(/[《》「」"",，。]/g, '').trim();
  if (q && raw.includes(q)) return q.slice(0, 16);
  const corner = raw.match(/「([^」]{1,20})」/);
  if (corner) return `「${corner[1]}」`;
  const song = raw.match(/《([^》]{1,20})》/);
  if (song) return `《${song[1]}》`;
  return raw.replace(/【[^】]*】/g, '').trim().slice(0, 14);
}


/**
 * 整首分段发送
 * QQ 单条语音上限 60 秒，所以整首拆成多段（默认每段 59 秒，最多 6 段）。
 */
async function runFullSong({ query }, { gid, uin, name, policy, callApi, evt }) {
  const dry = policy.dryRun !== false;
  const quote = evt?.message_id ? `[CQ:reply,id=${evt.message_id}]` : '';
  const send = async (body) => {
    if (dry) { console.log(`  [dry-run] 会发: ${body}`); return; }
    const r = await callApi('send_group_msg', { group_id: Number(gid), message: body });
    const ok = sendOk(r);
    if (ok) store.pushSentId(gid, r?.data?.message_id);
    console.log(`  [group] ${ok ? '已发' : '发送失败'}: ${String(body).slice(0, 40)}`);
    if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
  };

  let q = String(query ?? '').trim();
  if (!q) q = store.lastSong(gid);
  if (!q) { await send('完整版哪首呀，说个歌名'); return true; }

  const used = store.loadStats(gid).fullSong ?? 0;
  const cap = Number(policy.fullSongPerDay ?? 999);
  if (cap > 0 && used >= cap) { await send('今天整首放太多啦，明天再放'); return true; }

  console.log(`  [group] 整首请求: ${q}`);
  await send(`${quote}整首有点长，我分段发`);

  const r = await makeVoiceFull(q, { maxSeg: Number(policy.fullSongMaxSeg ?? 12) });
  if (!r.ok) {
    await send(`没扒到（${r.reason}）`);
    audit(gid, { gid, uin, fullSong: q, ok: false, reason: r.reason });
    return true;
  }

  console.log(`  [group] 整首 ${r.total}s，分 ${r.count} 段${r.truncated ? '（截断）' : ''}`);

  for (let i = 0; i < r.segments.length; i += 1) {
    if (dry) {
      console.log(`  [dry-run] 会发第 ${i + 1}/${r.count} 段`);
    } else {
      const rr = await callApi('send_group_msg', {
        group_id: Number(gid), message: recordCQ(r.segments[i]),
      });
      const ok = sendOk(rr);
      console.log(`  [group] 第 ${i + 1}/${r.count} 段${ok ? '已发' : '发送失败'}`);
      if (!ok) console.error('          ', JSON.stringify(rr).slice(0, 200));
      if (ok) store.pushSentId(gid, rr?.data?.message_id);
    }
    if (i < r.segments.length - 1) await sleep(1500 + Math.random() * 1000);
  }

  if (r.truncated) {
    await send(`太长了，先发 ${r.count} 段（共 ${Math.round(r.total / 60)} 分钟）`);
  }

  store.bumpStat(gid, 'fullSong');
  store.setLastSong(gid, q);
  audit(gid, {
    gid, uin, fullSong: q, ok: true,
    total: r.total, count: r.count, truncated: r.truncated, cached: r.cached,
  });
  return true;
}


/** 失败原因要脱敏再发：execFile 的错误里可能带 Cookie */
function safeReason(r) {
  return String(r ?? '')
    .replace(/Cookie:\s*\S+/gi, 'Cookie:***')
    .replace(/SESSDATA=\S+/gi, 'SESSDATA=***')
    .replace(/bili_jct=\S+/gi, 'bili_jct=***')
    .slice(0, 60);
}

/** 被叫到但模型想沉默时的兜底话术（短、不客服腔、符合人设） */
const DEFLECT = [
  '这个我不干哦',
  '诶…这个不行',
  '换个要求吧',
  '不干不干',
  '这我可不敢',
  '别为难我啦',
];

function pickDeflect() {
  return DEFLECT[Math.floor(Math.random() * DEFLECT.length)];
}


/**
 * 单曲：扒一段 59 秒发出去
 * 搜不到时会用整句原文再试一次（"放生自己"这种连写的情况）
 */
async function runSingleSong({ query, raw = '', quiet = false }, { gid, uin, name, policy, callApi, evt }) {
  const dry = policy.dryRun !== false;
  const quote = evt?.message_id ? `[CQ:reply,id=${evt.message_id}]` : '';
  const send = async (body) => {
    if (dry) { console.log(`  [dry-run] 会发: ${body}`); return; }
    const r = await callApi('send_group_msg', { group_id: Number(gid), message: body });
    const ok = sendOk(r);
    if (ok) store.pushSentId(gid, r?.data?.message_id);
    console.log(`  [group] ${ok ? '已发' : '发送失败'}: ${String(body).slice(0, 40)}`);
  };

  const used = store.loadStats(gid).voice ?? 0;
  const cap = Number(policy.voicePerDay ?? 999);
  if (cap > 0 && used >= cap) { await send('今天放太多啦，明天再放'); return true; }

  console.log(`  [group] 点歌: ${query}`);
  let v = await makeVoice(query);
  if (!v.ok && /搜不到/.test(v.reason || '') && raw) {
    // 连写的歌名再试一次：把原句去掉"小鲸鱼/@/标点"整句当关键词
    const alt = String(raw)
      .replace(/@\d+/g, ' ').replace(/(小鲸鱼|鲸鱼)/g, ' ')
      .replace(/[《》"",，。、?？!！~～]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (alt && alt !== query) {
      console.log(`  [group] 「${query}」搜不到，换整句「${alt}」再试`);
      v = await makeVoice(alt);
    }
  }

  if (!v.ok) {
    await send(`没扒到这首歌诶（${safeReason(v.reason)}）`);
    audit(gid, { gid, uin, song: query, ok: false, reason: v.reason });
    return true;
  }

  if (dry) console.log(`  [dry-run] 会发语音: ${v.title}（${v.sec}s）`);
  else {
    const rr = await callApi('send_group_msg', { group_id: Number(gid), message: recordCQ(v.path) });
    const ok = sendOk(rr);
    console.log(`  [group] 语音${ok ? '已发' : '发送失败'}（${v.sec}s${v.cached ? '，缓存' : ''}）`);
    if (!ok) console.error('          ', JSON.stringify(rr).slice(0, 200));
    if (ok) store.pushSentId(gid, rr?.data?.message_id);
  }
  store.bumpStat(gid, 'voice');
  store.setLastSong(gid, query);
  // quiet = 模型自己已经说过"给你唱"，就别再补一句"给你放 X"（免得重复）
  if (!quiet) await send(`${quote}给你放 ${v.label || cleanTitle(v.title, query)}`);
  audit(gid, { gid, uin, song: query, ok: true, title: v.title, sec: v.sec, cached: v.cached });
  return true;
}
