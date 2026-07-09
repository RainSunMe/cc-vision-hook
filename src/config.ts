/**
 * `cvh` 配置读写：拍平一层 JSON，存于 `~/.claude/cc-vision-hook.json`。
 * 优先级：CLI flags > 环境变量 > config json > 默认值（CLI/env 合并逻辑在调用处完成，本文件只负责 json 层）。
 */

import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** 支持的视觉解析上游 provider（内部映射到对应的 AI SDK 包，见 vision.ts）。 */
export type CvhProvider = "oai" | "responses" | "anthropic" | "gemini";

export interface CvhConfig {
  /** 唯一运行开关：true 处理图片，false 立即空返回。默认 false（安装后需要显式 enable）。 */
  enabled: boolean;
  /** 视觉模型上游 provider。 */
  provider: CvhProvider;
  /** 视觉模型名（provider 内部的模型 id）。 */
  model: string;
  /** 上游 API base URL，留空则使用 provider 默认官方地址。 */
  baseUrl?: string;
  /**
   * API Key，明文存储（用户决策：明文可接受，类比 Claude Code 第三方接入本身也是明文存 code/token）。
   * install 时会把配置文件权限设为 0600，降低同机其他用户读取的风险。
   */
  apiKey?: string;
  /** 单次视觉解析请求超时（毫秒）。 */
  timeoutMs: number;
  /** 视觉模型单次回复最大 token 数。 */
  maxTokens: number;
  /** 磁盘缓存 TTL（天）。全局共享，见 cache.ts。 */
  cache: { ttlDays: number };
}

export const DEFAULT_CONFIG: CvhConfig = {
  enabled: false,
  provider: "oai",
  model: "gpt-4o-mini",
  timeoutMs: 45000,
  maxTokens: 1200,
  cache: { ttlDays: 7 },
};

/**
 * Claude Code 配置根目录（即 `~/.claude`）。
 *
 * 支持 `CVH_CLAUDE_HOME` 环境变量覆盖，用于：
 * ① 单测/集成测试注入隔离的临时目录，避免污染真实 `~/.claude`；
 * ② 真机验证时用隔离的临时 HOME 跑一次真实 Claude Code 会话，不影响用户日常配置。
 * 所有需要拼 `~/.claude/...` 路径的模块都应该调用这个函数，不要各自直接 `homedir()`。
 *
 * @returns Claude Code 配置根目录的绝对路径
 */
export const getClaudeHomeDir = (): string => process.env.CVH_CLAUDE_HOME || join(homedir(), ".claude");

/** `cvh` 在用户主目录下的根目录：`~/.claude/cc-vision-hook/`。 */
export const getCvhHomeDir = (): string => join(getClaudeHomeDir(), "cc-vision-hook");

/** 配置文件路径：`~/.claude/cc-vision-hook.json`（与 Claude Code 自身配置同级，便于用户发现）。 */
export const getConfigPath = (): string => join(getClaudeHomeDir(), "cc-vision-hook.json");

/**
 * 读取配置文件，文件不存在时返回默认配置（不落盘，install 阶段才落盘）。
 *
 * @returns 合并后的配置对象
 */
export const loadConfig = async (): Promise<CvhConfig> => {
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CvhConfig>;
    return { ...DEFAULT_CONFIG, ...parsed, cache: { ...DEFAULT_CONFIG.cache, ...parsed.cache } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
};

/**
 * 检查配置文件是否已存在于磁盘（区别于 `loadConfig()`——后者文件不存在时会静默兜底返回
 * 默认配置对象，不能用来判断"文件是否真的存在"，`cvh install` 需要这个区分来决定是否要
 * 首次落盘写入默认配置）。
 *
 * @returns 配置文件是否存在
 */
export const configFileExists = async (): Promise<boolean> => {
  try {
    await readFile(getConfigPath(), "utf8");
    return true;
  } catch {
    return false;
  }
};

/**
 * 写入配置文件，并设置 `0600` 权限（仅当前用户可读写，因为里面可能存明文 API key）。
 *
 * @param config - 要写入的完整配置对象
 */
export const saveConfig = async (config: CvhConfig): Promise<void> => {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  // 明文 API key 落盘，权限收紧到仅当前用户可读写，降低同机多用户环境下的泄露面。
  await chmod(path, 0o600).catch(() => {});
};

/**
 * 读取环境变量覆盖项（`CVH_*`），用于命令行免配置文件临时覆盖场景。
 *
 * @returns 环境变量中显式设置的配置片段（未设置的字段不出现在返回对象中）
 */
export const loadEnvOverrides = (): Partial<CvhConfig> => {
  const overrides: Partial<CvhConfig> = {};
  if (process.env.CVH_ENABLED !== undefined) overrides.enabled = process.env.CVH_ENABLED === "1" || process.env.CVH_ENABLED === "true";
  if (process.env.CVH_PROVIDER) overrides.provider = process.env.CVH_PROVIDER as CvhProvider;
  if (process.env.CVH_MODEL) overrides.model = process.env.CVH_MODEL;
  if (process.env.CVH_BASE_URL) overrides.baseUrl = process.env.CVH_BASE_URL;
  if (process.env.CVH_API_KEY) overrides.apiKey = process.env.CVH_API_KEY;
  if (process.env.CVH_TIMEOUT_MS) overrides.timeoutMs = Number(process.env.CVH_TIMEOUT_MS);
  if (process.env.CVH_MAX_TOKENS) overrides.maxTokens = Number(process.env.CVH_MAX_TOKENS);
  return overrides;
};

/**
 * 按优先级合并配置：环境变量 > 配置文件 > 默认值。
 * （CLI flags 由调用方在拿到这个结果之后再叠加一层，优先级最高。）
 *
 * @returns 最终生效的配置对象
 */
export const resolveConfig = async (): Promise<CvhConfig> => {
  const fileConfig = await loadConfig();
  const envOverrides = loadEnvOverrides();
  // envOverrides 目前不产生 cache 字段（无对应 CVH_CACHE_* 环境变量），这里始终沿用 fileConfig.cache。
  return { ...fileConfig, ...envOverrides, cache: fileConfig.cache };
};
