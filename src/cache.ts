/**
 * 图片解析结果的本地磁盘缓存。
 *
 * 设计决策：
 * - Key：图片字节内容的 sha256（内容寻址，天然去重，跨来源——粘贴/工具产图——同一张图只解析一次）；
 * - 作用域：全局共享，不按 session/project 隔离；
 * - TTL：7 天，惰性清理（读写时顺带清理过期条目，不需要常驻后台任务）；
 * - 存储位置：`~/.claude/cc-vision-hook/cache/`，每个条目一对文件（`.json` 元数据 + `.bin` 原图字节）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getCvhHomeDir } from "./config.js";

export interface CacheEntry {
  /** 缓存条目 ID（等于内容 sha256 的前缀，作为对外暴露的 image_id）。 */
  imageId: string;
  mimeType: string;
  createdAt: string;
  expiresAt: string;
  /** 产生这张图片的工具名（如 "Read"、"Bash"、"mcp__xxx__yyy"），粘贴场景下为 "paste"。 */
  sourceTool: string;
  description: string;
}

const getCacheDir = (): string => join(getCvhHomeDir(), "cache");

const metaPath = (imageId: string): string => join(getCacheDir(), `${imageId}.json`);
const binPath = (imageId: string): string => join(getCacheDir(), `${imageId}.bin`);

/**
 * 对图片原始字节计算内容 hash，作为缓存 key（image_id）。
 *
 * @param bytes - 图片的原始二进制数据
 * @returns 64 位十六进制 sha256 摘要，取前 16 位加 `img_` 前缀作为短 ID
 */
export const computeImageId = (bytes: Buffer): string => {
  const full = createHash("sha256").update(bytes).digest("hex");
  return `img_${full.slice(0, 16)}`;
};

/**
 * 按 TTL 惰性清理过期缓存条目。每次读写缓存时调用一次，成本很低（只扫元数据文件）。
 *
 * @param ttlDays - 配置里的 TTL 天数，仅用于新建条目时计算 expiresAt，本函数只看条目自带的 expiresAt
 */
const cleanupExpired = async (): Promise<void> => {
  const dir = getCacheDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return; // 目录还不存在，无需清理
  }
  const now = Date.now();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const imageId = file.slice(0, -".json".length);
    try {
      const raw = await readFile(join(dir, file), "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (new Date(entry.expiresAt).getTime() < now) {
        await unlink(metaPath(imageId)).catch(() => {});
        await unlink(binPath(imageId)).catch(() => {});
      }
    } catch {
      // 元数据损坏，直接按过期处理，避免脏数据常驻
      await unlink(join(dir, file)).catch(() => {});
    }
  }
};

/**
 * 按 image_id 查询缓存条目（元数据），命中且未过期才返回。
 *
 * @param imageId - 缓存条目 ID
 * @returns 命中的元数据，未命中或已过期返回 null
 */
export const getCacheEntry = async (imageId: string): Promise<CacheEntry | null> => {
  try {
    const raw = await readFile(metaPath(imageId), "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (new Date(entry.expiresAt).getTime() < Date.now()) return null;
    return entry;
  } catch {
    return null;
  }
};

/**
 * 读取缓存条目对应的原图字节（用于 `vision_ask` 追问时重新提问）。
 *
 * @param imageId - 缓存条目 ID
 * @returns 原图二进制数据，不存在时返回 null
 */
export const getCachedImageBytes = async (imageId: string): Promise<Buffer | null> => {
  try {
    return await readFile(binPath(imageId));
  } catch {
    return null;
  }
};

/**
 * 按内容 hash 查找是否已有缓存（用于"命中即跳过视觉解析调用"）。
 *
 * @param bytes - 图片原始字节
 * @returns 命中的缓存条目，未命中返回 null
 */
export const findCacheByBytes = async (bytes: Buffer): Promise<CacheEntry | null> => {
  await cleanupExpired();
  return getCacheEntry(computeImageId(bytes));
};

/**
 * 写入一条新的缓存条目：落盘原图字节 + 元数据（含描述文本），并计算好 TTL 过期时间。
 *
 * @param bytes - 图片原始字节
 * @param mimeType - 图片 MIME 类型
 * @param sourceTool - 产生这张图片的工具名
 * @param description - 视觉模型给出的描述文本
 * @param ttlDays - 缓存有效期（天），来自用户配置
 * @returns 写入后的缓存条目（含 image_id，供 additionalContext 引用）
 */
export const putCacheEntry = async (
  bytes: Buffer,
  mimeType: string,
  sourceTool: string,
  description: string,
  ttlDays: number,
): Promise<CacheEntry> => {
  await mkdir(getCacheDir(), { recursive: true });
  const imageId = computeImageId(bytes);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  const entry: CacheEntry = {
    imageId,
    mimeType,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sourceTool,
    description,
  };
  await writeFile(binPath(imageId), bytes);
  await writeFile(metaPath(imageId), JSON.stringify(entry, null, 2));
  return entry;
};

/**
 * 统计当前缓存条目数量，用于 `cvh status` 展示。
 *
 * @returns 未过期的缓存条目数量
 */
export const countCacheEntries = async (): Promise<number> => {
  await cleanupExpired();
  try {
    const files = await readdir(getCacheDir());
    return files.filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

/**
 * 获取缓存目录占用的磁盘大小（字节），用于 `cvh status`/`doctor` 展示。
 *
 * @returns 缓存目录总大小（字节），目录不存在时返回 0
 */
export const getCacheDiskUsage = async (): Promise<number> => {
  let total = 0;
  try {
    const dir = getCacheDir();
    const files = await readdir(dir);
    for (const file of files) {
      const s = await stat(join(dir, file));
      total += s.size;
    }
  } catch {
    return 0;
  }
  return total;
};
