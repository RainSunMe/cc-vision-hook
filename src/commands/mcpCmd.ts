/**
 * `cvh mcp install` / `cvh mcp uninstall` / `cvh mcp serve` 命令实现。
 *
 * 三个子命令与主开关（enabled）完全独立：install/uninstall 只负责注册/移除
 * `~/.claude.json` 里的 MCP server 条目，serve 才是真正跑 stdio server 的长驻进程入口。
 */

import { installMcpServer, uninstallMcpServer, checkMcpInstalled } from "../claudeMcp.js";
import { serveMcpStdio } from "../mcpServer.js";

/**
 * 安装 MCP server 注册（幂等）。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runMcpInstall = async (jsonOutput: boolean): Promise<void> => {
  const changed = await installMcpServer();
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, changed }));
    return;
  }
  console.log("✅ cvh MCP server 已注册到 ~/.claude.json");
  console.log(`   ${changed ? "本次为新增/更新条目" : "已经是最新状态，未发生变化"}`);
  console.log("   工具：vision_ask / vision_describe_image / vision_describe_data_url");
  console.log("   ⚠️  MCP 与主开关（enabled）无关，即使 cvh disable，Agent 仍可主动调用这些工具解析图片");
};

/**
 * 卸载 MCP server 注册。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runMcpUninstall = async (jsonOutput: boolean): Promise<void> => {
  const removed = await uninstallMcpServer();
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, removed }));
    return;
  }
  console.log(removed ? "✅ 已从 ~/.claude.json 移除 cc-vision-hook MCP server" : "⚠️  未发现已注册的 MCP server，无需移除");
};

/**
 * 打印 MCP 注册状态（供 `cvh mcp status` 或整合进 `cvh status` 使用）。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runMcpStatus = async (jsonOutput: boolean): Promise<void> => {
  const installed = await checkMcpInstalled();
  if (jsonOutput) {
    console.log(JSON.stringify({ installed }));
    return;
  }
  console.log(`MCP server 注册：${installed ? "✅ 已注册" : "❌ 未注册（运行 cvh mcp install）"}`);
};

/**
 * 以 stdio 模式启动 MCP server（由 Claude Code 作为子进程调起，不应由用户手动运行）。
 * 这是一个长驻进程，函数不会主动退出。
 */
export const runMcpServe = async (): Promise<void> => {
  await serveMcpStdio();
};
