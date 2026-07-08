/**
 * 对 `~/.claude/settings.json` 里 Hook 注册条目的幂等读写。
 *
 * 幂等标识：用固定的 command 字符串（"cvh hook user-prompt-submit"/"cvh hook post-tool-use"）
 * 作为唯一标识——install 前先检查是否已存在同样的条目，避免重复注册；uninstall 时精确按这个
 * 字符串过滤移除，不误删用户自己配置的其他 Hook。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getClaudeHomeDir } from "./config.js";

export const USER_PROMPT_SUBMIT_COMMAND = "cvh hook user-prompt-submit";
export const POST_TOOL_USE_COMMAND = "cvh hook post-tool-use";

interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: HookGroup[];
    PostToolUse?: HookGroup[];
    [key: string]: HookGroup[] | undefined;
  };
  [key: string]: unknown;
}

const getSettingsPath = (): string => join(getClaudeHomeDir(), "settings.json");

/**
 * 读取 `~/.claude/settings.json`，文件不存在或解析失败时返回空对象（不覆盖用户已有配置）。
 *
 * @returns 解析后的设置对象
 */
const readSettings = async (): Promise<ClaudeSettings> => {
  try {
    const raw = await readFile(getSettingsPath(), "utf8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
};

/**
 * 写回 `~/.claude/settings.json`。
 *
 * @param settings - 完整的设置对象
 */
const writeSettings = async (settings: ClaudeSettings): Promise<void> => {
  const path = getSettingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
};

/**
 * 检查某个 Hook 分组数组里是否已经存在指定 command 的条目。
 *
 * @param groups - Hook 分组数组
 * @param command - 要查找的命令字符串
 * @returns 是否已存在
 */
const hasCommand = (groups: HookGroup[] | undefined, command: string): boolean =>
  (groups ?? []).some((g) => g.hooks.some((h) => h.command === command));

/**
 * 幂等地在 `~/.claude/settings.json` 中注册 `UserPromptSubmit` 和 `PostToolUse` 两个 Hook。
 * 已存在同样 command 的条目时跳过，不重复添加；不会动用户已有的其他 Hook 配置。
 *
 * @returns 本次实际新增的 Hook 数量（0 表示已经是安装好的状态，重复执行安全）
 */
export const installHooks = async (): Promise<number> => {
  const settings = await readSettings();
  settings.hooks ??= {};
  let added = 0;

  if (!hasCommand(settings.hooks.UserPromptSubmit, USER_PROMPT_SUBMIT_COMMAND)) {
    settings.hooks.UserPromptSubmit = [
      ...(settings.hooks.UserPromptSubmit ?? []),
      { hooks: [{ type: "command", command: USER_PROMPT_SUBMIT_COMMAND, timeout: 60 }] },
    ];
    added += 1;
  }

  if (!hasCommand(settings.hooks.PostToolUse, POST_TOOL_USE_COMMAND)) {
    settings.hooks.PostToolUse = [
      ...(settings.hooks.PostToolUse ?? []),
      // matcher 显式设为 "*"：图片检测逻辑完全在 hook 内部完成（不依赖工具名白名单），
      // 挂 "*" 才能自动覆盖未来任何新工具（含 MCP/Bash 等），不需要用户手动维护 matcher 列表。
      // 不显式设置时 Claude Code 的匹配行为未经验证，不能假设留空等价于匹配全部。
      { matcher: "*", hooks: [{ type: "command", command: POST_TOOL_USE_COMMAND, timeout: 60 }] },
    ];
    added += 1;
  }

  await writeSettings(settings);
  return added;
};

/**
 * 精确移除 cvh 注册的两个 Hook 条目，不影响用户配置的其他 Hook。
 *
 * @returns 本次实际移除的 Hook 数量
 */
export const uninstallHooks = async (): Promise<number> => {
  const settings = await readSettings();
  if (!settings.hooks) return 0;
  let removed = 0;

  if (settings.hooks.UserPromptSubmit) {
    const before = settings.hooks.UserPromptSubmit.length;
    settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.command !== USER_PROMPT_SUBMIT_COMMAND) }))
      .filter((g) => g.hooks.length > 0);
    removed += before - settings.hooks.UserPromptSubmit.length;
  }

  if (settings.hooks.PostToolUse) {
    const before = settings.hooks.PostToolUse.length;
    settings.hooks.PostToolUse = settings.hooks.PostToolUse
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.command !== POST_TOOL_USE_COMMAND) }))
      .filter((g) => g.hooks.length > 0);
    removed += before - settings.hooks.PostToolUse.length;
  }

  await writeSettings(settings);
  return removed;
};

/**
 * 检查两个 Hook 是否都已注册（用于 `cvh status`/`doctor`）。
 *
 * @returns 分别表示两个 Hook 是否已注册
 */
export const checkHooksInstalled = async (): Promise<{ userPromptSubmit: boolean; postToolUse: boolean }> => {
  const settings = await readSettings();
  return {
    userPromptSubmit: hasCommand(settings.hooks?.UserPromptSubmit, USER_PROMPT_SUBMIT_COMMAND),
    postToolUse: hasCommand(settings.hooks?.PostToolUse, POST_TOOL_USE_COMMAND),
  };
};
