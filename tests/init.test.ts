/**
 * init.ts 单测：
 * ① 非 TTY 环境下必须直接抛错，不能卡在 readline 等待输入；
 * ② TTY 环境下完整走一遍问答流程（mock `node:readline/promises` 的 `createInterface`），
 *    验证最终落盘的配置、Hook/MCP 注册是否符合用户选择；
 * ③ 已有配置时，直接回车（空字符串）应该保留原值，而不是被清空/覆盖成默认值。
 *
 * 用 `CVH_CLAUDE_HOME` 隔离真实 ~/.claude（同时满足 claudeMcp.ts 对 ".claude" 结尾路径的要求）。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let tmpHome: string;
let originalIsTTY: boolean | undefined;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "cvh-init-test-"));
  tmpHome = join(tmpRoot, ".claude");
  process.env.CVH_CLAUDE_HOME = tmpHome;
  originalIsTTY = process.stdin.isTTY;
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpRoot, { recursive: true, force: true });
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  mock.restore();
});

/** 构造一个假的 readline Interface，按顺序消费预设的回答队列。 */
const mockReadlineAnswers = (answers: string[]): void => {
  let index = 0;
  mock.module("node:readline/promises", () => ({
    createInterface: () => ({
      question: async () => answers[index++] ?? "",
      close: () => {},
    }),
  }));
};

describe("runInit — 非 TTY 环境", () => {
  test("非交互环境直接抛错，提示改用 install/config set 组合命令", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const { runInit } = await import("../src/commands/init");
    await expect(runInit()).rejects.toThrow(/交互式终端/);
  });
});

describe("runInit — TTY 环境完整问答流程", () => {
  test("首次安装：按问答顺序落盘配置、注册 Hook，不装 MCP，立即启用", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    // 问答顺序：provider -> model -> baseUrl -> apiKey -> installMcp(y/n) -> enableNow(y/n)
    mockReadlineAnswers(["anthropic", "claude-3-5-sonnet-latest", "", "sk-test-123456", "n", "y"]);

    const { runInit } = await import("../src/commands/init");
    await runInit();

    const { loadConfig } = await import("../src/config");
    const config = await loadConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-3-5-sonnet-latest");
    expect(config.apiKey).toBe("sk-test-123456");
    expect(config.enabled).toBe(true);

    const { checkHooksInstalled } = await import("../src/claudeSettings");
    expect(await checkHooksInstalled()).toEqual({ userPromptSubmit: true, postToolUse: true });

    const { checkMcpInstalled } = await import("../src/claudeMcp");
    expect(await checkMcpInstalled()).toBe(false);
  });

  test("provider 输入非法值时重新提问，直到输入合法值为止", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    // 第一次输入非法 provider，第二次输入合法值。
    mockReadlineAnswers(["not-a-provider", "oai", "gpt-4o-mini", "", "sk-test", "n", "n"]);

    const { runInit } = await import("../src/commands/init");
    await runInit();

    const { loadConfig } = await import("../src/config");
    expect((await loadConfig()).provider).toBe("oai");
  });

  test("选择安装 MCP 时，MCP server 会被注册", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadlineAnswers(["oai", "gpt-4o-mini", "", "sk-test", "y", "n"]);

    const { runInit } = await import("../src/commands/init");
    await runInit();

    const { checkMcpInstalled } = await import("../src/claudeMcp");
    expect(await checkMcpInstalled()).toBe(true);
  });

  test("已有配置时，apiKey 留空（直接回车）保留原值，不会被清空", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const { DEFAULT_CONFIG, saveConfig } = await import("../src/config");
    await saveConfig({ ...DEFAULT_CONFIG, apiKey: "sk-original-key", provider: "oai", model: "gpt-4o-mini" });

    // provider/model/baseUrl 都直接回车（沿用默认值），apiKey 也直接回车（保留原值）。
    mockReadlineAnswers(["", "", "", "", "n", "n"]);

    const { runInit } = await import("../src/commands/init");
    await runInit();

    const { loadConfig } = await import("../src/config");
    const config = await loadConfig();
    expect(config.apiKey).toBe("sk-original-key");
    expect(config.provider).toBe("oai");
  });

  test("重复执行 init 不会重复新增 Hook 注册（幂等）", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockReadlineAnswers(["oai", "gpt-4o-mini", "", "sk-test", "n", "n"]);
    const { runInit } = await import("../src/commands/init");
    await runInit();

    mockReadlineAnswers(["oai", "gpt-4o-mini", "", "", "n", "n"]);
    await runInit();

    const { checkHooksInstalled } = await import("../src/claudeSettings");
    expect(await checkHooksInstalled()).toEqual({ userPromptSubmit: true, postToolUse: true });
  });
});
