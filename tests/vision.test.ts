/**
 * vision.ts 单测：
 * ① resolveModel provider 映射是否正确（不发真实网络请求，只读 AI SDK 模型实例的
 *    只读元信息 `.provider`/`.modelId` 断言）；
 * ② 修复记录：曾经 "oai" 分支直接用 `openai(modelId)` 默认调用，在当前 AI SDK 版本下
 *    实际解析成 Responses API（provider 字符串是 "openai.responses"），导致 "oai"/"responses"
 *    两个配置项形同虚设。已改为显式 `openai.chat(modelId)`，本测试专门回归这个问题；
 * ③ describeImage 的消息组装是否正确（mock `ai` 的 generateText，不发真实请求）。
 */

import { describe, expect, test, mock } from "bun:test";
import type { CvhConfig } from "../src/config";

const baseConfig: CvhConfig = {
  enabled: true,
  provider: "oai",
  model: "gpt-4o-mini",
  apiKey: "sk-test-key",
  timeoutMs: 45000,
  maxTokens: 1200,
  cache: { ttlDays: 7 },
  mcpInstalled: false,
};

describe("resolveModel — provider 映射（不发真实网络请求）", () => {
  test("oai -> 必须是 Chat Completions（openai.chat），不能是 Responses API", async () => {
    const { resolveModel } = await import("../src/vision");
    const model = resolveModel({ ...baseConfig, provider: "oai" });
    // 回归断言：曾经这里错误地解析成了 "openai.responses"，见模块顶部注释的踩坑记录。
    expect(model.provider).toBe("openai.chat");
    expect(model.modelId).toBe("gpt-4o-mini");
  });

  test("responses -> openai.responses", async () => {
    const { resolveModel } = await import("../src/vision");
    const model = resolveModel({ ...baseConfig, provider: "responses" });
    expect(model.provider).toBe("openai.responses");
  });

  test("oai 与 responses 必须解析成不同的 provider 字符串（防止两个配置项退化成同一个实现）", async () => {
    const { resolveModel } = await import("../src/vision");
    const oaiModel = resolveModel({ ...baseConfig, provider: "oai" });
    const responsesModel = resolveModel({ ...baseConfig, provider: "responses" });
    expect(oaiModel.provider).not.toBe(responsesModel.provider);
  });

  test("anthropic -> anthropic.messages", async () => {
    const { resolveModel } = await import("../src/vision");
    const model = resolveModel({ ...baseConfig, provider: "anthropic", model: "claude-3-5-sonnet" });
    expect(model.provider).toBe("anthropic.messages");
    expect(model.modelId).toBe("claude-3-5-sonnet");
  });

  test("gemini -> google.generative-ai", async () => {
    const { resolveModel } = await import("../src/vision");
    const model = resolveModel({ ...baseConfig, provider: "gemini", model: "gemini-2.5-flash" });
    expect(model.provider).toBe("google.generative-ai");
    expect(model.modelId).toBe("gemini-2.5-flash");
  });

  test("未知 provider 抛出错误", async () => {
    const { resolveModel } = await import("../src/vision");
    expect(() => resolveModel({ ...baseConfig, provider: "unknown-provider" as CvhConfig["provider"] })).toThrow(
      /未知的 provider/,
    );
  });
});

describe("describeImage — 消息组装（mock generateText，不发真实请求）", () => {
  test("正确拼装 image + text content parts，未指定 question 时使用默认提示词", async () => {
    let capturedArgs: unknown;
    mock.module("ai", () => ({
      generateText: async (args: unknown) => {
        capturedArgs = args;
        return { text: "这是一张红色的图片" };
      },
    }));

    const { describeImage } = await import("../src/vision");
    const result = await describeImage("aGVsbG8=", "image/png", baseConfig);

    expect(result).toBe("这是一张红色的图片");
    const args = capturedArgs as {
      messages: Array<{ role: string; content: Array<{ type: string; image?: string; text?: string }> }>;
      maxOutputTokens: number;
    };
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0]?.role).toBe("user");
    const [imagePart, textPart] = args.messages[0]?.content ?? [];
    expect(imagePart?.type).toBe("image");
    expect(imagePart?.image).toBe("data:image/png;base64,aGVsbG8=");
    expect(textPart?.type).toBe("text");
    expect(textPart?.text).toContain("请简要描述这张图片的内容");
    expect(args.maxOutputTokens).toBe(1200);

    mock.restore();
  });

  test("指定 question 时使用追问文本而不是默认提示词（vision_ask 场景）", async () => {
    let capturedArgs: unknown;
    mock.module("ai", () => ({
      generateText: async (args: unknown) => {
        capturedArgs = args;
        return { text: "图片右上角有一个红色圆点" };
      },
    }));

    const { describeImage } = await import("../src/vision");
    const result = await describeImage("aGVsbG8=", "image/jpeg", baseConfig, "图片右上角有什么？");

    expect(result).toBe("图片右上角有一个红色圆点");
    const args = capturedArgs as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    const textPart = args.messages[0]?.content[1];
    expect(textPart?.text).toBe("图片右上角有什么？");

    mock.restore();
  });

  test("上游调用失败时错误会向上抛出，不吞掉", async () => {
    mock.module("ai", () => ({
      generateText: async () => {
        throw new Error("上游超时");
      },
    }));

    const { describeImage } = await import("../src/vision");
    await expect(describeImage("aGVsbG8=", "image/png", baseConfig)).rejects.toThrow("上游超时");

    mock.restore();
  });
});
