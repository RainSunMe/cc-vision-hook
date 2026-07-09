/**
 * pasteScanner.ts 单测：验证 image-cache 目录扫描、扩展名过滤、按 mtime 排序、
 * 目录不存在时的静默降级行为。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "cvh-pastescanner-test-"));
  process.env.CVH_CLAUDE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpHome, { recursive: true, force: true });
});

describe("getImageCacheDir", () => {
  test("拼出 <claudeHome>/image-cache/<session_id> 路径", async () => {
    const { getImageCacheDir } = await import("../src/pasteScanner");
    expect(getImageCacheDir("abc-123")).toBe(join(tmpHome, "image-cache", "abc-123"));
  });
});

describe("scanPastedImages", () => {
  test("session 目录不存在时静默返回空数组，不抛错", async () => {
    const { scanPastedImages } = await import("../src/pasteScanner");
    expect(await scanPastedImages("never-existed-session")).toEqual([]);
  });

  test("只识别白名单扩展名（png/jpg/jpeg/webp/gif），忽略其他文件", async () => {
    const dir = join(tmpHome, "image-cache", "session-a");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.png"), Buffer.from("fake png"));
    await writeFile(join(dir, "notes.txt"), "not an image");
    await writeFile(join(dir, "b.jpeg"), Buffer.from("fake jpeg"));

    const { scanPastedImages } = await import("../src/pasteScanner");
    const results = await scanPastedImages("session-a");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.mimeType).sort()).toEqual(["image/jpeg", "image/png"]);
  });

  test("按 mtime 升序排序（先粘贴的图片排在前面）", async () => {
    const dir = join(tmpHome, "image-cache", "session-b");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "newer.png"), Buffer.from("newer"));
    await writeFile(join(dir, "older.png"), Buffer.from("older"));
    // 显式设置 mtime，避免文件系统时间精度导致的排序不稳定。
    const now = new Date();
    await utimes(join(dir, "older.png"), new Date(now.getTime() - 10000), new Date(now.getTime() - 10000));
    await utimes(join(dir, "newer.png"), now, now);

    const { scanPastedImages } = await import("../src/pasteScanner");
    const results = await scanPastedImages("session-b");
    expect(results.map((r) => r.path.split("/").pop())).toEqual(["older.png", "newer.png"]);
  });
});

describe("readPastedImageBytes", () => {
  test("读取指定路径的原始字节", async () => {
    const dir = join(tmpHome, "image-cache", "session-c");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "img.png");
    await writeFile(filePath, Buffer.from("raw bytes here"));

    const { readPastedImageBytes } = await import("../src/pasteScanner");
    const bytes = await readPastedImageBytes(filePath);
    expect(bytes.toString()).toBe("raw bytes here");
  });
});
