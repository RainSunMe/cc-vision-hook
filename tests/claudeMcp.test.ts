/**
 * claudeMcp.ts 单测：验证 `~/.claude.json` 里 MCP server 注册/卸载的幂等性，
 * 以及不误伤用户已有的其他 MCP server 配置。
 *
 * 用 `CVH_CLAUDE_HOME` 指向临时目录（同 claudeSettings.test.ts 的隔离方式）——
 * getGlobalConfigPath() 会从其父目录推导出 `~/.claude.json` 的位置。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "cvh-mcp-config-test-"));
  // CVH_CLAUDE_HOME 指向 "<tmpRoot>/.claude"，claudeMcp.ts 据此推导出 "<tmpRoot>/.claude.json"。
  process.env.CVH_CLAUDE_HOME = join(tmpRoot, ".claude");
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpRoot, { recursive: true, force: true });
});

const globalConfigPath = (): string => join(tmpRoot, ".claude.json");

describe("installMcpServer", () => {
  test("首次安装：~/.claude.json 不存在时创建并写入 stdio server 条目", async () => {
    const { installMcpServer, checkMcpInstalled } = await import("../src/claudeMcp");
    const changed = await installMcpServer();
    expect(changed).toBe(true);
    expect(await checkMcpInstalled()).toBe(true);

    const raw = await readFile(globalConfigPath(), "utf8");
    const config = JSON.parse(raw) as { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
    expect(config.mcpServers["cc-vision-hook"]).toEqual({ type: "stdio", command: "cvh", args: ["mcp", "serve"] });
  });

  test("重复执行 install 是幂等的：第二次报告未变化", async () => {
    const { installMcpServer } = await import("../src/claudeMcp");
    const first = await installMcpServer();
    const second = await installMcpServer();
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("已有其他 MCP server 配置时，install 不会覆盖或误删它们", async () => {
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(
      globalConfigPath(),
      JSON.stringify({
        mcpServers: {
          "some-other-server": { type: "stdio", command: "other-tool", args: ["serve"] },
        },
      }),
    );

    const { installMcpServer } = await import("../src/claudeMcp");
    await installMcpServer();

    const raw = await readFile(globalConfigPath(), "utf8");
    const config = JSON.parse(raw) as { mcpServers: Record<string, { command: string }> };
    expect(config.mcpServers["some-other-server"]?.command).toBe("other-tool");
    expect(config.mcpServers["cc-vision-hook"]?.command).toBe("cvh");
  });
});

describe("uninstallMcpServer", () => {
  test("卸载后 MCP server 条目不再存在", async () => {
    const { installMcpServer, uninstallMcpServer, checkMcpInstalled } = await import("../src/claudeMcp");
    await installMcpServer();
    const removed = await uninstallMcpServer();
    expect(removed).toBe(true);
    expect(await checkMcpInstalled()).toBe(false);
  });

  test("卸载精确按 server 名过滤，不误删用户自己配置的其他 server", async () => {
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(
      globalConfigPath(),
      JSON.stringify({
        mcpServers: {
          "cc-vision-hook": { type: "stdio", command: "cvh", args: ["mcp", "serve"] },
          "some-other-server": { type: "stdio", command: "other-tool", args: ["serve"] },
        },
      }),
    );

    const { uninstallMcpServer } = await import("../src/claudeMcp");
    const removed = await uninstallMcpServer();
    expect(removed).toBe(true);

    const raw = await readFile(globalConfigPath(), "utf8");
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers["cc-vision-hook"]).toBeUndefined();
    expect(config.mcpServers["some-other-server"]).toBeDefined();
  });

  test("~/.claude.json 不存在时卸载不报错，返回 false", async () => {
    const { uninstallMcpServer } = await import("../src/claudeMcp");
    expect(await uninstallMcpServer()).toBe(false);
  });
});

describe("checkMcpInstalled", () => {
  test("从未安装过时返回 false", async () => {
    const { checkMcpInstalled } = await import("../src/claudeMcp");
    expect(await checkMcpInstalled()).toBe(false);
  });
});
