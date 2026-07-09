/**
 * `cvh status` 命令实现：展示开关状态、Hook 注册情况、缓存统计。
 */

import { loadConfig, getConfigPath } from "../config.js";
import { checkHooksInstalled } from "../claudeSettings.js";
import { checkMcpInstalled } from "../claudeMcp.js";
import { countCacheEntries, getCacheDiskUsage } from "../cache.js";

/**
 * 打印当前 cvh 的运行状态。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runStatus = async (jsonOutput: boolean): Promise<void> => {
  const config = await loadConfig();
  const hooks = await checkHooksInstalled();
  // MCP 注册状态实时读取 ~/.claude.json，而不是 config.mcpInstalled 静态字段——
  // 后者仅作展示用途的历史字段，不会被 mcp install/uninstall 更新，容易与真实状态不一致。
  const mcpInstalled = await checkMcpInstalled();
  const cacheCount = await countCacheEntries();
  const cacheBytes = await getCacheDiskUsage();

  const result = {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    configPath: getConfigPath(),
    hooksInstalled: hooks,
    mcpInstalled,
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
  console.log(`MCP server：${mcpInstalled ? "✅ 已注册" : "❌ 未注册（运行 cvh mcp install）"}`);
  console.log(`本地缓存：${cacheCount} 条，约 ${(cacheBytes / 1024).toFixed(1)} KB，TTL ${config.cache.ttlDays} 天`);
};
