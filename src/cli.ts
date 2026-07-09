#!/usr/bin/env node
/**
 * cvh CLI 入口（命令分发）。
 * P0 范围：install/uninstall/enable/disable/status/doctor/config/test-image + 两个 hook 入口。
 * P1：init 交互式安装向导。
 * P2：mcp install/uninstall/serve（`vision_ask`/`vision_describe_image`/`vision_describe_data_url`）。
 */

import { runInstall, runUninstall } from "./commands/install.js";
import { runInit } from "./commands/init.js";
import { runToggle } from "./commands/toggle.js";
import { runStatus } from "./commands/status.js";
import { runDoctor } from "./commands/doctor.js";
import { runConfigGet, runConfigSet } from "./commands/configCmd.js";
import { runTestImage } from "./commands/testImage.js";
import { runMcpInstall, runMcpUninstall, runMcpStatus, runMcpServe } from "./commands/mcpCmd.js";
import { handleUserPromptSubmit, type UserPromptSubmitInput } from "./hooks/userPromptSubmit.js";
import { handlePostToolUse, type PostToolUseInput } from "./hooks/postToolUse.js";

const printHelp = (): void => {
  console.log(`cc-vision-hook (cvh)

让"静默忽略图片"型模型（收到图片不报错、只是看不懂）也能理解 Claude Code 里的图片内容。
⚠️ 对"协议层硬拒绝"型模型（收到图片直接导致请求失败）无效，详见 \`cvh doctor\` 提示。

Usage:
  cvh init                       交互式安装向导（选 provider/model/apiKey，一步到位）
  cvh install                    非交互安装：创建配置 + 注册 Hook（幂等）
  cvh uninstall [--purge]        卸载：移除 Hook 注册（--purge 连带删除配置和缓存）
  cvh enable / cvh disable       开关（唯一决定是否处理图片的开关）
  cvh status                     查看当前状态
  cvh doctor                     自检（配置/Hook/视觉模型连通性 + 边界声明）
  cvh config get                 查看当前配置
  cvh config set <key> <value>   设置配置项（provider/model/baseUrl/apiKey/timeoutMs/maxTokens）
  cvh test-image <path>          手动测试：本地图片 -> 视觉解析
  cvh mcp install                注册 MCP server 到 ~/.claude.json（幂等，与 enabled 开关无关）
  cvh mcp uninstall              移除 MCP server 注册
  cvh mcp status                 查看 MCP server 注册状态
  cvh mcp serve                  以 stdio 模式启动 MCP server（由 Claude Code 调起，不要手动执行）

Global options:
  --json    以 JSON 格式输出（供脚本消费）
`);
};

/** 读取 stdin 全部内容（用于 hook 子命令）。 */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const jsonOutput = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [command, ...rest] = args;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
      printHelp();
      return;
    case "init":
      return runInit();
    case "install":
      return runInstall(jsonOutput);
    case "uninstall":
      return runUninstall(rest.includes("--purge"), jsonOutput);
    case "enable":
      return runToggle(true, jsonOutput);
    case "disable":
      return runToggle(false, jsonOutput);
    case "status":
      return runStatus(jsonOutput);
    case "doctor":
      return runDoctor(jsonOutput);
    case "config":
      if (rest[0] === "get") return runConfigGet(jsonOutput);
      if (rest[0] === "set" && rest[1] && rest[2]) return runConfigSet(rest[1], rest[2], jsonOutput);
      throw new Error("用法：cvh config get | cvh config set <key> <value>");
    case "test-image":
      if (!rest[0]) throw new Error("用法：cvh test-image <path>");
      return runTestImage(rest[0], jsonOutput);
    case "mcp":
      if (rest[0] === "install") return runMcpInstall(jsonOutput);
      if (rest[0] === "uninstall") return runMcpUninstall(jsonOutput);
      if (rest[0] === "status") return runMcpStatus(jsonOutput);
      if (rest[0] === "serve") return runMcpServe();
      throw new Error("用法：cvh mcp install | uninstall | status | serve");
    case "hook": {
      const raw = await readStdin();
      const payload = JSON.parse(raw || "{}") as { hook_event_name?: string };
      if (rest[0] === "user-prompt-submit" || payload.hook_event_name === "UserPromptSubmit") {
        const output = await handleUserPromptSubmit(payload as UserPromptSubmitInput);
        console.log(JSON.stringify(output));
        return;
      }
      if (rest[0] === "post-tool-use" || payload.hook_event_name === "PostToolUse") {
        const output = await handlePostToolUse(payload as PostToolUseInput);
        console.log(JSON.stringify(output));
        return;
      }
      // 未知 hook 事件，安全兜底返回空对象，不阻塞 Claude Code 流程。
      console.log("{}");
      return;
    }
    default:
      throw new Error(`未知命令：${command}。运行 \`cvh help\` 查看用法。`);
  }
};

main().catch((error: unknown) => {
  // hook 子命令即使出错也不能让 Claude Code 卡住，统一输出空对象兜底 + 把错误打到 stderr 供排查。
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cvh error: ${message}`);
  if (process.argv[2] === "hook") {
    console.log("{}");
    process.exit(0);
  }
  process.exit(1);
});
