/**
 * `cvh install` / `cvh uninstall` 命令实现。
 */

import { rm } from "node:fs/promises";
import { DEFAULT_CONFIG, getConfigPath, getCvhHomeDir, loadConfig, saveConfig } from "../config.js";
import { installHooks, uninstallHooks } from "../claudeSettings.js";

/**
 * 安装 cvh：创建配置文件（若不存在）+ 注册 Hook。幂等，可重复执行。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runInstall = async (jsonOutput: boolean): Promise<void> => {
  const existing = await loadConfig().catch(() => null);
  if (!existing) await saveConfig(DEFAULT_CONFIG);
  const added = await installHooks();

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, hooksAdded: added, configPath: getConfigPath() }));
    return;
  }
  console.log("✅ cvh 安装完成");
  console.log(`   配置文件：${getConfigPath()}`);
  console.log(`   新增 Hook 注册数：${added}（0 表示之前已安装过，本次是幂等重跑）`);
  console.log(`   ⚠️  当前默认 enabled=false，运行 \`cvh enable\` 后才会生效`);
  console.log(`   ⚠️  cvh 仅对"静默忽略图片"型模型有效，对协议层硬拒绝型模型（如某些不支持视觉的模型）无效，详见 README`);
};

/**
 * 卸载 cvh：移除 Hook 注册，可选连带删除配置和缓存。
 *
 * @param purge - 是否连带删除配置文件和缓存目录
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runUninstall = async (purge: boolean, jsonOutput: boolean): Promise<void> => {
  const removed = await uninstallHooks();
  if (purge) {
    await rm(getConfigPath(), { force: true });
    await rm(getCvhHomeDir(), { recursive: true, force: true });
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, hooksRemoved: removed, purged: purge }));
    return;
  }
  console.log("✅ cvh 卸载完成");
  console.log(`   移除 Hook 注册数：${removed}`);
  if (purge) console.log("   已删除配置文件与缓存目录（--purge）");
};
