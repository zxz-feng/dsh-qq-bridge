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
import { learn, lookup, download, imageCQ, pickSticker } from './media.mjs';
import { makeVoice, makeVoiceFull, recordCQ, judgeSong } from './voice.mjs';
import { hotwords, gather } from './search.mjs';
import * as commands from './commands.mjs';
import { chat } from './llm.mjs';
import { shortPersona, ANCHOR } from './persona.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
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
  const g = cfg.groups?.[String(gid)] ?? null;
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

export async function handleGroupMessage(evt, { callApi }) {
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

  const atMe = (parsed.at ?? []).some((x) => String(x) === SELF);
  const replyMatch = rawMsg.match(/\[CQ:reply,id=(-?\d+)\]/);
  const replyToMe = replyMatch ? store.isMyMessage(gid, replyMatch[1]) : false;
  const hasImage = (parsed.images?.length ?? 0) > 0;

  // ── 刷屏判定（主人豁免；阈值/静默时长可在群策略里调）──
  // ⚠️ 2026-10-29 线上真实故障：对骂时对方 8 条/分钟就被判刷屏、锁 10 分钟，
  //    之后**连 @ 都不回** —— 使用者看到的是「被骂了几句突然不理人」。
  //    现在：① 硬触发（@/回复/叫名字）不受刷屏静默影响；
  //         ② 阈值和时长交给群策略（spamThreshold / spamSeconds），对骂场景自己放宽。
  const hardTrigger = atMe || replyToMe
    || (policy.selfNick ?? []).some((n) => n && text.includes(n));
  const spam = commands.isOwner(uin, policy)
    ? { spam: false }
    : members.checkSpam(uin, {
      threshold: Number(policy.spamThreshold ?? 8),
      seconds: Number(policy.spamSeconds ?? 600),
    });
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
        if (r) imageDesc += `\n[${name}发了${img.sticker ? '表情包' : '图片'}：${r.desc}]`;
      }
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
      const done = await runCommand(cmd, { gid, uin, name, policy, callApi, at: parsed.at ?? [], evt });
      if (done) return;
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

  const d = decide({
    text: displayText,
    atMe,
    isOwner: commands.isOwner(uin, policy),
    isWhale: members.isOtherWhale(name, policy.otherWhales?.pattern ?? '鲸鱼'),
    replyToMe,
    gapSec,
    policy,
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
      gid, policy, msg: { uin, name, text: displayText, atMe }, evt, callApi, hard: d.hard,
    });
    return;
  }
  if (d.deferSec) {
    scheduleDeferred(gid, { uin, name, text: displayText, atMe }, d.deferSec, policy, callApi, evt, d.hard);
  }
}

// ── 生成 + 发送 ──────────────────────────────────────────

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

  for (let i = 0; i < out.parts.length; i += 1) {
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
        console.log(`  [group] 表情包${ok ? '已发' : '发送失败'}: ${st.desc}`);
        if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
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
  if (false) {
    const used = store.loadStats(gid).voice ?? 0;
    if (used < Number(policy.voicePerDay ?? 3)) {
      console.log(`  [group] 准备语音: ${out.voices[0]}`);
      const v = await makeVoice(out.voices[0]);
      if (v.ok) {
        if (dry) console.log(`  [dry-run] 会发语音: ${v.title}（${v.sec}s）`);
        else {
          const r = await callApi('send_group_msg', { group_id: Number(gid), message: recordCQ(v.path) });
          const ok = sendOk(r);
          console.log(`  [group] 语音${ok ? '已发' : '发送失败'}（${v.sec}s）`);
          if (!ok) console.error('          ', JSON.stringify(r).slice(0, 200));
        }
        store.bumpStat(gid, 'voice');
        store.setLastSong(gid, out.voices[0]);   // 之后用户只说"完整版"也能接上
      } else {
        console.log(`  [group] 语音没做成: ${v.reason}`);
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

async function runCommand(cmd, { gid, uin, name, policy, callApi, at, evt }) {
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

  console.log(`  [cmd] 主人 ${name} → ${cmd.kind}${cmd.arg ? ' ' + cmd.arg : ''}`);

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

  if (r.reply) await send(quote + r.reply);
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
