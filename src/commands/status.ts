/**
 * `cvh status` 命令实现：展示开关状态、Hook 注册情况、缓存统计。
 */

import { loadConfig, getConfigPath } from "../config.js";
import { checkHooksInstalled } from "../claudeSettings.js";
import { countCacheEntries, getCacheDiskUsage } from "../cache.js";

/**
 * 打印当前 cvh 的运行状态。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runStatus = async (jsonOutput: boolean): Promise<void> => {
  const config = await loadConfig();
  const hooks = await checkHooksInstalled();
  const cacheCount = await countCacheEntries();
  const cacheBytes = await getCacheDiskUsage();

  const result = {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    configPath: getConfigPath(),
    hooksInstalled: hooks,
    cache: { entries: cacheCount, bytes: cacheBytes, ttlDays: config.cache.ttlDays },
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`开关状态：${config.enabled ? "✅ 已启用" : "⚠️  已停用"}`);
  console.log(`视觉 provider：${config.provider} / 模型：${config.model}`);
  console.log(`配置文件：${config.enabled ? "" : ""}${getConfigPath()}`);
  console.log(`Hook 注册：UserPromptSubmit=${hooks.userPromptSubmit ? "✅" : "❌"} PostToolUse=${hooks.postToolUse ? "✅" : "❌"}`);
  console.log(`本地缓存：${cacheCount} 条，约 ${(cacheBytes / 1024).toFixed(1)} KB，TTL ${config.cache.ttlDays} 天`);
};
