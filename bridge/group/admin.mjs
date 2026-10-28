/**
 * 群管理权限（刻意做得很窄）
 *
 * 用户的硬要求：
 *   · 千万不能踢人 → 这里**根本不实现** kick，连 API 都不调
 *   · 禁言可以，但不能太久 → 上限 300 秒，超了直接拒绝
 *
 * 其余管理动作（改名片/头衔/群名/撤回别人消息/@全体）一律不提供。
 */
export const MUTE_MAX_SEC = Number(process.env.MUTE_MAX_SEC ?? 300);

/**
 * 禁言
 * @param {(action:string, params:object)=>Promise<any>} callApi
 * @returns {Promise<{ok:boolean, seconds?:number, reason?:string}>}
 */
export async function mute(callApi, { gid, uin, seconds, reason = '' }) {
  const sec = Math.floor(Number(seconds) || 0);
  if (!sec || sec <= 0) return { ok: false, reason: '时长无效' };
  if (sec > MUTE_MAX_SEC) {
    return { ok: false, reason: `超过上限 ${MUTE_MAX_SEC}s（请求 ${sec}s），已拒绝` };
  }
  const r = await callApi('set_group_ban', {
    group_id: Number(gid), user_id: Number(uin), duration: sec,
  });
  const ok = r?.status === 'ok' || r?.retcode === 0;
  console.log(`  [admin] 禁言 ${uin} ${sec}s（${reason}）→ ${ok ? '成功' : '失败'}`);
  return { ok, seconds: sec, reason };
}

/** 撤回自己的消息 */
export async function recallSelf(callApi, msgId) {
  const r = await callApi('delete_msg', { message_id: Number(msgId) });
  return r?.status === 'ok' || r?.retcode === 0;
}

/**
 * 踢人 —— 故意不实现。
 * 保留这个函数是为了让调用方明确看到"没有这个能力"，
 * 而不是某天有人在别处偷偷调 set_group_kick。
 */
export function kick() {
  return { ok: false, reason: '踢人功能未实现（按设计不提供）' };
}

/** 这些动作也一律不提供，列出来是为了让代码审查时一眼看到边界 */
export const FORBIDDEN = [
  'set_group_kick', 'set_group_kick_members',
  'set_group_card', 'set_group_special_title', 'set_group_name',
  'delete_msg(别人)', 'send_group_notice',
];
