/**
 * 对 `~/.claude.json` 里 `mcpServers.cc-vision-hook` 条目的幂等读写。
 *
 * 注意与 `claudeSettings.ts`（Hook 注册，写 `~/.claude/settings.json`）的区别：
 * MCP server 注册写的是 `~/.claude.json`（用户级全局配置，与 Hook 配置文件不是同一个文件）。
 * 两者是完全独立的开关，遵循既定设计：`cvh disable` 不卸载 MCP，`cvh mcp install` 不影响 enabled。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getClaudeHomeDir } from "./config.js";

/** MCP server 在 `~/.claude.json` 里注册的固定名字，同时作为幂等标识。 */
export const MCP_SERVER_NAME = "cc-vision-hook";

interface McpServerEntry {
  type: "stdio";
  command: string;
  args: string[];
}

interface ClaudeGlobalConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * `~/.claude.json` 的路径。与 `getClaudeHomeDir()`（`~/.claude/` 目录）是两个不同的东西——
 * 真实 Claude Code 场景下 `~/.claude.json` 和 `~/.claude/` 目录同级（都在 `$HOME` 下），
 * 这里始终从 `getClaudeHomeDir()` 的父目录推导，不做任何字符串匹配猜测，也不在推导失败时
 * 回退到真实 `homedir()`——单测/隔离环境下 `CVH_CLAUDE_HOME` 可能被设成任意路径（不一定
 * 以 `.claude` 结尾），如果这里悄悄兜底到真实 `homedir()`，会有污染开发者真实
 * `~/.claude.json` 的风险，必须严格用 `dirname()` 推导，不猜测任何字符串模式。
 *
 * @returns `~/.claude.json` 的绝对路径
 */
const getGlobalConfigPath = (): string => join(dirname(getClaudeHomeDir()), ".claude.json");

/**
 * 读取 `~/.claude.json`，文件不存在或解析失败时返回空对象（不覆盖用户已有配置）。
 *
 * @returns 解析后的全局配置对象
 */
const readGlobalConfig = async (): Promise<ClaudeGlobalConfig> => {
  try {
    const raw = await readFile(getGlobalConfigPath(), "utf8");
    return JSON.parse(raw) as ClaudeGlobalConfig;
  } catch {
    return {};
  }
};

/**
 * 写回 `~/.claude.json`。
 *
 * @param config - 完整的全局配置对象
 */
const writeGlobalConfig = async (config: ClaudeGlobalConfig): Promise<void> => {
  await writeFile(getGlobalConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

/**
 * 幂等地在 `~/.claude.json` 中注册 `cc-vision-hook` MCP stdio server。
 * 已存在同名条目时直接覆盖（确保 command/args 始终指向当前可执行文件路径，
 * 例如用户重新全局安装到不同路径后，重新运行 install 能自动纠正）。
 *
 * @returns 本次是否发生了实际写入变化（新增或内容变化），false 表示已经是最新状态
 */
export const installMcpServer = async (): Promise<boolean> => {
  const config = await readGlobalConfig();
  config.mcpServers ??= {};
  const desired: McpServerEntry = { type: "stdio", command: "cvh", args: ["mcp", "serve"] };
  const existing = config.mcpServers[MCP_SERVER_NAME];
  const changed = !existing || existing.command !== desired.command || JSON.stringify(existing.args) !== JSON.stringify(desired.args);
  config.mcpServers[MCP_SERVER_NAME] = desired;
  await writeGlobalConfig(config);
  return changed;
};

/**
 * 从 `~/.claude.json` 移除 `cc-vision-hook` MCP server 注册，不影响用户配置的其他 MCP server。
 *
 * @returns 本次是否实际移除了条目（false 表示原本就没安装）
 */
export const uninstallMcpServer = async (): Promise<boolean> => {
  const config = await readGlobalConfig();
  if (!config.mcpServers || !(MCP_SERVER_NAME in config.mcpServers)) return false;
  delete config.mcpServers[MCP_SERVER_NAME];
  await writeGlobalConfig(config);
  return true;
};

/**
 * 检查 MCP server 是否已注册（用于 `cvh status`/`doctor`）。
 *
 * @returns 是否已注册
 */
export const checkMcpInstalled = async (): Promise<boolean> => {
  const config = await readGlobalConfig();
  return Boolean(config.mcpServers?.[MCP_SERVER_NAME]);
};
