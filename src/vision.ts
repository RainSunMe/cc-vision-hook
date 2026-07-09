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

import { generateText, APICallError } from "ai";
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
 * 各 provider 期望 `baseUrl` 已经带上的路径段前缀（AI SDK 不会帮你补全，传什么用什么）。
 * 导出供 `commands/configCmd.ts`（设置时提前警告）和本文件（调用失败后补充排查提示）
 * 共用同一份定义，避免两处维护导致漂移。
 *
 * 实测踩坑：`@ai-sdk/anthropic` 只有在 `baseURL` 恰好等于官方地址时才会自动补 "/v1"，
 * 自定义网关（如公司内部自建的兼容网关）传裸域名会直接拼成 "<baseUrl>/messages" 发出
 * 404，且错误信息只有一句 "Not Found"，完全看不出是 baseUrl 缺路径段——第一次真机验证
 * 时就在这里卡了一次，加这段针对性提示，避免同样的坑被别的用户/未来的自己重新踩一遍。
 */
export const EXPECTED_BASE_URL_SEGMENT: Record<CvhConfig["provider"], string> = {
  oai: "/v1",
  responses: "/v1",
  anthropic: "/v1",
  gemini: "/v1beta",
};

/**
 * 当上游调用返回 404 且 `baseUrl` 明显缺少 provider 期望的路径段（如 `/v1`）时，
 * 在错误信息里补一句排查提示，帮用户快速定位是配置问题而不是上游故障。
 *
 * @param error - `generateText()` 抛出的原始错误
 * @param config - 当前生效的 cvh 配置
 * @returns 补充了排查提示的 Error（未命中该场景时原样返回原始错误）
 */
const enhanceApiError = (error: unknown, config: CvhConfig): unknown => {
  if (!(error instanceof APICallError) || error.statusCode !== 404) return error;
  const expectedSegment = EXPECTED_BASE_URL_SEGMENT[config.provider];
  if (!config.baseUrl || config.baseUrl.includes(expectedSegment)) return error;
  return new Error(
    `${error.message}（HTTP 404，请求地址：${error.url ?? "未知"}）\n` +
      `⚠️  可能原因：baseUrl 缺少路径段 "${expectedSegment}"——AI SDK 不会自动补全自定义网关的 ` +
      `baseUrl，需要手动带上完整路径前缀，例如 "${config.baseUrl}${expectedSegment}"。` +
      `官方地址（如 https://api.openai.com）是例外，SDK 内部会特殊处理。`,
  );
};

/**
 * 调用视觉模型解析一张图片，返回文字描述（或针对具体问题的回答）。
 *
 * @param base64 - 图片的 base64 编码数据（不含 data URI 前缀）
 * @param mimeType - 图片 MIME 类型，如 "image/png"
 * @param config - 当前生效的 cvh 配置
 * @param question - 可选的具体提问（用于 vision_ask 追问场景），省略时使用通用描述提示词
 * @returns 视觉模型的文字回答
 * @throws 当上游调用失败或超时时抛出错误（404 + baseUrl 缺路径段场景会补充排查提示），
 *   调用方需要自行捕获并降级处理
 */
export const describeImage = async (
  base64: string,
  mimeType: string,
  config: CvhConfig,
  question?: string,
): Promise<string> => {
  const model = resolveModel(config);
  const dataUrl = `data:${mimeType};base64,${base64}`;
  try {
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
  } catch (error) {
    throw enhanceApiError(error, config);
  }
};
