/**
 * `cvh enable` / `cvh disable` 命令实现：只写配置文件的 enabled 字段，不涉及 Hook 注册。
 */

import { loadConfig, saveConfig } from "../config.js";

/**
 * 设置 enabled 字段并落盘。
 *
 * @param enabled - 目标开关状态
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runToggle = async (enabled: boolean, jsonOutput: boolean): Promise<void> => {
  const config = await loadConfig();
  config.enabled = enabled;
  await saveConfig(config);

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, enabled }));
    return;
  }
  console.log(enabled ? "✅ cvh 已启用" : "⚠️  cvh 已停用");
};
