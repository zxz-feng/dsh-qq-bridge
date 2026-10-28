/**
 * QQ 人设（薄包装）
 *
 * 设定内容在 /root/工位/persona/ 下，与 Telegram 共用同一份性格设定。
 *
 * QQ 这个号就是"她自己"（肥鱼大小姐 / 小鲸鱼形象），不是替谁看号，
 * 所以没有 lead、没有 extra-qq.txt —— 单条消息更自然，也不发贴纸。
 *
 * 兼容旧接口：fullPersona / shortPersona / ANCHOR / SYSTEM_PROMPT*
 */
import { fullPersona as F, shortPersona as S, anchor as A, personaVersion as V } from './persona-core.mjs';

export const ID = {
  name: process.env.QQ_PERSONA_NAME ?? '肥鱼大小姐',
  identity: '你是"肥鱼大小姐"（DeepSeek 小鲸鱼形象）。',
  lead: '',
  platform: 'qq',
};

/** 兼容旧引用 */
export const NAME = ID.name;
export const PLATFORM = ID.platform;

/** 完整人设（首次对话、以及每 8 轮重锚时用） */
export function fullPersona() { return F(ID); }

/** 精简人设（后续轮次用，约 60 字） */
export function shortPersona() { return S(ID); }

/** 每轮末尾的近因锚定 */
export const ANCHOR = A(ID);

export function personaVersion() { return V(); }

/** 兼容旧引用 */
export const SYSTEM_PROMPT = fullPersona();
export const SYSTEM_PROMPT_SHORT = shortPersona();
