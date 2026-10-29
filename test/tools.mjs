// 工具回合的离线测试：不联网、不花 token。
// 覆盖 2026-10-29 那五个 gap 的"骨架"：URL 抽取、正文剥离、声优抠取、标记解析、失败文案。

import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const web = await import('../bridge/group/webpage.mjs');
const look = await import('../bridge/group/lookup.mjs');
const gen = await import('../bridge/group/generate.mjs');

// ── URL 抽取 ──
t('extractUrl 认得裸链接', () => {
  assert.equal(web.extractUrl('看这个 https://zh.moegirl.org.cn/结城希亚 好好笑'), 'https://zh.moegirl.org.cn/结城希亚');
});
t('extractUrl 不吃中文句号', () => {
  assert.equal(web.extractUrl('https://a.com/x。'), 'https://a.com/x');
});
t('extractUrl 没链接返回空串', () => {
  assert.equal(web.extractUrl('今天吃啥'), '');
});

// ── 站点识别 ──
t('siteOf 认贴吧/萌娘/B站', () => {
  assert.equal(web.siteOf('https://tieba.baidu.com/p/123'), '贴吧');
  assert.equal(web.siteOf('https://zh.moegirl.org.cn/结城希亚'), '萌娘百科');
  assert.equal(web.siteOf('https://www.bilibili.com/video/BV1xx'), 'B站');
});
t('siteOf 坏链接不炸', () => {
  assert.equal(web.siteOf('不是链接'), '网页');
});

// ── 正文剥离 ──
t('htmlToText 丢脚本/样式，块级转换行', () => {
  const h = '<script>var a=1</script><style>.a{}</style><p>第一段正文内容在这里</p><p>第二段也够长的文字</p>';
  const s = web.htmlToText(h);
  assert.ok(!s.includes('var a'), '脚本没清掉');
  assert.ok(s.includes('第一段正文内容在这里'));
  assert.ok(s.split('\n').length >= 2, '没转换成多行');
});
t('htmlToText 解实体', () => {
  assert.ok(web.htmlToText('<p>a&amp;b&nbsp;c 够长了吧</p>').includes('a&b'));
});
t('htmlToText 短行（导航按钮）被丢掉', () => {
  assert.ok(!web.htmlToText('<div>登录</div><div>这一行是真正的正文内容</div>').includes('登录'));
});

// ── 声优抠取 ──
t('pickCv 抠出两个名字并切掉括号', () => {
  assert.deepEqual(look.pickCv('声优 夏和小 藤田茜 （全年龄版、动画） 萌点 中二病'), ['夏和小', '藤田茜']);
});
t('pickCv 没有就返回空', () => {
  assert.deepEqual(look.pickCv('这页没写谁配的音'), []);
});

// ── 失败文案（不许空白，必须能照着说话）──
t('pageBlock 失败时带原因', () => {
  const s = web.pageBlock({ ok: false, reason: '要登录' });
  assert.ok(s.includes('看不了') && s.includes('要登录'));
});
t('pageBlock 成功时带站点与正文', () => {
  const s = web.pageBlock({ ok: true, site: '萌娘百科', title: '结城希亚', text: '她是……' });
  assert.ok(s.includes('萌娘百科') && s.includes('结城希亚') && s.includes('她是'));
});

// ── 标记解析 ──
t('pickHint 认得出语境（乌有乡那条的教训）', () => {
  assert.equal(gen.pickHint('这乌有乡也太变态了', '有汉化版吗'), 'galgame');
  assert.equal(gen.pickHint('新番出了吗', '这个番好看'), '动画');
  assert.equal(gen.pickHint('今天天气不错'), '');
});

t('parseReply 吃掉 read/info/look/tieba 四个标记', () => {
  const r = gen.parseReply('看看[[read:https://a.com]]|||这个[[look:结城希亚]]|||[[info:乌有乡]]|||[[tieba:乌有乡 攻略]]');
  assert.deepEqual(r.tiebas, ['乌有乡 攻略']);
  assert.deepEqual(r.reads, ['https://a.com']);
  assert.deepEqual(r.looks, ['结城希亚']);
  assert.deepEqual(r.infos, ['乌有乡']);
  assert.ok(!r.parts.join('').includes('[['), '标记没吃干净');
});
t('parseReply 保留老的 sing/sticker', () => {
  const r = gen.parseReply('来一段[[sing:雨爱]] [[sticker:笑]]');
  assert.deepEqual(r.sings, ['雨爱']);
  assert.deepEqual(r.stickers, ['笑']);
});

console.log(`\n===== ${fail ? '✗' : '✓'} 工具回合 ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
