/**
 * `cvh install` / `cvh uninstall` 命令实现。
 */

import { rm } from "node:fs/promises";
import { DEFAULT_CONFIG, configFileExists, getConfigPath, getCvhHomeDir, saveConfig } from "../config.js";
import { installHooks, uninstallHooks } from "../claudeSettings.js";
import { uninstallMcpServer } from "../claudeMcp.js";

/**
 * 安装 cvh：创建配置文件（若不存在）+ 注册 Hook。幂等，可重复执行。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runInstall = async (jsonOutput: boolean): Promise<void> => {
  // 注意：不能用 loadConfig().catch(...) 判断文件是否存在——loadConfig() 内部自带
  // try/catch 兜底，文件不存在时会静默返回默认配置对象而不是抛错，外层 catch 永远不会
  // 触发。之前的实现正是因为这个假设错误，导致 cvh install 从未真正创建过配置文件。
  const existed = await configFileExists();
  if (!existed) await saveConfig(DEFAULT_CONFIG);
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
 * 卸载 cvh：移除 Hook 注册 + MCP server 注册，可选连带删除配置和缓存。
 * MCP 注册无论是否 `--purge` 都会移除——保留配置/缓存但留一个孤立的 MCP server 注册
 * 没有意义（用户显式执行了 uninstall，说明不想再让 Claude Code 感知到 cvh 的存在）。
 *
 * @param purge - 是否连带删除配置文件和缓存目录
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runUninstall = async (purge: boolean, jsonOutput: boolean): Promise<void> => {
  const removed = await uninstallHooks();
  const mcpRemoved = await uninstallMcpServer();
  if (purge) {
    await rm(getConfigPath(), { force: true });
    await rm(getCvhHomeDir(), { recursive: true, force: true });
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, hooksRemoved: removed, mcpRemoved, purged: purge }));
    return;
  }
  console.log("✅ cvh 卸载完成");
  console.log(`   移除 Hook 注册数：${removed}`);
  console.log(`   MCP server 注册：${mcpRemoved ? "已移除" : "未发现（无需移除）"}`);
  if (purge) console.log("   已删除配置文件与缓存目录（--purge）");
};
