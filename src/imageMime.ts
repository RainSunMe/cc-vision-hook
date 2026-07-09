/**
 * 图片文件扩展名 -> MIME 类型的共享映射表。
 *
 * 之前 `pasteScanner.ts`/`testImage.ts` 各自维护了一份相同的映射，MCP 的
 * `vision_describe_image` 工具也需要同样的逻辑，抽成单一来源避免三处漂移。
 */

import { extname } from "node:path";

export const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * 根据文件路径的扩展名推断 MIME 类型。
 *
 * @param path - 文件路径（只看扩展名，不检查文件是否存在）
 * @returns 识别出的 MIME 类型，扩展名未知时返回 undefined
 */
export const mimeFromPath = (path: string): string | undefined => EXT_TO_MIME[extname(path).toLowerCase()];
