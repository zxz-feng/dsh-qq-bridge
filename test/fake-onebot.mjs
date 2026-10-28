/**
 * 假 OneBot 服务（测 WS 链路用）
 *
 * 起一个 OneBot v11 的 WebSocket 服务，连上就推一条群消息事件，
 * 然后把 bridge 发回来的 API 调用打印出来。
 *
 * 用法：
 *   node tools/fake-onebot.mjs            # 监听 3002
 *   OB_URL=ws://127.0.0.1:3002 node bridge.mjs
 *
 * 它不会连真 QQ，纯粹验证"事件进 → 决策 → API 出"这条线通不通。
 */
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.FAKE_PORT ?? 3002);
const GID = Number(process.env.FAKE_GID ?? 100001);
const UIN = Number(process.env.FAKE_UIN ?? 1001);

const wss = new WebSocketServer({ port: PORT });
console.log(`[fake-onebot] 监听 ws://127.0.0.1:${PORT}`);

wss.on('connection', (ws) => {
  console.log('[fake-onebot] bridge 已连接');

  ws.on('message', (raw) => {
    let j;
    try { j = JSON.parse(raw.toString()); } catch { return; }
    // 这是 bridge 发来的 API 调用
    console.log(`[fake-onebot] ← ${j.action} ${JSON.stringify(j.params).slice(0, 160)}`);
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 777001 }, echo: j.echo }));
  });

  // 连上 1 秒后推一条 @ 我的群消息
  setTimeout(() => {
    const evt = {
      post_type: 'message',
      message_type: 'group',
      group_id: GID,
      user_id: UIN,
      message_id: 888001,
      raw_message: '@小鲸鱼 在吗',
      message: [
        { type: 'at', data: { qq: '10001000' } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
      sender: { user_id: UIN, nickname: '测试员', card: '测试员' },
    };
    ws.send(JSON.stringify(evt));
    console.log('[fake-onebot] → 推了一条 @ 我的群消息');
  }, 1000);
});

wss.on('error', (e) => console.error('[fake-onebot] 错误:', e.message));
