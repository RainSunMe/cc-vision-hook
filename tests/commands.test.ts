/**
 * commands/*.ts 的行为测试：验证各 CLI 命令的落盘副作用和 --json 输出结构，
 * 不测试 console.log 的具体格式（那是展示细节），只测试真正产生的状态变化。
 *
 * 用 `CVH_CLAUDE_HOME` 隔离真实 ~/.claude；用 console.log spy 捕获 --json 输出并解析。
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let tmpHome: string;
let logs: string[];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "cvh-commands-test-"));
  // 必须以 ".claude" 结尾：claudeMcp.ts 的 getGlobalConfigPath() 用 dirname() 严格推导
  // "~/.claude.json" 的位置（不做字符串猜测/兜底），如果这里传一个不以 ".claude" 结尾的
  // 路径，dirname() 会指向系统共享的 tmpdir() 根目录，导致跨测试文件用同一个
  // ".claude.json" 路径产生污染。清理时要删 tmpRoot（".claude.json" 写在这一级），
  // 不能只删 tmpHome（".claude" 子目录）。
  tmpHome = join(tmpRoot, ".claude");
  process.env.CVH_CLAUDE_HOME = tmpHome;
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpRoot, { recursive: true, force: true });
  logSpy.mockRestore();
  mock.restore();
});

/** 解析最后一次 console.log 输出为 JSON（假定该命令以 --json 模式调用）。 */
const lastJson = <T = Record<string, unknown>>(): T => JSON.parse(logs.at(-1) ?? "{}") as T;

describe("runInstall / runUninstall", () => {
  test("install 创建配置文件（默认 enabled=false）并注册 Hook", async () => {
    const { runInstall } = await import("../src/commands/install");
    await runInstall(true);
    const result = lastJson<{ ok: boolean; hooksAdded: number }>();
    expect(result.ok).toBe(true);
    expect(result.hooksAdded).toBe(2);

    const { loadConfig } = await import("../src/config");
    expect((await loadConfig()).enabled).toBe(false);
  });

  test("重复 install 是幂等的：第二次 hooksAdded=0", async () => {
    const { runInstall } = await import("../src/commands/install");
    await runInstall(true);
    await runInstall(true);
    expect(lastJson<{ hooksAdded: number }>().hooksAdded).toBe(0);
  });

  test("uninstall 移除 Hook 和 MCP 注册，默认不删配置和缓存", async () => {
    const { runInstall, runUninstall } = await import("../src/commands/install");
    const { installMcpServer } = await import("../src/claudeMcp");
    await runInstall(true);
    await installMcpServer();

    await runUninstall(false, true);
    const result = lastJson<{ hooksRemoved: number; mcpRemoved: boolean; purged: boolean }>();
    expect(result.hooksRemoved).toBe(2);
    expect(result.mcpRemoved).toBe(true);
    expect(result.purged).toBe(false);

    // 配置文件应该还在（未 purge）。
    const { getConfigPath } = await import("../src/config");
    await expect(readFile(getConfigPath(), "utf8")).resolves.toBeTruthy();
  });

  test("uninstall --purge 额外删除配置文件和缓存目录", async () => {
    const { runInstall, runUninstall } = await import("../src/commands/install");
    await runInstall(true);
    const { getConfigPath, getCvhHomeDir } = await import("../src/config");

    await runUninstall(true, true);
    expect(lastJson<{ purged: boolean }>().purged).toBe(true);
    await expect(readFile(getConfigPath(), "utf8")).rejects.toThrow();

    // 缓存目录也应该被删除（不存在或读取失败均可接受，用 stat 判断更明确）。
    const { stat } = await import("node:fs/promises");
    await expect(stat(getCvhHomeDir())).rejects.toThrow();
  });
});

describe("runToggle", () => {
  test("enable/disable 只写 enabled 字段", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { runToggle } = await import("../src/commands/toggle");
    await runInstall(true);

    await runToggle(true, true);
    expect(lastJson<{ enabled: boolean }>().enabled).toBe(true);
    const { loadConfig } = await import("../src/config");
    expect((await loadConfig()).enabled).toBe(true);

    await runToggle(false, true);
    expect((await loadConfig()).enabled).toBe(false);
  });
});

