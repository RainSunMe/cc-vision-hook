/**
 * mcpServer.ts 集成测试：用官方 MCP SDK 的 `InMemoryTransport` 连接一个真实
 * `Client`/`Server` 对，端到端验证三个工具的注册、schema、成功/失败路径——
 * 不是只调用内部函数，是真的走一遍 MCP JSON-RPC 协议（tools/list、tools/call）。
 *
 * 全程 mock "ai" 的 generateText，不发真实网络请求；用 CVH_CLAUDE_HOME 隔离真实 ~/.claude。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

let tmpRoot: string;
let tmpHome: string;

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** 起一对通过 InMemoryTransport 互联的 Client/Server，返回 client 供测试调用工具。 */
const connectClient = async (): Promise<Client> => {
  const { createVisionMcpServer } = await import("../src/mcpServer");
  const server = createVisionMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

/** 从 CallToolResult 里取出第一个文本 block 的内容，方便断言。 */
const textOf = (result: CallToolResult): string => {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
};

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "cvh-mcpserver-test-"));
  // 同 commands.test.ts：必须以 ".claude" 结尾，否则 claudeMcp.ts 的 dirname() 推导会
  // 指向系统共享 tmpdir() 根目录，导致跨测试文件的 "~/.claude.json" 路径互相污染。
  // 清理时删 tmpRoot（".claude.json" 写在这一级），不能只删 tmpHome。
  tmpHome = join(tmpRoot, ".claude");
  process.env.CVH_CLAUDE_HOME = tmpHome;
  const { APICallError } = await import("ai");
  mock.module("ai", () => ({
    APICallError,
    generateText: async () => ({ text: "这是一张紫色的正方形图片" }),
  }));
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpRoot, { recursive: true, force: true });
  mock.restore();
});

describe("createVisionMcpServer — tools/list", () => {
  test("暴露三个工具，且都带有 inputSchema", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });

    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["vision_ask", "vision_describe_data_url", "vision_describe_image"]);
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
    }
    await client.close();
  });
});

describe("vision_ask", () => {
  test("image_id 不存在时返回明确错误（isError=true），不是静默失败", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });

    const client = await connectClient();
    const result = await client.callTool({ name: "vision_ask", arguments: { imageId: "img_doesnotexist0000", question: "颜色？" } });
    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toContain("未找到");
    await client.close();
  });

  test("命中缓存条目时能取回原图并调用视觉模型追问，返回追问的回答", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });
    const { putCacheEntry } = await import("../src/cache");
    const bytes = Buffer.from(PNG_1X1_BASE64, "base64");
    const entry = await putCacheEntry(bytes, "image/png", "Read", "通用描述：一张测试图片", 7);

    let capturedQuestion: string | undefined;
    const { APICallError } = await import("ai");
    mock.module("ai", () => ({
      APICallError,
      generateText: async (args: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => {
        capturedQuestion = args.messages[0]?.content[1]?.text;
        return { text: "图片右上角是紫色的" };
      },
    }));

    const client = await connectClient();
    const result = await client.callTool({ name: "vision_ask", arguments: { imageId: entry.imageId, question: "图片右上角是什么颜色？" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as CallToolResult)).toBe("图片右上角是紫色的");
    // 追问场景必须把用户的具体问题传给视觉模型，而不是复用缓存里已经存好的通用描述。
    expect(capturedQuestion).toBe("图片右上角是什么颜色？");
    await client.close();
  });

  test("视觉模型调用失败时返回错误结果，不抛异常导致连接崩溃", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });
    const { putCacheEntry } = await import("../src/cache");
    const entry = await putCacheEntry(Buffer.from(PNG_1X1_BASE64, "base64"), "image/png", "Read", "desc", 7);

    const { APICallError } = await import("ai");
    mock.module("ai", () => ({
      APICallError,
      generateText: async () => {
        throw new Error("网络超时");
      },
    }));

    const client = await connectClient();
    const result = await client.callTool({ name: "vision_ask", arguments: { imageId: entry.imageId, question: "?" } });
    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toContain("网络超时");
    await client.close();
  });
});

describe("vision_describe_image", () => {
  test("本地文件不存在时返回错误", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });

    const client = await connectClient();
    const result = await client.callTool({ name: "vision_describe_image", arguments: { path: "/tmp/definitely-not-here-cvh.png" } });
    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toContain("读取文件失败");
    await client.close();
  });

  test("不支持的图片格式（非白名单扩展名）直接报错，不发起视觉调用", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });

    const client = await connectClient();
    const result = await client.callTool({ name: "vision_describe_image", arguments: { path: "/tmp/notes.txt" } });
    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toContain("不支持的图片格式");
    await client.close();
  });

  test("成功解析本地图片后，结果写入磁盘缓存（供后续 vision_ask 追问）", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });
    const { writeFile } = await import("node:fs/promises");
    const imgPath = join(tmpHome, "probe.png");
    await writeFile(imgPath, Buffer.from(PNG_1X1_BASE64, "base64"));

    const client = await connectClient();
    const result = await client.callTool({ name: "vision_describe_image", arguments: { path: imgPath } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as CallToolResult)).toBe("这是一张紫色的正方形图片");

    const { computeImageId, getCacheEntry } = await import("../src/cache");
    const bytes = Buffer.from(PNG_1X1_BASE64, "base64");
    const cached = await getCacheEntry(computeImageId(bytes));
    expect(cached?.description).toBe("这是一张紫色的正方形图片");
    expect(cached?.sourceTool).toBe("mcp:vision_describe_image");
    await client.close();
  });
});

describe("vision_describe_data_url", () => {
  test("非法 data URL 直接报错，不发起视觉调用", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });

    const client = await connectClient();
    const result = await client.callTool({ name: "vision_describe_data_url", arguments: { dataUrl: "not-a-data-url" } });
    expect(result.isError).toBe(true);
    expect(textOf(result as CallToolResult)).toContain("不是合法的图片 data URL");
    await client.close();
  });

  test("合法 data URL 成功解析并写入缓存", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test" });

    const client = await connectClient();
    const dataUrl = `data:image/png;base64,${PNG_1X1_BASE64}`;
    const result = await client.callTool({ name: "vision_describe_data_url", arguments: { dataUrl } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as CallToolResult)).toBe("这是一张紫色的正方形图片");

    const { computeImageId, getCacheEntry } = await import("../src/cache");
    const bytes = Buffer.from(PNG_1X1_BASE64, "base64");
    const cached = await getCacheEntry(computeImageId(bytes));
    expect(cached?.sourceTool).toBe("mcp:vision_describe_data_url");
    await client.close();
  });
});
