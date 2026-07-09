/**
 * 用户粘贴图片场景的扫描器：复用 Claude Code 官方在用户粘贴图片时会提前落盘的旁路事实。
 *
 * 依赖的实现细节（非官方承诺的稳定 API，best-effort，不做版本防御）：
 * `~/.claude/image-cache/<session_id>/<pasteId>.<ext>`
 * 该路径已通过泄露源码 `src/utils/imageStore.ts` 的 `getImageStoreDir()` 源码级确认，
 * `session_id` 与 hook input 里的顶层 `session_id` 字段是同一个值。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { getClaudeHomeDir } from "./config.js";
import { EXT_TO_MIME } from "./imageMime.js";

/** 一个已落盘的粘贴图片文件。 */
export interface PastedImageFile {
  path: string;
  mimeType: string;
  mtimeMs: number;
}

/**
 * 拼出指定 session 的 image-cache 目录路径。
 *
 * @param sessionId - Claude Code hook input 里的 `session_id` 字段
 * @returns 该 session 对应的图片缓存目录绝对路径
 */
export const getImageCacheDir = (sessionId: string): string => join(getClaudeHomeDir(), "image-cache", sessionId);

/**
 * 扫描指定 session 的 image-cache 目录，列出所有图片文件（按修改时间升序）。
 * 目录不存在时（如该 session 从未粘贴过图片）静默返回空数组，不抛错——
 * 这是预期中的常见情况，不是异常。
 *
 * @param sessionId - Claude Code hook input 里的 `session_id` 字段
 * @returns 该 session 目录下所有可识别的图片文件列表
 */
export const scanPastedImages = async (sessionId: string): Promise<PastedImageFile[]> => {
  const dir = getImageCacheDir(sessionId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const results: PastedImageFile[] = [];
  for (const name of entries) {
    const ext = extname(name).toLowerCase();
    const mimeType = EXT_TO_MIME[ext];
    if (!mimeType) continue;
    const fullPath = join(dir, name);
    try {
      const s = await stat(fullPath);
      results.push({ path: fullPath, mimeType, mtimeMs: s.mtimeMs });
    } catch {
      // 文件可能在扫描过程中被清理，忽略
    }
  }
  results.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return results;
};

/**
 * 读取指定图片文件的字节内容。
 *
 * @param path - 图片文件绝对路径
 * @returns 图片二进制数据
 */
export const readPastedImageBytes = async (path: string): Promise<Buffer> => readFile(path);
