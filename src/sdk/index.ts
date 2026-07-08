/**
 * cvh SDK 导出：供其他 Node/Bun 项目直接内置调用（不需要 shell 调 CLI）。
 * 例如某个上层 CLI/Agent 工具若要集成 cvh 的能力判断/内置调用，可以直接 import 这里的函数。
 */

export type { CvhConfig, CvhProvider } from "../config.js";
export { DEFAULT_CONFIG, loadConfig, saveConfig, resolveConfig } from "../config.js";

export { installHooks, uninstallHooks, checkHooksInstalled } from "../claudeSettings.js";

export { extractImages, type ExtractedImage } from "../extract.js";
export { describeImage } from "../vision.js";
export { computeImageId, findCacheByBytes, putCacheEntry, getCacheEntry, getCachedImageBytes, type CacheEntry } from "../cache.js";

export { handleUserPromptSubmit, type UserPromptSubmitInput, type HookOutput } from "../hooks/userPromptSubmit.js";
export { handlePostToolUse, type PostToolUseInput } from "../hooks/postToolUse.js";
