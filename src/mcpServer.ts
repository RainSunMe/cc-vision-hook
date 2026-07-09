/**
 * MCP stdio server：暴露 `vision_ask` / `vision_describe_image` / `vision_describe_data_url`
 * 三个工具，让 Claude 主模型在对话中可以主动追问此前已被 Hook 处理过的图片，
 * 或直接解析一张新的本地图片/data URL（不依赖磁盘缓存命中）。
 *
 * 设计对齐 docs/research/cc-vision-hook/design-2026-07-08.md §8.3：
 * - `vision_ask`：按 image_id 从磁盘缓存取回原图字节，用 describeImage() 追问，
 *   不写回缓存的 description 字段（避免用一次追问的针对性回答覆盖掉原本的通用描述）。
 * - `vision_describe_image` / `vision_describe_data_url`：直接解析，不依赖历史缓存命中，
 *   但解析结果仍然按内容 hash 落盘缓存，方便后续 `vision_ask` 追问同一张图。
 *
 * MCP 本身与 enabled 开关无关（见 claudeSettings.ts 顶部注释的既定设计：
 * "cvh disable 不卸载 MCP，cvh enable 不安装 MCP"）——但工具执行时仍然遵守 enabled
 * 开关，因为调用视觉模型本身就是"处理图片"这件事，enabled=false 时应视为功能关闭。
 */

import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveConfig } from "./config.js";
import { describeImage } from "./vision.js";
import { getCacheEntry, getCachedImageBytes, putCacheEntry } from "./cache.js";
import { mimeFromPath } from "./imageMime.js";

/** data URI 正则：形如 `data:image/png;base64,xxxx`，与 extract.ts 保持一致。 */
const DATA_URI_RE = /^data:(image\/[a-z0-9.+_-]+);base64,(.+)$/i;

/**
 * 构造一个 MCP 文本结果，成功/失败均用统一 shape 返回（`isError` 标志区分），
 * 让 Agent 侧可以稳定判断调用是否成功，而不是靠解析文本内容猜测。
 *
 * @param text - 返回给 Agent 的文本内容
 * @param isError - 是否是错误结果
 * @returns 符合 MCP CallToolResult 结构的对象
 */
const textResult = (text: string, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * 创建并配置好三个视觉工具的 MCP Server 实例（尚未连接 transport）。
 * 拆成独立函数是为了方便单测：可以直接调用 `server.server` 上的能力做集成测试，
 * 不需要真的起一个 stdio 子进程。
 *
 * @returns 配置完毕、可直接 connect(transport) 的 McpServer 实例
 */
export const createVisionMcpServer = (): McpServer => {
  const server = new McpServer({ name: "cc-vision-hook", version: "0.1.1" });

  server.registerTool(
    "vision_ask",
    {
      title: "追问已解析过的图片",
      description:
        "针对此前已被 cvh（UserPromptSubmit/PostToolUse Hook 或本 MCP 的其他工具）处理过的图片，" +
        "向视觉模型追加提问（如询问图片局部细节、读取图中文字等）。需要先从 additionalContext 里的 " +
        "image_vision/tool_image_vision 标签拿到 image_id。",
      inputSchema: {
        imageId: z.string().describe("additionalContext 中提供的 image_id，形如 img_xxxxxxxxxxxxxxxx"),
        question: z.string().describe("希望追问的具体问题"),
      },
    },
    async ({ imageId, question }) => {
      const entry = await getCacheEntry(imageId);
      if (!entry) {
        // 明确的文字错误而不是静默失败，呼应设计文档 §8.3：缓存过期/不存在时要让 Agent 知道原因。
        return textResult(`未找到 image_id="${imageId}" 对应的缓存条目（可能已过期或从未存在）。请重新提供图片。`, true);
      }
      const bytes = await getCachedImageBytes(imageId);
      if (!bytes) {
        return textResult(`缓存元数据存在但原图字节缺失（image_id="${imageId}"），无法追问，请重新提供图片。`, true);
      }
      const config = await resolveConfig();
      try {
        const answer = await describeImage(bytes.toString("base64"), entry.mimeType, config, question);
        return textResult(answer);
      } catch (error) {
        return textResult(`视觉模型调用失败：${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  server.registerTool(
    "vision_describe_image",
    {
      title: "解析本地图片文件",
      description: "直接解析一张本地图片文件的内容，不依赖历史缓存命中。适用于 Agent 想主动查看某个本地文件的场景。",
      inputSchema: {
        path: z.string().describe("本地图片文件的绝对或相对路径"),
        question: z.string().optional().describe("可选：具体想问的问题，省略则给出通用描述"),
      },
    },
    async ({ path, question }) => {
      const mimeType = mimeFromPath(path);
      if (!mimeType) {
        return textResult(`不支持的图片格式：${path}（支持 png/jpg/jpeg/webp/gif）`, true);
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error) {
        return textResult(`读取文件失败：${error instanceof Error ? error.message : String(error)}`, true);
      }
      const config = await resolveConfig();
      try {
        const description = await describeImage(bytes.toString("base64"), mimeType, config, question);
        // 解析结果落盘缓存，方便后续用 vision_ask 追问同一张图（sourceTool 标记来源，便于排查）。
        await putCacheEntry(bytes, mimeType, "mcp:vision_describe_image", description, config.cache.ttlDays);
        return textResult(description);
      } catch (error) {
        return textResult(`视觉模型调用失败：${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  server.registerTool(
    "vision_describe_data_url",
    {
      title: "解析 data URL 形式的图片",
      description: "直接解析一个 data URL（data:image/xxx;base64,...）形式的图片内容，不依赖历史缓存命中。",
      inputSchema: {
        dataUrl: z.string().describe("完整的 data URL 字符串，形如 data:image/png;base64,xxxx"),
        question: z.string().optional().describe("可选：具体想问的问题，省略则给出通用描述"),
      },
    },
    async ({ dataUrl, question }) => {
      const match = dataUrl.match(DATA_URI_RE);
      if (!match?.[1] || !match[2]) {
        return textResult(`不是合法的图片 data URL：${dataUrl.slice(0, 64)}...`, true);
      }
      const [, mimeType, base64] = match;
      const config = await resolveConfig();
      try {
        const description = await describeImage(base64, mimeType, config, question);
        await putCacheEntry(Buffer.from(base64, "base64"), mimeType, "mcp:vision_describe_data_url", description, config.cache.ttlDays);
        return textResult(description);
      } catch (error) {
        return textResult(`视觉模型调用失败：${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  return server;
};

/**
 * 以 stdio 模式启动 MCP server（由 Claude Code 作为子进程调起，`cvh mcp serve` 的入口）。
 * 这是一个长驻进程，函数本身不会 resolve（除非 transport 关闭）。
 *
 * @returns 在 transport 关闭前不会 resolve 的 Promise
 */
export const serveMcpStdio = async (): Promise<void> => {
  const server = createVisionMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};
