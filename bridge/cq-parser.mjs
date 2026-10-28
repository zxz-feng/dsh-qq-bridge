/**
 * OneBot v11 CQ 码解析
 *
 * 输入形如: "你好[CQ:face,id=178]在吗[CQ:image,file=abc.image,url=https://..]"
 * 输出:     { text: "你好[斜眼笑]在吗[发来一张图片]", images: [{url,file}] }
 *
 * 设计要点：
 * - 系统表情查 face-map.json 转中文名；未收录显示 [表情:id]
 * - 图片/表情包收集到 images 数组，交给视觉识别
 * - @、回复、语音、文件等都转成可读描述
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
let FACE_MAP = {};
try {
  const raw = JSON.parse(readFileSync(DIR + 'face-map.json', 'utf8'));
  delete raw._note;
  FACE_MAP = raw;
} catch { /* 表缺失时降级为 [表情:id] */ }

/** 解析 CQ 码参数字符串 "a=1,b=2,c=3" */
function parseParams(s) {
  const out = {};
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i);
    let v = part.slice(i + 1);
    // CQ 码里的转义
    v = v
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&amp;/g, '&');
    out[k] = v;
  }
  return out;
}

/**
 * 解析一条 OneBot 消息（string 格式或 array 格式都支持）
 * @returns {{ text: string, images: Array<{url?:string, file?:string}>, at: string[] }}
 */
export function parseCQ(input) {
  const images = [];
  const at = [];
  let text = '';

  // array 格式：消息段
  if (Array.isArray(input)) {
    for (const seg of input) {
      const type = seg?.type;
      const d = seg?.data ?? {};
      text += segmentText(type, d, images, at);
    }
    return { text: text.trim(), images, at };
  }

  // string 格式：CQ 码
  // 参数里可能含方括号（如 summary=[图片]），所以要手动配对：
  // 从 [CQ: 开始，找到后面第一个不是 [CQ: 开头的 ] 才算结束。
  const raw = typeof input === 'string' ? input : '';
  const unescape = (t) => t.replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',').replace(/&amp;/g, '&');

  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf('[CQ:', i);
    if (start === -1) {
      text += unescape(raw.slice(i));
      break;
    }
    // 前面的普通文本
    text += unescape(raw.slice(i, start));

    // 配对结束括号：CQ 码的参数值里可能含方括号（如 summary=[图片]），
    // 所以遇到 `=` 后紧跟 `[` 的情况，先跳过对应的 ]。
    let j = start + 4;
    let end = -1;
    while (j < raw.length) {
      // 形如 "参数名=[" 时，跳到匹配的 ]
      const tail = raw.slice(j);
      const kv = tail.match(/^([a-zA-Z_]+)=\[/);
      if (kv) {
        const close = raw.indexOf(']', j + kv[0].length);
        j = close === -1 ? raw.length : close + 1;
        continue;
      }
      if (raw[j] === ']') { end = j; break; }
      j += 1;
    }
    if (end === -1) {           // 未闭合，当作普通文本
      text += unescape(raw.slice(start));
      break;
    }

    const inner = raw.slice(start + 4, end);       // "face,id=178"
    const comma = inner.indexOf(',');
    const type = comma === -1 ? inner : inner.slice(0, comma);
    const params = comma === -1 ? '' : inner.slice(comma + 1);
    text += segmentText(type, parseParams(params), images, at);
    i = end + 1;
  }

  return { text: text.trim(), images, at };
}

function segmentText(type, d, images, at) {
  switch (type) {
    case 'text':
      return d.text ?? '';

    case 'face': {
      const name = FACE_MAP[String(d.id)];
      return name ? `[${name}]` : `[表情:${d.id}]`;
    }

    case 'mface': {
      // QQ 大表情/表情包，有 summary 就用
      const s = (d.summary ?? '').replace(/^\[|\]$/g, '').trim();
      return s ? `[${s}]` : '[表情包]';
    }

    case 'image': {
      // sub_type=1 通常是收藏表情
      const isSticker = String(d.sub_type) === '1' || /表情/.test(d.summary ?? '');
      images.push({ url: d.url, file: d.file, sticker: isSticker });
      return isSticker ? '[发来一个表情包]' : '[发来一张图片]';
    }

    case 'at': {
      const qq = d.qq ?? d.user_id;
      at.push(String(qq));
      return `@${d.name ?? qq}`;
    }

    case 'reply':
      // 引用标记本身不带语义，跳过（正文另行解析）
      return '';

    case 'record':
      return '[发来一条语音]';

    case 'video':
      return '[发来一个视频]';

    case 'file':
      return `[发来文件：${d.name ?? d.file ?? '未命名'}]`;

    case 'location':
      return '[发来一个位置]';

    case 'contact':
      return '[发来一张名片]';

    case 'share':
      return `[分享链接：${d.title ?? d.url ?? ''}]`;

    case 'forward':
      return '[发来一条转发消息]';

    case 'json':
    case 'xml':
      return '[发来一条卡片消息]';

    case 'poke':
      return '[戳了戳你]';

    case 'dice':
      return '[掷骰子]';

    case 'rps':
      return '[猜拳]';

    case 'music':
      return `[分享音乐：${d.title ?? ''}]`;

    default:
      return type ? `[${type}]` : '';
  }
}

export default parseCQ;
