/**
 * `cvh config get/set` 命令实现。
 */

import { loadConfig, saveConfig, type CvhConfig, type CvhProvider } from "../config.js";
import { EXPECTED_BASE_URL_SEGMENT } from "../vision.js";

const EDITABLE_KEYS = ["provider", "model", "baseUrl", "apiKey", "timeoutMs", "maxTokens"] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

/** provider 字段允许的合法值，与 vision.ts 的 resolveModel() 分支一一对应。 */
const VALID_PROVIDERS: readonly CvhProvider[] = ["oai", "responses", "anthropic", "gemini"];

const isEditableKey = (key: string): key is EditableKey => (EDITABLE_KEYS as readonly string[]).includes(key);

/**
 * 按字段名把字符串值写入配置对象的对应字段，避免使用 `as any` 绕过类型检查——
 * 每个分支都显式声明目标字段的真实类型，并在写入前做基本校验，
 * 避免非法值一直存活到 `describeImage()` 真正调用时才报错（体验差、排查成本高）。
 *
 * @param config - 待修改的配置对象（原地修改）
 * @param key - 目标字段名
 * @param value - 字符串形式的新值
 * @returns 非阻断性的警告信息（目前仅 baseUrl 疑似缺少路径段时返回），无警告时返回 undefined
 * @throws 当值不满足对应字段的校验规则时抛出错误（provider 非法、数字字段非数字/非正数等）
 */
const applyConfigValue = (config: CvhConfig, key: EditableKey, value: string): string | undefined => {
  switch (key) {
    case "provider": {
      if (!VALID_PROVIDERS.includes(value as CvhProvider)) {
        throw new Error(`不支持的 provider：${value}。可用值：${VALID_PROVIDERS.join(", ")}`);
      }
      config.provider = value as CvhProvider;
      return undefined;
    }
    case "model": {
      if (!value.trim()) throw new Error("model 不能为空");
      config.model = value;
      return undefined;
    }
    case "baseUrl": {
      try {
        // eslint-disable-next-line no-new
        new URL(value);
      } catch {
        throw new Error(`baseUrl 不是合法的 URL：${value}`);
      }
      config.baseUrl = value;
      // 软性提示，不阻断：AI SDK 不会给自定义网关自动补路径段，裸域名会在真正调用时才报
      // 一个语义不明的 404（真机验证时踩过这个坑）。官方地址是例外（SDK 内部特殊处理过），
      // 不需要提示。
      const expectedSegment = EXPECTED_BASE_URL_SEGMENT[config.provider];
      const isOfficialEndpoint = /^https:\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)/.test(value);
      if (!isOfficialEndpoint && !value.includes(expectedSegment)) {
        return (
          `baseUrl "${value}" 看起来缺少 ${config.provider} provider 期望的路径段 "${expectedSegment}"。` +
          `AI SDK 不会自动补全自定义网关的路径，如果这不是故意的，建议改成 "${value}${expectedSegment}"。`
        );
      }
      return undefined;
    }
    case "apiKey": {
      if (!value.trim()) throw new Error("apiKey 不能为空");
      config.apiKey = value;
      return;
    }
    case "timeoutMs": {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`timeoutMs 必须是正数：${value}`);
      config.timeoutMs = n;
      return;
    }
    case "maxTokens": {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`maxTokens 必须是正数：${value}`);
      config.maxTokens = n;
      return;
    }
  }
};

/**
 * 打印当前完整配置（脱敏 apiKey）。
 *
 * @param jsonOutput - 是否以 JSON 格式输出
 */
export const runConfigGet = async (jsonOutput: boolean): Promise<void> => {
  const config = await loadConfig();
  const masked = { ...config, apiKey: config.apiKey ? `${config.apiKey.slice(0, 6)}***` : undefined };
  if (jsonOutput) {
    console.log(JSON.stringify(masked));
    return;
  }
  for (const [key, value] of Object.entries(masked)) {
    console.log(`${key} = ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }
};

/**
 * 设置单个配置项并落盘。
 *
 * @param key - 配置项名（仅允许 EDITABLE_KEYS 中的字段）
 * @param value - 新值（字符串形式，数字字段会自动转换）
 * @param jsonOutput - 是否以 JSON 格式输出
 * @throws 当 key 不在允许列表内时抛出错误
 */
export const runConfigSet = async (key: string, value: string, jsonOutput: boolean): Promise<void> => {
  if (!isEditableKey(key)) {
    throw new Error(`不支持的配置项：${key}。可用项：${EDITABLE_KEYS.join(", ")}`);
  }
  const config = await loadConfig();
  const warning = applyConfigValue(config, key, value);
  await saveConfig(config);

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, key, value, ...(warning ? { warning } : {}) }));
    return;
  }
  console.log(`✅ ${key} = ${key === "apiKey" ? "***" : value}`);
  if (warning) console.log(`⚠️  ${warning}`);
};
