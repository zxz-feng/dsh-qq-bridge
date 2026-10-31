#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站小工具（给 QQ 群聊用）

复用刷B站插件的登录凭证和 bilibili_api，做三件事：
  search <关键词> [数量]   搜视频，返回 BV 号/标题/播放量
  hot                      取 B站热搜词
  info <BV号>              取视频时长/标题

跑在插件的 .venv 里（那里有 bilibili_api）：
    /root/dsh/bili-duty/.venv/bin/python bili.py search 雨爱 5

输出统一 JSON，方便 Node 侧解析。
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.environ.get('BILI_SITE', '/root/dsh/bili-duty'))

from bilibili_api import search, hot, video, Credential  # noqa: E402

CRED_FILE = os.environ.get('BILI_CRED', '/root/dsh/bili-duty/bili_credential.json')


def load_cred():
    try:
        with open(CRED_FILE, encoding='utf-8') as f:
            d = json.load(f)
        return Credential(
            sessdata=d.get('sessdata', ''),
            bili_jct=d.get('bili_jct', ''),
            buvid3=d.get('buvid3') or '',
            dedeuserid=d.get('dedeuserid', ''),
        )
    except Exception:
        return None


def clean(s):
    return str(s or '').replace('<em class="keyword">', '').replace('</em>', '').strip()


async def cmd_search(kw, num):
    cred = load_cred()
    r = await search.search_by_type(
        keyword=kw,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=search.OrderVideo.CLICK,
    )
    out = []
    for it in (r.get('result') or [])[:num]:
        out.append({
            'bvid': it.get('bvid', ''),
            'title': clean(it.get('title')),
            'author': it.get('author', ''),
            'play': it.get('play', 0),
            'duration': it.get('duration', ''),
            'desc': clean(it.get('description'))[:100],
        })
    return {'ok': True, 'keyword': kw, 'videos': out}


async def cmd_upsong(uid, kw, pages=3):
    """在某个 UP 主（原曲搬运号）的投稿里按标题找歌。

    2026-10-31 主人指路：想要原曲就别在站内大搜，直接去 VV音乐局 / JLRS-LeoFM
    这类"放原曲"的 UP 投稿里翻。站内搜索对这些号权重很低，翻投稿反而准。
    """
    from bilibili_api import user as bili_user

    cred = load_cred()
    u = bili_user.User(int(uid), credential=cred)
    hits = []
    for pn in range(1, max(1, pages) + 1):
        r = await u.get_videos(pn=pn, ps=30)
        vl = (r.get('list') or {}).get('vlist') or []
        for v in vl:
            t = clean(v.get('title'))
            if kw and kw in t:
                hits.append({
                    'bvid': v.get('bvid', ''),
                    'title': t,
                    'author': v.get('author', ''),
                    'play': v.get('play', 0),
                    'duration': v.get('length', ''),
                    'desc': clean(v.get('description'))[:100],
                })
        if hits:
            break
    return {'ok': True, 'keyword': kw, 'uid': int(uid), 'videos': hits}


async def cmd_hot():
    cred = load_cred()
    r = await hot.get_hot_buzzwords(page_num=1, page_size=30)
    words = []
    # 返回结构随版本变，宽松解析：抓所有含 "keyword"/"word"/"show_name" 的字段
    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ('keyword', 'word', 'show_name', 'name') and isinstance(v, str) and v.strip():
                    words.append(v.strip())
                else:
                    walk(v)
        elif isinstance(x, list):
            for i in x:
                walk(i)
    walk(r)
    seen, uniq = set(), []
    for w in words:
        if w not in seen:
            seen.add(w)
            uniq.append(w)
    return {'ok': True, 'hot': uniq[:30]}


async def cmd_info(bvid):
    cred = load_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    return {
        'ok': True,
        'bvid': bvid,
        'title': clean(info.get('title')),
        'duration': info.get('duration', 0),
        'author': (info.get('owner') or {}).get('name', ''),
        'desc': clean(info.get('desc'))[:150],
    }


async def cmd_danmaku(bvid, num=300):
    """取弹幕时间点，用来找"弹幕最密"的高潮段（切歌用）"""
    cred = load_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    cid = info.get('cid')
    dan = await v.get_danmaku().get_danmaku_view(cid) if False else None
    # 直接用官方弹幕接口
    from bilibili_api import sync  # noqa: F401
    data = await v.get_danmakus(0)
    times = []
    for d in data[:num]:
        try:
            times.append(float(d.dm_time))
        except Exception:
            pass
    return {'ok': True, 'bvid': bvid, 'times': times}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'ok': False, 'error': 'no command'}))
        return 1
    cmd = sys.argv[1]
    try:
        if cmd == 'search':
            kw = sys.argv[2]
            num = int(sys.argv[3]) if len(sys.argv) > 3 else 5
            out = asyncio.run(cmd_search(kw, num))
        elif cmd == 'upsong':
            out = asyncio.run(cmd_upsong(sys.argv[2], sys.argv[3],
                                        int(sys.argv[4]) if len(sys.argv) > 4 else 3))
        elif cmd == 'hot':
            out = asyncio.run(cmd_hot())
        elif cmd == 'info':
            out = asyncio.run(cmd_info(sys.argv[2]))
        elif cmd == 'danmaku':
            out = asyncio.run(cmd_danmaku(sys.argv[2]))
        else:
            out = {'ok': False, 'error': 'unknown command ' + cmd}
    except Exception as e:
        out = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