describe("runConfigGet / runConfigSet", () => {
  test("config set 校验非法 provider 时抛出错误", async () => {
    const { runConfigSet } = await import("../src/commands/configCmd");
    await expect(runConfigSet("provider", "not-a-real-provider", true)).rejects.toThrow(/不支持的 provider/);
  });

  test("config set 合法值落盘后 config get 能读到最新值", async () => {
    const { runConfigSet, runConfigGet } = await import("../src/commands/configCmd");
    await runConfigSet("provider", "anthropic", true);
    await runConfigSet("model", "claude-3-5-sonnet", true);

    await runConfigGet(true);
    const result = lastJson<{ provider: string; model: string }>();
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-3-5-sonnet");
  });

  test("config get 输出脱敏后的 apiKey（不泄露完整明文）", async () => {
    const { runConfigSet, runConfigGet } = await import("../src/commands/configCmd");
    await runConfigSet("apiKey", "sk-1234567890abcdef", true);
    await runConfigGet(true);
    const result = lastJson<{ apiKey: string }>();
    expect(result.apiKey).not.toBe("sk-1234567890abcdef");
    expect(result.apiKey).toContain("***");
  });

  test("config set timeoutMs 非正数时抛出错误", async () => {
    const { runConfigSet } = await import("../src/commands/configCmd");
    await expect(runConfigSet("timeoutMs", "-100", true)).rejects.toThrow(/正数/);
  });

  test("config set baseUrl 非法 URL 时抛出错误", async () => {
    const { runConfigSet } = await import("../src/commands/configCmd");
    await expect(runConfigSet("baseUrl", "not a url", true)).rejects.toThrow(/URL/);
  });

  test("config set baseUrl 缺少 provider 期望路径段时返回非阻断性警告（真机验证时踩过的坑）", async () => {
    const { runConfigSet } = await import("../src/commands/configCmd");
    await runConfigSet("provider", "anthropic", true);
    await runConfigSet("baseUrl", "https://gateway.example.com", true);
    const result = lastJson<{ ok: boolean; warning?: string }>();
    expect(result.ok).toBe(true);
    expect(result.warning).toContain('缺少');
    expect(result.warning).toContain("/v1");

    // 警告是非阻断性的：值仍然要正确落盘，不能因为有警告就拒绝写入。
    const { loadConfig } = await import("../src/config");
    expect((await loadConfig()).baseUrl).toBe("https://gateway.example.com");
  });

  test("config set baseUrl 已带上期望路径段时不返回警告", async () => {
    const { runConfigSet } = await import("../src/commands/configCmd");
    await runConfigSet("provider", "anthropic", true);
    await runConfigSet("baseUrl", "https://gateway.example.com/v1", true);
    const result = lastJson<{ ok: boolean; warning?: string }>();
    expect(result.warning).toBeUndefined();
  });

  test("config set baseUrl 为官方地址时即使缺路径段也不报警告", async () => {
    const { runConfigSet } = await import("../src/commands/configCmd");
    await runConfigSet("provider", "oai", true);
    await runConfigSet("baseUrl", "https://api.openai.com", true);
    const result = lastJson<{ ok: boolean; warning?: string }>();
    expect(result.warning).toBeUndefined();
  });
});

describe("runStatus", () => {
  test("展示 enabled/hooksInstalled/mcpInstalled/cache 的完整快照", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { installMcpServer } = await import("../src/claudeMcp");
    const { runStatus } = await import("../src/commands/status");
    await runInstall(true);
    await installMcpServer();

    await runStatus(true);
    const result = lastJson<{
      enabled: boolean;
      hooksInstalled: { userPromptSubmit: boolean; postToolUse: boolean };
      mcpInstalled: boolean;
      cache: { entries: number };
    }>();
    expect(result.enabled).toBe(false);
    expect(result.hooksInstalled).toEqual({ userPromptSubmit: true, postToolUse: true });
    expect(result.mcpInstalled).toBe(true);
    expect(result.cache.entries).toBe(0);
  });
});

