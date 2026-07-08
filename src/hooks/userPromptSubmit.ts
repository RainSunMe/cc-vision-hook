/**
 * `UserPromptSubmit` Hook 处理逻辑。
 *
 * 流程：enabled? -> 扫描 ~/.claude/image-cache/<session_id>/ -> 过滤未处理过的图片
 *       -> 逐个"查缓存命中?/视觉解析->写缓存" -> 拼接 additionalContext。
 *
 * 只追加不替换：本 Hook 永远只输出 additionalContext，不尝试修改/删除原始 prompt
 * （Claude Code 官方文档明确 UserPromptSubmit 无法替换 prompt，只能追加）。
 */

import { resolveConfig } from "../config.js";
import { scanPastedImages, readPastedImageBytes } from "../pasteScanner.js";
import { findCacheByBytes, putCacheEntry, computeImageId } from "../cache.js";
import { describeImage } from "../vision.js";
import { loadSeenImageIds, markImagesSeen } from "../seenTracker.js";

/** Claude Code 传给 `UserPromptSubmit` hook 的 stdin payload（仅取用到的字段）。 */
export interface UserPromptSubmitInput {
  session_id: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

/** Hook 的标准输出结构。 */
export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

/**
 * 处理一次 `UserPromptSubmit` 事件。
 *
 * @param input - Claude Code 传入的 hook payload
 * @returns 供 Claude Code 消费的 hook 输出（enabled=false 或没有新图片时返回空对象）
 */
export const handleUserPromptSubmit = async (input: UserPromptSubmitInput): Promise<HookOutput> => {
  const config = await resolveConfig();
  if (!config.enabled) return {};

  const pastedImages = await scanPastedImages(input.session_id);
  if (pastedImages.length === 0) return {};

  const seenIds = await loadSeenImageIds(input.session_id);
  const blocks: string[] = [];
  const newlySeenIds: string[] = [];

  for (const file of pastedImages) {
    try {
      const bytes = await readPastedImageBytes(file.path);
      const imageId = computeImageId(bytes);
      // 本 session 内已经展示过的图片不再重复塞进 additionalContext（内容 hash 缓存本身仍全局共享，
      // 这里只是过滤"要不要在这一轮上下文里再提一次"，避免多轮对话后上下文线性膨胀）。
      if (seenIds.has(imageId)) continue;

      let entry = await findCacheByBytes(bytes);
      if (!entry) {
        const base64 = bytes.toString("base64");
        const description = await describeImage(base64, file.mimeType, config);
        entry = await putCacheEntry(bytes, file.mimeType, "paste", description, config.cache.ttlDays);
      }
      blocks.push(`<image_vision id="${entry.imageId}">\n${entry.description}\n</image_vision>`);
      newlySeenIds.push(entry.imageId);
    } catch (error) {
      // 单张图片解析失败不应该阻断整个提交流程，跳过并继续处理其他图片。
      blocks.push(`<image_vision error="true">图片解析失败：${error instanceof Error ? error.message : String(error)}</image_vision>`);
    }
  }

  if (newlySeenIds.length > 0) await markImagesSeen(input.session_id, newlySeenIds);
  if (blocks.length === 0) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: blocks.join("\n"),
    },
  };
};
