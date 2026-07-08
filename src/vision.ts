/**
 * 视觉解析层：统一通过 Vercel AI SDK 对接四个上游 provider，屏蔽各家协议格式差异。
 *
 * Provider 映射：
 *   - "oai"        -> @ai-sdk/openai 的 Chat Completions 模型（显式 openai.chat(modelId)）
 *   - "responses"  -> @ai-sdk/openai 的 Responses API 模型（openai.responses(modelId)）
 *   - "anthropic"  -> @ai-sdk/anthropic
 *   - "gemini"     -> @ai-sdk/google
 * 保留 cvh 自定义的 provider 命名（不直接暴露 AI SDK 包名），降低用户配置心智负担。
 *
 * ⚠️ 实测踩坑记录：当前 `ai`/`@ai-sdk/openai`
 * 版本下，`openai(modelId)` 这种默认调用方式解析出的 provider 字符串是 `"openai.responses"`
 * （即默认就是 Responses API，不是 Chat Completions）。如果 "oai" 分支直接写
 * `openai(config.model)`，会导致 "oai" 和 "responses" 两个配置项实际调用的是同一个 API，
 * "oai" 选项形同虚设。必须显式调用 `openai.chat(modelId)` 才能真正拿到 Chat Completions 模型。
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { CvhConfig } from "./config.js";

/** 默认的通用图片描述提示词（未指定追问问题时使用）。 */
const DEFAULT_DESCRIBE_PROMPT = "请简要描述这张图片的内容，包含关键的颜色、文字、布局等信息，控制在 200 字以内。";

/**
 * 按配置解析出对应的 AI SDK 语言模型实例。
 *
 * 导出（而非模块内部私有）是为了支持单测：AI SDK 的模型实例暴露 `.modelId`/`.provider`
 * 等只读字段，可以在不发起真实网络请求的前提下验证 provider 映射是否正确
 * （见 tests/vision.test.ts），避免每次跑测试都要真实调用视觉模型 API。
 *
 * @param config - 当前生效的 cvh 配置（含 provider/model/baseUrl/apiKey）
 * @returns AI SDK 的 LanguageModel 实例，供 generateText 使用
 * @throws 当 provider 是未知值时抛出错误
 */
export const resolveModel = (config: CvhConfig) => {
  switch (config.provider) {
    case "oai": {
      const openai = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
      // 显式用 .chat()，不要用 openai(modelId) 默认调用——见上方模块注释，默认调用在当前
      // AI SDK 版本下实际解析成 Responses API，会让 "oai"/"responses" 两个 provider 选项失去区分度。
      return openai.chat(config.model);
    }
    case "responses": {
      const openai = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
      return openai.responses(config.model);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.apiKey, baseURL: config.baseUrl });
      return anthropic(config.model);
    }
    case "gemini": {
      const google = createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
      return google(config.model);
    }
    default:
      throw new Error(`未知的 provider: ${config.provider}`);
  }
};

/**
 * 调用视觉模型解析一张图片，返回文字描述（或针对具体问题的回答）。
 *
 * @param base64 - 图片的 base64 编码数据（不含 data URI 前缀）
 * @param mimeType - 图片 MIME 类型，如 "image/png"
 * @param config - 当前生效的 cvh 配置
 * @param question - 可选的具体提问（用于 vision_ask 追问场景），省略时使用通用描述提示词
 * @returns 视觉模型的文字回答
 * @throws 当上游调用失败或超时时抛出错误，调用方需要自行捕获并降级处理
 */
export const describeImage = async (
  base64: string,
  mimeType: string,
  config: CvhConfig,
  question?: string,
): Promise<string> => {
  const model = resolveModel(config);
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const { text } = await generateText({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: dataUrl },
          { type: "text", text: question ?? DEFAULT_DESCRIBE_PROMPT },
        ],
      },
    ],
    maxOutputTokens: config.maxTokens,
    abortSignal: AbortSignal.timeout(config.timeoutMs),
  });
  return text;
};
