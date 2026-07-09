/**
 * Hook 处理逻辑的集成测试（handleUserPromptSubmit / handlePostToolUse）。
 *
 * 覆盖点：
 * - enabled=false 时两者都必须立即返回 {}（不触碰磁盘/网络）；
 * - enabled=true 时，粘贴图片场景（UserPromptSubmit）能扫到 image-cache 目录并输出
 *   <image_vision> 块；同一 session 内重复提交不会重复展示同一张图（seenTracker）；
 * - enabled=true 时，工具产图场景（PostToolUse）用 Read/MCP 两种真实 fixture 都能正确
 *   提取并输出 <tool_image_vision> 块；纯文本工具响应不触发任何视觉解析调用；
 * - 视觉模型调用失败时单张图片报错不会阻断整体流程（对应 hook 源码里的 try/catch）。
 *
 * 全程 mock "ai" 的 generateText，不发真实网络请求；用 CVH_CLAUDE_HOME 隔离真实 ~/.claude。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** 把 base64 图片写入指定 session 的 image-cache 目录，模拟 Claude Code 粘贴图片时的落盘行为。 */
const writePastedImage = async (sessionId: string, filename: string, base64: string): Promise<void> => {
  const dir = join(tmpHome, "image-cache", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), Buffer.from(base64, "base64"));
};

/** 写入启用状态的 cvh 配置文件到隔离的 CVH_CLAUDE_HOME 下。 */
const writeEnabledConfig = async (): Promise<void> => {
  const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
  await saveConfig({ ...DEFAULT_CONFIG, enabled: true, apiKey: "sk-test-key" });
};

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "cvh-hooks-test-"));
  process.env.CVH_CLAUDE_HOME = tmpHome;
  // 注意：mock.module 是整体替换模块 exports，必须把 truthy 真实导出（如 APICallError）
  // 一并补齐，否则 vision.ts 里 `import { APICallError } from "ai"` 会因为解构到 undefined 而
  // 整个模块加载报 SyntaxError（注意没有任何测试文件会报错一样，整个 bun test 进程共享
  // 同一个模块注册表，单文件跑不会复现，全量跑或多文件一起跑才会因加载顺序踩错）。
  const { APICallError } = await import("ai");
  mock.module("ai", () => ({
    APICallError,
    generateText: async () => ({ text: "这是一张纯色测试图片" }),
  }));
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpHome, { recursive: true, force: true });
  mock.restore();
});

describe("handleUserPromptSubmit", () => {
  test("enabled=false 时立即返回空对象，不扫描目录", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: false });
    await writePastedImage("session-a", "img1.png", PNG_1X1_BASE64);

    const { handleUserPromptSubmit } = await import("../src/hooks/userPromptSubmit");
    const result = await handleUserPromptSubmit({
      session_id: "session-a",
      hook_event_name: "UserPromptSubmit",
      prompt: "看看这张图",
    });
    expect(result).toEqual({});
  });

  test("enabled=true + 有新粘贴图片：输出 additionalContext，包含 image_vision 块", async () => {
    await writeEnabledConfig();
    await writePastedImage("session-b", "img1.png", PNG_1X1_BASE64);

    const { handleUserPromptSubmit } = await import("../src/hooks/userPromptSubmit");
    const result = await handleUserPromptSubmit({
      session_id: "session-b",
      hook_event_name: "UserPromptSubmit",
      prompt: "看看这张图",
    });

    expect(result.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(result.hookSpecificOutput?.additionalContext).toContain("<image_vision");
    expect(result.hookSpecificOutput?.additionalContext).toContain("这是一张纯色测试图片");
  });

  test("没有粘贴图片时返回空对象", async () => {
    await writeEnabledConfig();
    const { handleUserPromptSubmit } = await import("../src/hooks/userPromptSubmit");
    const result = await handleUserPromptSubmit({
      session_id: "session-empty",
      hook_event_name: "UserPromptSubmit",
      prompt: "没有图片的问题",
    });
    expect(result).toEqual({});
  });

  test("同一 session 内重复提交同一张已展示过的图片不会重复出现在 additionalContext", async () => {
    await writeEnabledConfig();
    await writePastedImage("session-c", "img1.png", PNG_1X1_BASE64);

    const { handleUserPromptSubmit } = await import("../src/hooks/userPromptSubmit");
    const input = { session_id: "session-c", hook_event_name: "UserPromptSubmit" as const, prompt: "第一次" };

    const first = await handleUserPromptSubmit(input);
    expect(first.hookSpecificOutput?.additionalContext).toContain("<image_vision");

    // 第二次提交（同一 session，图片文件还在目录里，模拟用户接着往下聊）应该不再重复展示。
    const second = await handleUserPromptSubmit({ ...input, prompt: "第二次" });
    expect(second).toEqual({});
  });

  test("不同 session 各自独立跟踪已展示图片（同一张图在不同 session 都会展示一次）", async () => {
    await writeEnabledConfig();
    await writePastedImage("session-d1", "img1.png", PNG_1X1_BASE64);
    await writePastedImage("session-d2", "img1.png", PNG_1X1_BASE64);

    const { handleUserPromptSubmit } = await import("../src/hooks/userPromptSubmit");
    const r1 = await handleUserPromptSubmit({ session_id: "session-d1", hook_event_name: "UserPromptSubmit", prompt: "q1" });
    const r2 = await handleUserPromptSubmit({ session_id: "session-d2", hook_event_name: "UserPromptSubmit", prompt: "q2" });
    expect(r1.hookSpecificOutput?.additionalContext).toContain("<image_vision");
    expect(r2.hookSpecificOutput?.additionalContext).toContain("<image_vision");
  });

  test("视觉模型调用失败时输出错误块，不抛出异常", async () => {
    const { APICallError } = await import("ai");
    mock.module("ai", () => ({
      APICallError,
      generateText: async () => {
        throw new Error("网络超时");
      },
    }));
    await writeEnabledConfig();
    await writePastedImage("session-e", "img1.png", PNG_1X1_BASE64);

    const { handleUserPromptSubmit } = await import("../src/hooks/userPromptSubmit");
    const result = await handleUserPromptSubmit({
      session_id: "session-e",
      hook_event_name: "UserPromptSubmit",
      prompt: "看看这张图",
    });
    expect(result.hookSpecificOutput?.additionalContext).toContain('error="true"');
    expect(result.hookSpecificOutput?.additionalContext).toContain("网络超时");
  });
});

