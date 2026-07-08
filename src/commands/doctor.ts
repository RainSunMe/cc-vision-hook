/**
 * `cvh doctor` 命令实现：自检配置有效性、API key 可用性、Hook 注册完整性，
 * 并显著提示 cvh 的适用边界（仅对"静默忽略图片"型模型有效）。
 */

import { stat } from "node:fs/promises";
import { loadConfig, getConfigPath } from "../config.js";
import { checkHooksInstalled } from "../claudeSettings.js";
import { describeImage } from "../vision.js";

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

  checks.push({ name: "API Key 已配置", ok: Boolean(config.apiKey), detail: config.apiKey ? "已设置" : "请运行 cvh config set apiKey <key>" });

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
