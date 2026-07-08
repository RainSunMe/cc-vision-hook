/**
 * cache.ts 单测：内容 hash 去重、TTL 过期清理、image_id 查询。
 *
 * 用 `CVH_CLAUDE_HOME` 指向一个临时目录，隔离真实 `~/.claude`，
 * 每个测试用例前后清理，避免相互污染或污染开发机真实环境。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "cvh-cache-test-"));
  process.env.CVH_CLAUDE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpHome, { recursive: true, force: true });
});

describe("computeImageId", () => {
  test("同样的字节内容总是产生同样的 image_id（内容寻址）", async () => {
    const { computeImageId } = await import("../src/cache");
    const bytesA = Buffer.from("hello image bytes");
    const bytesB = Buffer.from("hello image bytes");
    expect(computeImageId(bytesA)).toBe(computeImageId(bytesB));
  });

  test("不同字节内容产生不同的 image_id", async () => {
    const { computeImageId } = await import("../src/cache");
    const idA = computeImageId(Buffer.from("image A"));
    const idB = computeImageId(Buffer.from("image B"));
    expect(idA).not.toBe(idB);
  });

  test("image_id 带有 img_ 前缀", async () => {
    const { computeImageId } = await import("../src/cache");
    expect(computeImageId(Buffer.from("x"))).toMatch(/^img_[0-9a-f]{16}$/);
  });
});

describe("putCacheEntry / findCacheByBytes / getCacheEntry", () => {
  test("写入后可以按字节内容命中缓存（跨来源同一张图只解析一次的核心机制）", async () => {
    const { putCacheEntry, findCacheByBytes } = await import("../src/cache");
    const bytes = Buffer.from("fake png bytes");
    await putCacheEntry(bytes, "image/png", "Read", "一张测试图片", 7);

    const hit = await findCacheByBytes(bytes);
    expect(hit).not.toBeNull();
    expect(hit?.description).toBe("一张测试图片");
    expect(hit?.sourceTool).toBe("Read");
    expect(hit?.mimeType).toBe("image/png");
  });

  test("不同内容的图片不会互相命中缓存", async () => {
    const { putCacheEntry, findCacheByBytes } = await import("../src/cache");
    await putCacheEntry(Buffer.from("image one"), "image/png", "Read", "描述一", 7);
    const miss = await findCacheByBytes(Buffer.from("image two, never cached"));
    expect(miss).toBeNull();
  });

  test("getCacheEntry 按 image_id 精确查询", async () => {
    const { putCacheEntry, getCacheEntry } = await import("../src/cache");
    const entry = await putCacheEntry(Buffer.from("some bytes"), "image/jpeg", "paste", "描述", 7);
    const fetched = await getCacheEntry(entry.imageId);
    expect(fetched?.imageId).toBe(entry.imageId);
  });

  test("getCacheEntry 查询不存在的 image_id 返回 null", async () => {
    const { getCacheEntry } = await import("../src/cache");
    expect(await getCacheEntry("img_doesnotexist0000")).toBeNull();
  });

  test("getCachedImageBytes 能取回原始字节（供 vision_ask 追问复用）", async () => {
    const { putCacheEntry, getCachedImageBytes } = await import("../src/cache");
    const original = Buffer.from("original image bytes for reuse");
    const entry = await putCacheEntry(original, "image/png", "Read", "desc", 7);
    const restored = await getCachedImageBytes(entry.imageId);
    expect(restored?.equals(original)).toBe(true);
  });
});

describe("TTL 过期清理", () => {
  test("已过期的条目在下一次 findCacheByBytes 调用时被惰性清理，且查不到", async () => {
    const { putCacheEntry, findCacheByBytes } = await import("../src/cache");
    const bytes = Buffer.from("soon to expire");
    // ttlDays 传负数，让 expiresAt 落在过去，模拟"已过期"状态。
    await putCacheEntry(bytes, "image/png", "Read", "will expire", -1);

    const result = await findCacheByBytes(bytes);
    expect(result).toBeNull();
  });

  test("未过期的条目不受清理影响", async () => {
    const { putCacheEntry, findCacheByBytes } = await import("../src/cache");
    const bytes = Buffer.from("still valid");
    await putCacheEntry(bytes, "image/png", "Read", "still valid desc", 7);
    const result = await findCacheByBytes(bytes);
    expect(result?.description).toBe("still valid desc");
  });
});

describe("countCacheEntries / getCacheDiskUsage", () => {
  test("空缓存目录返回 0", async () => {
    const { countCacheEntries, getCacheDiskUsage } = await import("../src/cache");
    expect(await countCacheEntries()).toBe(0);
    expect(await getCacheDiskUsage()).toBe(0);
  });

  test("写入多条后数量和磁盘占用符合预期", async () => {
    const { putCacheEntry, countCacheEntries, getCacheDiskUsage } = await import("../src/cache");
    await putCacheEntry(Buffer.from("aaa"), "image/png", "Read", "d1", 7);
    await putCacheEntry(Buffer.from("bbbbbb"), "image/png", "Read", "d2", 7);
    expect(await countCacheEntries()).toBe(2);
    expect(await getCacheDiskUsage()).toBeGreaterThan(0);
  });
});
