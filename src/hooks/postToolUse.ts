/**
 * `PostToolUse` Hook 处理逻辑。
 *
 * matcher 建议设为 `*`（匹配所有工具），检测逻辑在 hook 内部完成，不依赖工具名白名单——
 * 这样能自动覆盖未来任何新工具。性能上已实测验证：Bun 进程启动 + import
 * AI SDK provider 包耗时在 10ms 级别，可以接受挂在所有工具调用上。
 *
 * 只追加不替换：本 Hook 永远只输出 additionalContext，不使用 updatedToolOutput——
 * 因为目标模型是"静默忽略型"，不需要真的把 image block 从 tool_response 里挪走，
 * 只需要给模型补一段文字描述（这也是本项目相比"替换"方案最大的简化点）。
 */

import { resolveConfig } from "../config.js";
import { extractImages } from "../extract.js";
import { findCacheByBytes, putCacheEntry } from "../cache.js";
import { describeImage } from "../vision.js";
import type { HookOutput } from "./userPromptSubmit.js";

/** Claude Code 传给 `PostToolUse` hook 的 stdin payload（仅取用到的字段）。 */
export interface PostToolUseInput {
  session_id: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
}

/**
 * 处理一次 `PostToolUse` 事件。
 *
 * @param input - Claude Code 传入的 hook payload
 * @returns 供 Claude Code 消费的 hook 输出（enabled=false 或未检测到图片时返回空对象）
 */
export const handlePostToolUse = async (input: PostToolUseInput): Promise<HookOutput> => {
  const config = await resolveConfig();
  if (!config.enabled) return {};

  const images = extractImages(input.tool_response);
  if (images.length === 0) return {};

  const blocks: string[] = [];
  for (const image of images) {
    try {
      const bytes = Buffer.from(image.base64, "base64");
      let entry = await findCacheByBytes(bytes);
      if (!entry) {
        const description = await describeImage(image.base64, image.mimeType, config);
        entry = await putCacheEntry(bytes, image.mimeType, input.tool_name, description, config.cache.ttlDays);
      }
      blocks.push(`<tool_image_vision id="${entry.imageId}" tool="${input.tool_name}">\n${entry.description}\n</tool_image_vision>`);
    } catch (error) {
      blocks.push(
        `<tool_image_vision error="true" tool="${input.tool_name}">图片解析失败：${error instanceof Error ? error.message : String(error)}</tool_image_vision>`,
      );
    }
  }

  if (blocks.length === 0) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: blocks.join("\n"),
    },
  };
};
