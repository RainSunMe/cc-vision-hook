/**
 * Session 级"已展示过的图片"标记，避免 `UserPromptSubmit` 在同一 session 内每次提交
 * 都把之前已经处理过的粘贴图片重新塞进 `additionalContext`（图片本身走全局内容 hash 缓存，
 * 不需要重新调视觉模型，但如果不做这层过滤，上下文会随对话轮数不断膨胀重复信息）。
 *
 * 存储位置：`~/.claude/cc-vision-hook/seen/<session_id>.json`，内容是已展示过的 image_id 数组。
 * 不设 TTL——生命周期跟随 session，session 目录本身很小（几十个 id 字符串），无需主动清理，
 * 后续如需要可以在 doctor/cleanup 命令里一并按 mtime 清掉太旧的标记文件。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCvhHomeDir } from "./config.js";

const getSeenPath = (sessionId: string): string => join(getCvhHomeDir(), "seen", `${sessionId}.json`);

/**
 * 读取指定 session 已经展示过的 image_id 集合。
 *
 * @param sessionId - Claude Code session id
 * @returns 已展示过的 image_id 集合，文件不存在时返回空集合
 */
export const loadSeenImageIds = async (sessionId: string): Promise<Set<string>> => {
  try {
    const raw = await readFile(getSeenPath(sessionId), "utf8");
    const ids = JSON.parse(raw) as string[];
    return new Set(ids);
  } catch {
    return new Set();
  }
};

/**
 * 把一批新的 image_id 追加写入 session 的"已展示"标记文件。
 *
 * @param sessionId - Claude Code session id
 * @param newIds - 本次新展示的 image_id 列表
 */
export const markImagesSeen = async (sessionId: string, newIds: string[]): Promise<void> => {
  if (newIds.length === 0) return;
  const existing = await loadSeenImageIds(sessionId);
  for (const id of newIds) existing.add(id);
  const path = getSeenPath(sessionId);
  await mkdir(join(getCvhHomeDir(), "seen"), { recursive: true });
  await writeFile(path, JSON.stringify([...existing]));
};