describe("runDoctor", () => {
  test("未配置 apiKey 时视觉模型连通性检查跳过，且整体判定失败（allOk=false）", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { runDoctor } = await import("../src/commands/doctor");
    await runInstall(true);

    await runDoctor(true);
    const result = lastJson<{ ok: boolean; checks: Array<{ name: string; ok: boolean }> }>();
    expect(result.ok).toBe(false);
    const apiKeyCheck = result.checks.find((c) => c.name === "API Key 已配置");
    expect(apiKeyCheck?.ok).toBe(false);
  });

  test("MCP 未注册时不影响整体判定（可选项，ok 恒为 true）", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { runConfigSet } = await import("../src/commands/configCmd");
    const { runDoctor } = await import("../src/commands/doctor");
    await runInstall(true);
    await runConfigSet("apiKey", "sk-test", true);

    const { APICallError } = await import("ai");
    mock.module("ai", () => ({
      APICallError,
      generateText: async () => ({ text: "ok" }),
    }));

    await runDoctor(true);
    const result = lastJson<{ checks: Array<{ name: string; ok: boolean; detail: string }> }>();
    const mcpCheck = result.checks.find((c) => c.name.includes("MCP"));
    expect(mcpCheck?.ok).toBe(true);
    expect(mcpCheck?.detail).toContain("未注册");
  });

  test("baseUrl 缺少路径段时该检查项判定失败，且影响整体 allOk（真机验证时踩过的坑）", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { runConfigSet } = await import("../src/commands/configCmd");
    const { runDoctor } = await import("../src/commands/doctor");
    await runInstall(true);
    await runConfigSet("provider", "anthropic", true);
    // 故意跳过校验直接写裸域名（config set 只警告不阻断），模拟用户忽略警告继续操作的场景。
    await runConfigSet("baseUrl", "https://gateway.example.com", true);
    await runConfigSet("apiKey", "sk-test", true);

    await runDoctor(true);
    const result = lastJson<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }>();
    const baseUrlCheck = result.checks.find((c) => c.name.includes("baseUrl"));
    expect(baseUrlCheck?.ok).toBe(false);
    expect(baseUrlCheck?.detail).toContain("/v1");
    expect(result.ok).toBe(false);
  });

  test("未配置 baseUrl 时不出现 baseUrl 检查项（使用 provider 官方默认地址，无需检查）", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { runConfigSet } = await import("../src/commands/configCmd");
    const { runDoctor } = await import("../src/commands/doctor");
    await runInstall(true);
    await runConfigSet("apiKey", "sk-test", true);

    const { APICallError } = await import("ai");
    mock.module("ai", () => ({
      APICallError,
      generateText: async () => ({ text: "ok" }),
    }));

    await runDoctor(true);
    const result = lastJson<{ checks: Array<{ name: string }> }>();
    expect(result.checks.some((c) => c.name.includes("baseUrl"))).toBe(false);
  });
});

describe("runTestImage", () => {
  test("未配置 apiKey 时抛出明确错误", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { runTestImage } = await import("../src/commands/testImage");
    await runInstall(true);

    const imgPath = join(tmpHome, "probe.png");
    await mkdir(tmpHome, { recursive: true });
    await writeFile(imgPath, Buffer.from("fake"));

    await expect(runTestImage(imgPath, true)).rejects.toThrow(/API Key/);
  });

  test("不支持的图片格式直接报错，不读取文件", async () => {
    const { runTestImage } = await import("../src/commands/testImage");
    await expect(runTestImage("/tmp/notes.txt", true)).rejects.toThrow(/不支持的图片格式/);
  });

  test("配置齐全时成功解析并输出耗时", async () => {
    const { runInstall } = await import("../src/commands/install");
    const { runConfigSet } = await import("../src/commands/configCmd");
    const { runTestImage } = await import("../src/commands/testImage");
    await runInstall(true);
    await runConfigSet("apiKey", "sk-test", true);

    const { APICallError } = await import("ai");
    mock.module("ai", () => ({
      APICallError,
      generateText: async () => ({ text: "一张测试图片" }),
    }));

    const imgPath = join(tmpHome, "probe.png");
    await writeFile(imgPath, Buffer.from("fake png bytes"));
    await runTestImage(imgPath, true);

    const result = lastJson<{ ok: boolean; description: string; elapsedMs: number }>();
    expect(result.ok).toBe(true);
    expect(result.description).toBe("一张测试图片");
    expect(typeof result.elapsedMs).toBe("number");
  });
});

describe("runMcpInstall / runMcpUninstall / runMcpStatus", () => {
  test("install 后 status 报告已注册，uninstall 后恢复未注册", async () => {
    const { runMcpInstall, runMcpUninstall, runMcpStatus } = await import("../src/commands/mcpCmd");

    await runMcpInstall(true);
    expect(lastJson<{ ok: boolean; changed: boolean }>().changed).toBe(true);

    await runMcpStatus(true);
    expect(lastJson<{ installed: boolean }>().installed).toBe(true);

    await runMcpUninstall(true);
    expect(lastJson<{ ok: boolean; removed: boolean }>().removed).toBe(true);

    await runMcpStatus(true);
    expect(lastJson<{ installed: boolean }>().installed).toBe(false);
  });
});
