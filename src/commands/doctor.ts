/**
 * `cvh doctor` 命令实现：自检配置有效性、API key 可用性、Hook 注册完整性，
 * 并显著提示 cvh 的适用边界（仅对"静默忽略图片"型模型有效）。
 */

import { stat } from "node:fs/promises";
import { loadConfig, getConfigPath } from "../config.js";
import { checkHooksInstalled } from "../claudeSettings.js";
import { checkMcpInstalled } from "../claudeMcp.js";
import { describeImage, EXPECTED_BASE_URL_SEGMENT } from "../vision.js";

/** 官方 API 地址不需要提示——AI SDK 对这几个官方域名有特殊处理，会自动补路径段。 */
const OFFICIAL_ENDPOINT_RE = /^https:\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)/;

// 1x1 透明 PNG，仅用于自检时验证视觉模型连通性，不产生真实业务含义。
const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 执行一整套自检并打印结果。
 *
 * @param jsonOutput - 是否以 JSON 格式输出结果
 */
export const runDoctor = async (jsonOutput: boolean): Promise<void> => {
  const checks: DoctorCheck[] = [];
  const config = await loadConfig();

  checks.push({ name: "配置文件存在", ok: true, detail: getConfigPath() });

  try {
    const s = await stat(getConfigPath());
    // eslint-disable-next-line no-bitwise
    const mode = (s.mode & 0o777).toString(8);
    checks.push({ name: "配置文件权限", ok: mode === "600", detail: `当前权限 ${mode}（建议 600，避免同机其他用户读取明文 API key）` });
  } catch {
    checks.push({ name: "配置文件权限", ok: false, detail: "配置文件不存在，请先运行 cvh install" });
  }

  const hooks = await checkHooksInstalled();
  checks.push({ name: "UserPromptSubmit Hook 已注册", ok: hooks.userPromptSubmit, detail: hooks.userPromptSubmit ? "" : "请运行 cvh install" });
  checks.push({ name: "PostToolUse Hook 已注册", ok: hooks.postToolUse, detail: hooks.postToolUse ? "" : "请运行 cvh install" });

  // MCP 是可选功能，未安装不算失败项（不计入 allOk），只是提示性展示——
  // 呼应既定设计："cvh disable 不卸载 MCP，cvh enable 不安装 MCP"，MCP 与主开关正交。
  const mcpInstalled = await checkMcpInstalled();
  checks.push({
    name: "MCP server 已注册（可选）",
    ok: true,
    detail: mcpInstalled ? "已注册，Agent 可调用 vision_ask 等工具" : "未注册（可选功能，运行 cvh mcp install 启用）",
  });

  checks.push({ name: "API Key 已配置", ok: Boolean(config.apiKey), detail: config.apiKey ? "已设置" : "请运行 cvh config set apiKey <key>" });

  // 真机验证时踩过的坑：AI SDK 不会给自定义网关的 baseUrl 自动补路径段（如 "/v1"），
  // 裸域名会在真正调用视觉模型时才报一个语义不明的 404，排查成本很高。这里提前检查，
  // 不管 provider/baseUrl 是以什么顺序设置的都能覆盖（config set 时的警告只能覆盖
  // "先设 provider 再设 baseUrl" 这一种顺序，这里用最终生效的配置兜底检查所有顺序）。
  if (config.baseUrl) {
    const expectedSegment = EXPECTED_BASE_URL_SEGMENT[config.provider];
    const isOfficial = OFFICIAL_ENDPOINT_RE.test(config.baseUrl);
    const looksOk = isOfficial || config.baseUrl.includes(expectedSegment);
    checks.push({
      name: "baseUrl 路径段检查",
      ok: looksOk,
      detail: looksOk
        ? ""
        : `baseUrl "${config.baseUrl}" 可能缺少 ${config.provider} provider 期望的路径段 "${expectedSegment}"，` +
          `建议改成 "${config.baseUrl}${expectedSegment}"，否则调用时会收到语义不明的 404`,
    });
  }

  if (config.apiKey) {
    try {
      const start = Date.now();
      await describeImage(PROBE_IMAGE_BASE64, "image/png", config, "这是什么？一个字回答即可。");
      checks.push({ name: "视觉模型连通性", ok: true, detail: `调用成功，耗时 ${Date.now() - start}ms` });
    } catch (error) {
      checks.push({ name: "视觉模型连通性", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  } else {
    checks.push({ name: "视觉模型连通性", ok: false, detail: "跳过（未配置 API Key）" });
  }

  const allOk = checks.every((c) => c.ok);

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: allOk, checks, boundaryWarning: BOUNDARY_WARNING }));
    return;
  }

  for (const check of checks) {
    console.log(`${check.ok ? "✅" : "❌"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  console.log("");
  console.log(BOUNDARY_WARNING);
};

const BOUNDARY_WARNING =
  "⚠️  重要边界声明：cvh 只对「静默忽略图片」型模型有效（模型收到图片后不报错，只是不理解）。\n" +
  "   对「协议层硬拒绝」型模型（收到图片直接导致整个请求失败/报错）完全无效，装了 cvh 该场景依然会失败。\n" +
  "   请自行判断当前使用的模型属于哪一种，再决定是否启用 cvh。";
