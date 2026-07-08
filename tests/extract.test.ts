/**
 * extract.ts 的 fixture 驱动测试。
 *
 * fixture 来源：真实 Claude Code tool_response 样本（Read / MCP / Bash 三种 schema），逐一验证：
 * - 含图片的样本能被正确提取出 base64 + mimeType；
 * - 不含图片的同类样本（文本响应）不会被误判为图片（回归防护，避免规则过于宽松）。
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractImages } from "../src/extract";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

const loadFixture = async (name: string): Promise<unknown> => {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw);
};

describe("extractImages — Read 工具", () => {
  test("图片响应：提取出正确的 base64 + mimeType", async () => {
    const fixture = await loadFixture("read-tool-response.json");
    const images = extractImages(fixture);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.base64.length).toBeGreaterThan(0);
  });

  test("文本响应：不误判为图片", async () => {
    const fixture = await loadFixture("read-tool-response-text.json");
    const images = extractImages(fixture);
    expect(images).toHaveLength(0);
  });
});

describe("extractImages — MCP 工具（content block 数组）", () => {
  test("图片响应：数组套 Anthropic 原生 image block", async () => {
    const fixture = await loadFixture("mcp-tool-response.json");
    const images = extractImages(fixture);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
  });

  test("文本响应：不误判为图片", async () => {
    const fixture = await loadFixture("mcp-tool-response-text.json");
    const images = extractImages(fixture);
    expect(images).toHaveLength(0);
  });
});

describe("extractImages — Bash/PowerShell 工具（isImage 旁路标志 + data URI）", () => {
  test("isImage=true 时从 stdout 的 data URI 里提取图片", async () => {
    const fixture = await loadFixture("bash-tool-response.json");
    const images = extractImages(fixture);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
  });

  test("isImage=false 时不从 stdout 提取（即使 stdout 里恰好有 base64 样式的文本也不应该误判）", async () => {
    const fixture = await loadFixture("bash-tool-response-text.json");
    const images = extractImages(fixture);
    expect(images).toHaveLength(0);
  });
});

describe("extractImages — 边界情况", () => {
  test("null/undefined 输入返回空数组", () => {
    expect(extractImages(null)).toHaveLength(0);
    expect(extractImages(undefined)).toHaveLength(0);
  });

  test("空对象/空数组返回空数组", () => {
    expect(extractImages({})).toHaveLength(0);
    expect(extractImages([])).toHaveLength(0);
  });

  test("纯字符串（非 data URI）不提取", () => {
    expect(extractImages("hello world")).toHaveLength(0);
  });

  test("过短的 base64 样字符串不被误判（长度 < 64）", () => {
    const images = extractImages({ type: "image/png", data: "YWJj" });
    expect(images).toHaveLength(0);
  });

  test("嵌套一层的图片结构（如 { outer: { file: { base64, type } } }）也能递归找到", () => {
    const nested = {
      outer: {
        file: {
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          type: "image/png",
        },
      },
    };
    const images = extractImages(nested);
    expect(images).toHaveLength(1);
  });

  test("多张图片混合在数组中（如多个 MCP 工具调用结果拼接）全部被提取", () => {
    const multi = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
      { type: "text", text: "some text" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
    ];
    const images = extractImages(multi);
    expect(images).toHaveLength(2);
    expect(images.map((i) => i.mimeType)).toEqual(["image/png", "image/jpeg"]);
  });

  test("超过大小上限（20MB）的 base64 字段不被提取，避免误判超大无关字段", () => {
    // 构造一个解码后约 21MB 的假 base64 字符串（不追求真实图片内容，只测大小阈值判断）。
    const hugeBase64 = "A".repeat(Math.ceil((21 * 1024 * 1024 * 4) / 3));
    const images = extractImages({ type: "image/png", data: hugeBase64 });
    expect(images).toHaveLength(0);
  });
});
