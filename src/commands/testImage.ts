/**
 * `cvh test-image <path>` 命令实现：本地图片 -> 视觉解析 -> 打印描述，验证链路通畅。
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { loadConfig } from "../config.js";
import { describeImage } from "../vision.js";

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * 读取本地图片文件，调用当前配置的视觉模型解析并打印结果。
 *
 * @param path - 本地图片文件路径
 * @param jsonOutput - 是否以 JSON 格式输出
 * @throws 当文件不存在、格式不支持或视觉模型调用失败时抛出错误
 */
export const runTestImage = async (path: string, jsonOutput: boolean): Promise<void> => {
  const mimeType = EXT_TO_MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`不支持的图片格式：${path}（支持 png/jpg/jpeg/webp/gif）`);

  const bytes = await readFile(path);
  const config = await loadConfig();
  if (!config.apiKey) throw new Error("尚未配置 API Key，请先运行 cvh config set apiKey <key>");

  const start = Date.now();
  const description = await describeImage(bytes.toString("base64"), mimeType, config);
  const elapsedMs = Date.now() - start;

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, description, elapsedMs }));
    return;
  }
  console.log(`✅ 解析成功（耗时 ${elapsedMs}ms）：`);
  console.log(description);
};
