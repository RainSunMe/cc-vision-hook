/**
 * `cvh init` 命令实现：交互式安装向导，一步到位完成
 * 「选 provider → 填 model/baseUrl/apiKey → 写配置 → 注册 Hook → 可选注册 MCP → 可选立即 enable」。
 *
 * 设计取舍：
 * - 只在 TTY 环境下可用（`process.stdin.isTTY`），非交互环境（CI/脚本管道）直接报错并提示
 *   改用 `cvh install` + `cvh config set` 组合命令，避免卡在 readline 等待输入。
 * - 不提供 `--json` 模式——`init` 的本质是"人工问答"，脚本化场景应该走 `install`/`config set`，
 *   这与其他命令的 `--json` 支持约定不冲突（`init` 本来就不是给脚本用的）。
 */

import { createInterface } from "node:readline/promises";
import { DEFAULT_CONFIG, configFileExists, getConfigPath, loadConfig, saveConfig, type CvhConfig, type CvhProvider } from "../config.js";
import { installHooks } from "../claudeSettings.js";
import { installMcpServer } from "../claudeMcp.js";

const VALID_PROVIDERS: readonly CvhProvider[] = ["oai", "responses", "anthropic", "gemini"];

/** provider -> 默认模型名的建议值，减少用户输入负担（可直接回车采用默认值）。 */
const DEFAULT_MODEL_BY_PROVIDER: Record<CvhProvider, string> = {
  oai: "gpt-4o-mini",
  responses: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  gemini: "gemini-2.5-flash",
};

/**
 * 向用户提问一行文字，返回去除首尾空白的回答；回答为空时使用 `defaultValue`。
 *
 * @param rl - readline 接口实例
 * @param question - 提示文字（不含默认值展示，由调用方自行拼接）
 * @param defaultValue - 用户直接回车时采用的默认值
 * @returns 用户输入或默认值
 */
const ask = async (rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> => {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue || "";
};

/**
 * 向用户提问一个 y/n 问题。
 *
 * @param rl - readline 接口实例
 * @param question - 提示文字
 * @param defaultYes - 用户直接回车时是否视为"是"
 * @returns 用户的选择
 */
const askYesNo = async (rl: ReturnType<typeof createInterface>, question: string, defaultYes: boolean): Promise<boolean> => {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
};

/**
 * 运行交互式安装向导。
 *
 * @throws 当 stdin 不是 TTY（非交互环境）时抛出错误，提示改用 `install`/`config set`
 */
export const runInit = async (): Promise<void> => {
  if (!process.stdin.isTTY) {
    throw new Error(
      "cvh init 需要交互式终端（TTY），当前环境不支持。非交互场景请改用：\n" +
        "  cvh install && cvh config set provider <provider> && cvh config set model <model> && cvh config set apiKey <key> && cvh enable",
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("cc-vision-hook 交互式安装向导\n");

    const existed = await configFileExists();
    const current: CvhConfig = existed ? await loadConfig() : { ...DEFAULT_CONFIG };
    if (existed) {
      console.log(`检测到已有配置（${getConfigPath()}），当前值将作为默认值，直接回车可保留。\n`);
    }

    let provider: CvhProvider = current.provider;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const input = await ask(rl, `视觉模型上游 provider（可选：${VALID_PROVIDERS.join("/")}）`, current.provider);
      if (VALID_PROVIDERS.includes(input as CvhProvider)) {
        provider = input as CvhProvider;
        break;
      }
      console.log(`⚠️  不支持的 provider：${input}，请重新输入`);
    }

    const model = await ask(rl, "视觉模型名", current.model !== DEFAULT_CONFIG.model ? current.model : DEFAULT_MODEL_BY_PROVIDER[provider]);
    const baseUrlInput = await ask(rl, "上游 API base URL（留空使用 provider 官方默认地址）", current.baseUrl ?? "");
    // apiKey 单独处理：不能像其他字段那样把"脱敏展示值"直接当默认值塞回 ask()——
    // 那样用户直接回车时，写入配置的就会是 "sk-xxx***" 这段脱敏字符串本身，而不是真实 key。
    // 直接问一个新值，用户想保留原 key 时留空即可。
    const apiKeyPrompt = current.apiKey ? `API Key（当前已设置 ${current.apiKey.slice(0, 6)}***，回车保留）` : "API Key";
    const apiKeyInput = (await rl.question(`${apiKeyPrompt}: `)).trim();
    const resolvedApiKey = apiKeyInput || current.apiKey;

    const installMcp = await askYesNo(rl, "是否同时注册 MCP server（vision_ask 等追问工具，与主开关无关）", false);
    const enableNow = await askYesNo(rl, "是否立即启用（enabled=true）", true);

    const finalConfig: CvhConfig = {
      ...current,
      provider,
      model,
      baseUrl: baseUrlInput || undefined,
      apiKey: resolvedApiKey || undefined,
      enabled: enableNow,
    };

    await saveConfig(finalConfig);
    const hooksAdded = await installHooks();
    const mcpChanged = installMcp ? await installMcpServer() : false;

    console.log("\n✅ cvh 初始化完成");
    console.log(`   配置文件：${getConfigPath()}`);
    console.log(`   Provider / 模型：${provider} / ${model}`);
    console.log(`   新增 Hook 注册数：${hooksAdded}`);
    console.log(`   MCP server：${installMcp ? (mcpChanged ? "已注册" : "已经是最新状态") : "未注册（可后续运行 cvh mcp install）"}`);
    console.log(`   开关状态：${enableNow ? "已启用" : "已停用（运行 cvh enable 手动启用）"}`);
    console.log("\n建议运行 `cvh doctor` 验证配置和连通性。");
  } finally {
    rl.close();
  }
};
