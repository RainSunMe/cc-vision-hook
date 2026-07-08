/**
 * claudeSettings.ts 单测：验证 Hook 注册/卸载的幂等性，以及不误伤用户已有的其他 Hook 配置。
 *
 * 用 `CVH_CLAUDE_HOME` 指向临时目录，隔离真实 `~/.claude/settings.json`。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "cvh-settings-test-"));
  process.env.CVH_CLAUDE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.CVH_CLAUDE_HOME;
  await rm(tmpHome, { recursive: true, force: true });
});

describe("installHooks", () => {
  test("首次安装：settings.json 不存在时创建并写入两个 Hook", async () => {
    const { installHooks, checkHooksInstalled } = await import("../src/claudeSettings");
    const added = await installHooks();
    expect(added).toBe(2);

    const status = await checkHooksInstalled();
    expect(status.userPromptSubmit).toBe(true);
    expect(status.postToolUse).toBe(true);
  });

  test("PostToolUse Hook 注册时显式带 matcher: \"*\"（不能依赖默认留空行为）", async () => {
    const { installHooks } = await import("../src/claudeSettings");
    await installHooks();
    const raw = await readFile(join(tmpHome, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { hooks: { PostToolUse: Array<{ matcher?: string }> } };
    expect(settings.hooks.PostToolUse[0]?.matcher).toBe("*");
  });

  test("重复执行 install 是幂等的：第二次不新增条目", async () => {
    const { installHooks } = await import("../src/claudeSettings");
    const first = await installHooks();
    const second = await installHooks();
    expect(first).toBe(2);
    expect(second).toBe(0);

    const raw = await readFile(join(tmpHome, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { hooks: { UserPromptSubmit: unknown[]; PostToolUse: unknown[] } };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
  });

  test("已有其他 Hook 配置时，install 不会覆盖或误删它们", async () => {
    await mkdir(tmpHome, { recursive: true });
    await writeFile(
      join(tmpHome, "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "some-other-tool hook" }] }],
        },
        permissions: { defaultMode: "bypassPermissions" },
      }),
    );

    const { installHooks } = await import("../src/claudeSettings");
    await installHooks();

    const raw = await readFile(join(tmpHome, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
      permissions: { defaultMode: string };
    };
    // 用户原有的其他 Hook 条目应该还在
    expect(settings.hooks.UserPromptSubmit.some((g) => g.hooks.some((h) => h.command === "some-other-tool hook"))).toBe(true);
    // cvh 的条目也应该被追加进去
    expect(settings.hooks.UserPromptSubmit.some((g) => g.hooks.some((h) => h.command === "cvh hook user-prompt-submit"))).toBe(true);
    // 用户原有的非 hooks 配置（如 permissions）不应该被动
    expect(settings.permissions.defaultMode).toBe("bypassPermissions");
  });
});

describe("uninstallHooks", () => {
  test("卸载后两个 Hook 都不再存在", async () => {
    const { installHooks, uninstallHooks, checkHooksInstalled } = await import("../src/claudeSettings");
    await installHooks();
    const removed = await uninstallHooks();
    expect(removed).toBe(2);

    const status = await checkHooksInstalled();
    expect(status.userPromptSubmit).toBe(false);
    expect(status.postToolUse).toBe(false);
  });

  test("卸载精确按 command 字符串过滤，不误删用户自己配置的其他 Hook", async () => {
    await mkdir(tmpHome, { recursive: true });
    await writeFile(
      join(tmpHome, "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "cvh hook user-prompt-submit", timeout: 60 }] },
            { hooks: [{ type: "command", command: "some-other-tool hook" }] },
          ],
        },
      }),
    );

    const { uninstallHooks } = await import("../src/claudeSettings");
    const removed = await uninstallHooks();
    expect(removed).toBe(1);

    const raw = await readFile(join(tmpHome, "settings.json"), "utf8");
    const settings = JSON.parse(raw) as { hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe("some-other-tool hook");
  });

  test("settings.json 不存在时卸载不报错，返回 0", async () => {
    const { uninstallHooks } = await import("../src/claudeSettings");
    expect(await uninstallHooks()).toBe(0);
  });
});

describe("checkHooksInstalled", () => {
  test("从未安装过时两者都为 false", async () => {
    const { checkHooksInstalled } = await import("../src/claudeSettings");
    const status = await checkHooksInstalled();
    expect(status.userPromptSubmit).toBe(false);
    expect(status.postToolUse).toBe(false);
  });
});
