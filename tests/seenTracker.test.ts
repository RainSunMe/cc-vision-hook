/**
 * seenTracker.ts 单测：验证 session 级"已展示过的图片"标记的读写、
 * 追加合并语义、以及不同 session 互不干扰。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "cvh-seentracker-test-"));
  process.env.CVH_CLAUDE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpHome, { recursive: true, force: true });
});

describe("loadSeenImageIds", () => {
  test("从未标记过的 session 返回空集合", async () => {
    const { loadSeenImageIds } = await import("../src/seenTracker");
    const ids = await loadSeenImageIds("never-seen-session");
    expect(ids.size).toBe(0);
  });
});

describe("markImagesSeen / loadSeenImageIds", () => {
  test("标记后能读回同样的 id 集合", async () => {
    const { markImagesSeen, loadSeenImageIds } = await import("../src/seenTracker");
    await markImagesSeen("session-a", ["img_1", "img_2"]);
    const ids = await loadSeenImageIds("session-a");
    expect(ids).toEqual(new Set(["img_1", "img_2"]));
  });

  test("多次标记是追加合并，不覆盖之前的记录", async () => {
    const { markImagesSeen, loadSeenImageIds } = await import("../src/seenTracker");
    await markImagesSeen("session-b", ["img_1"]);
    await markImagesSeen("session-b", ["img_2"]);
    const ids = await loadSeenImageIds("session-b");
    expect(ids).toEqual(new Set(["img_1", "img_2"]));
  });

  test("重复标记同一个 id 不产生重复（Set 去重）", async () => {
    const { markImagesSeen, loadSeenImageIds } = await import("../src/seenTracker");
    await markImagesSeen("session-c", ["img_1"]);
    await markImagesSeen("session-c", ["img_1", "img_2"]);
    const ids = await loadSeenImageIds("session-c");
    expect([...ids].sort()).toEqual(["img_1", "img_2"]);
  });

  test("空数组调用不产生任何文件写入副作用", async () => {
    const { markImagesSeen, loadSeenImageIds } = await import("../src/seenTracker");
    await markImagesSeen("session-d", []);
    const ids = await loadSeenImageIds("session-d");
    expect(ids.size).toBe(0);
  });

  test("不同 session 互不干扰", async () => {
    const { markImagesSeen, loadSeenImageIds } = await import("../src/seenTracker");
    await markImagesSeen("session-e1", ["img_shared"]);
    const idsE2 = await loadSeenImageIds("session-e2");
    expect(idsE2.size).toBe(0);
    const idsE1 = await loadSeenImageIds("session-e1");
    expect(idsE1).toEqual(new Set(["img_shared"]));
  });
});