describe("handlePostToolUse", () => {
  test("enabled=false 时立即返回空对象", async () => {
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: false });

    const { handlePostToolUse } = await import("../src/hooks/postToolUse");
    const result = await handlePostToolUse({
      session_id: "session-x",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.png" },
      tool_response: { type: "image", file: { base64: PNG_1X1_BASE64, type: "image/png" } },
    });
    expect(result).toEqual({});
  });

  test("Read 工具真实 fixture：正确提取并输出 tool_image_vision 块", async () => {
    await writeEnabledConfig();
    const fixture = JSON.parse(
      await readFile(join(import.meta.dir, "fixtures", "read-tool-response.json"), "utf8"),
    );

    const { handlePostToolUse } = await import("../src/hooks/postToolUse");
    const result = await handlePostToolUse({
      session_id: "session-read",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.png" },
      tool_response: fixture,
    });

    expect(result.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(result.hookSpecificOutput?.additionalContext).toContain('<tool_image_vision');
    expect(result.hookSpecificOutput?.additionalContext).toContain('tool="Read"');
  });

  test("Read 工具读文本文件的 fixture：不含图片，返回空对象", async () => {
    await writeEnabledConfig();
    const fixture = JSON.parse(
      await readFile(join(import.meta.dir, "fixtures", "read-tool-response-text.json"), "utf8"),
    );

    const { handlePostToolUse } = await import("../src/hooks/postToolUse");
    const result = await handlePostToolUse({
      session_id: "session-read-text",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/notes.txt" },
      tool_response: fixture,
    });
    expect(result).toEqual({});
  });

  test("MCP 工具真实 fixture（content block 数组）：正确提取并输出 tool_image_vision 块", async () => {
    await writeEnabledConfig();
    const fixture = JSON.parse(
      await readFile(join(import.meta.dir, "fixtures", "mcp-tool-response.json"), "utf8"),
    );

    const { handlePostToolUse } = await import("../src/hooks/postToolUse");
    const result = await handlePostToolUse({
      session_id: "session-mcp",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__mockfigma__get_node_screenshot",
      tool_input: { node_id: "abc123" },
      tool_response: fixture,
    });

    expect(result.hookSpecificOutput?.additionalContext).toContain("<tool_image_vision");
    expect(result.hookSpecificOutput?.additionalContext).toContain('tool="mcp__mockfigma__get_node_screenshot"');
  });

  test("MCP 工具返回纯文本 fixture：不误触发（同一 server 内混合工具不会被误伤）", async () => {
    await writeEnabledConfig();
    const fixture = JSON.parse(
      await readFile(join(import.meta.dir, "fixtures", "mcp-tool-response-text.json"), "utf8"),
    );

    const { handlePostToolUse } = await import("../src/hooks/postToolUse");
    const result = await handlePostToolUse({
      session_id: "session-mcp-text",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__mockfigma__get_node_info",
      tool_input: { node_id: "abc123" },
      tool_response: fixture,
    });
    expect(result).toEqual({});
  });

  test("Bash 工具真实 fixture（isImage 旁路标志 + data URI）：正确提取", async () => {
    await writeEnabledConfig();
    const fixture = JSON.parse(
      await readFile(join(import.meta.dir, "fixtures", "bash-tool-response.json"), "utf8"),
    );

    const { handlePostToolUse } = await import("../src/hooks/postToolUse");
    const result = await handlePostToolUse({
      session_id: "session-bash",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat screenshot_as_datauri.txt" },
      tool_response: fixture,
    });

    expect(result.hookSpecificOutput?.additionalContext).toContain("<tool_image_vision");
    expect(result.hookSpecificOutput?.additionalContext).toContain('tool="Bash"');
  });

  test("命中磁盘缓存时不再重复调用视觉模型（同一张图第二次调用应复用缓存描述）", async () => {
    let callCount = 0;
    const { APICallError } = await import("ai");
    mock.module("ai", () => ({
      APICallError,
      generateText: async () => {
        callCount += 1;
        return { text: `第 ${callCount} 次解析` };
      },
    }));
    await writeEnabledConfig();
    const fixture = JSON.parse(
      await readFile(join(import.meta.dir, "fixtures", "read-tool-response.json"), "utf8"),
    );

    const { handlePostToolUse } = await import("../src/hooks/postToolUse");
    const input = {
      session_id: "session-cache-hit",
      hook_event_name: "PostToolUse" as const,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.png" },
      tool_response: fixture,
    };

    const first = await handlePostToolUse(input);
    const second = await handlePostToolUse(input);

    expect(first.hookSpecificOutput?.additionalContext).toContain("第 1 次解析");
    // 第二次应该命中缓存，不会触发第二次真实视觉解析调用，描述文本应该还是第一次的结果。
    expect(second.hookSpecificOutput?.additionalContext).toContain("第 1 次解析");
    expect(callCount).toBe(1);
  });
});
