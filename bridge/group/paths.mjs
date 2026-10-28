/**
 * 宿主机 ↔ NapCat 容器的路径映射
 *
 * NapCat 跑在 podman 容器里，它看到的文件系统和宿主机不是一套。
 * 直接把 `file:///root/工位/...` 丢给 send_group_msg，容器里找不到这个路径：
 *
 *   {"status":"failed","retcode":1200,
 *    "message":"Failed to open input: No such file or directory"}
 *
 * 容器唯一可写又能被宿主机访问的挂载点是：
 *   宿主机 /root/工位/qq-bridge/napcat-data  →  容器 /app/napcat/config
 *
 * 所以所有要发出去的媒体文件都放这里，CQ 码里用容器路径。
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DIR = fileURLToPath(new URL('.', import.meta.url));

/** 宿主机侧（写文件用） */
// 用 resolve 归一化：不然路径里会留着 "group/../"，字符串比较匹配不上
export const HOST_MEDIA = process.env.MEDIA_DIR
  ? resolve(process.env.MEDIA_DIR)
  : resolve(DIR, '../napcat-data/media');
/** 容器侧（写进 CQ 码用） */
// NapCat 跑在容器里时，它看到的是容器路径；本地直装（Windows/桌面）就填本地路径，
// 或者干脆两边一样（把 MEDIA_DIR 指到 NapCat 能读到的地方）。
export const CQ_MEDIA = process.env.CQ_MEDIA || '/app/napcat/config/media';

for (const sub of ['voice', 'stickers', 'images']) {
  const p = `${HOST_MEDIA}/${sub}`;
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** 宿主机绝对路径 → 容器内路径 */
export function toContainerPath(hostPath) {
  if (hostPath.startsWith(HOST_MEDIA)) return hostPath.replace(HOST_MEDIA, CQ_MEDIA);
  return hostPath;
}

/** 宿主机绝对路径 → CQ 码能用的 file:// 地址 */
export function toFileUrl(hostPath) {
  return `file://${toContainerPath(hostPath)}`;
}

/** 把文件复制进挂载区（用于已经在别处的文件） */
export function stage(hostPath, sub = 'images') {
  const name = hostPath.split('/').pop();
  const dst = `${HOST_MEDIA}/${sub}/${name}`;
  if (hostPath !== dst) copyFileSync(hostPath, dst);
  return dst;
}
