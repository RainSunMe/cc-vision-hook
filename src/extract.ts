/**
 * 通用图片提取器：不依赖任何工具的固定 schema，只依赖结构自省 + 少量已知的旁路触发规则。
 *
 * 已知三种真实 tool_response shape，彼此完全不同：
 *   - Read 工具：判别式对象 { type: "image", file: { base64, type, ... } }
 *   - MCP 工具：content block 数组 [{ type: "image", source: { type, media_type, data } }]
 *   - Bash/PowerShell 工具：扁平对象 + isImage 布尔标志，图片是 stdout 里的完整 data URI 字符串
 * 因为 cvh 的策略是"只追加不替换"（不需要精确还原成目标 schema），
 * 提取器只需要"找到"图片，不需要保留可回写的精确路径信息。
 */

/** 单张被提取出来的图片。 */
export interface ExtractedImage {
  /** 不含 data URI 前缀的纯 base64 数据。 */
  base64: string;
  /** 形如 "image/png" 的 MIME 类型。 */
  mimeType: string;
  /** 在原始结构中的调试定位路径（如 "$.file.base64"），仅用于日志排查，不用于回写。 */
  path: string;
}

// base64 解码后的大小上限（20MB）。参考 Claude Code 官方 BashTool 的 MAX_IMAGE_FILE_SIZE 同款阈值，
// 避免把无关的大 base64 字段误判成图片、发起不必要的视觉解析调用。
const MAX_DECODED_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPE_MARKERS = new Set(["image", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/bmp"]);
const BASE64_FIELD_NAMES = ["base64", "data"];
const MIME_FIELD_NAMES = ["type", "media_type", "mimeType"];
// Bash/PowerShell 场景下，isImage===true 时应该去检查的候选字符串字段名。
const DATA_URI_CARRIER_FIELDS = ["stdout", "output", "content"];

const DATA_URI_RE = /^data:(image\/[a-z0-9.+_-]+);base64,(.+)$/i;
// base64 字符集校验（允许换行/空白，做基础粗过滤，不追求 100% 严格）。
const BASE64_CHARSET_RE = /^[A-Za-z0-9+/=\s]+$/;

/**
 * 粗略判断一个字符串是否"像"base64 编码内容：长度、字符集、且解码后不超过大小上限。
 *
 * @param value - 待检测的字符串
 * @returns 是否可能是合法的图片 base64 数据
 */
const looksLikeBase64 = (value: string): boolean => {
  if (value.length < 64) return false; // 太短的字符串不太可能是图片
  if (!BASE64_CHARSET_RE.test(value)) return false;
  // base64 每 4 字符编码 3 字节，用长度估算解码后大小，避免真的 decode 一次超大字符串。
  const estimatedBytes = (value.length / 4) * 3;
  return estimatedBytes <= MAX_DECODED_BYTES;
};

/**
 * 判断某个字符串值是否命中"图片类型标记"（如 "image"、"image/png" 等）。
 *
 * @param value - 待检测的字符串
 * @returns 是否是已知的图片类型标记
 */
const matchesImageTypeMarker = (value: string): boolean =>
  IMAGE_TYPE_MARKERS.has(value) || /^image\/[a-z0-9.+_-]+$/i.test(value);

/**
 * 把 MIME 字段值归一化成标准的 "image/xxx" 形式（有些字段只给了 "image" 这种粗粒度值时兜底成 png）。
 *
 * @param raw - 原始 MIME 字段值
 * @returns 归一化后的 MIME 类型字符串
 */
const normalizeMime = (raw: string): string => (raw === "image" ? "image/png" : raw);

/**
 * 从任意嵌套的 JSON 结构（对象/数组/字符串）中递归提取出所有可识别的图片。
 *
 * 识别规则（对应三种已知真实样本）：
 * - 规则 A：某一层同时具备"base64 类字段"+"mime 类型字段"（Read/MCP 场景）；
 * - 规则 B：某一层存在 `isImage === true` 标志时，去检查同级的 stdout/output/content 字段（Bash/PowerShell 场景）；
 * - 规则 C：字符串本身就是一个完整的 data URI（配合规则 B 触发，也可能独立命中）。
 *
 * @param node - 待扫描的任意 JSON 值（一般传入某个工具的 tool_response）
 * @param path - 当前递归位置的调试定位路径，外部调用无需传入
 * @returns 本次扫描发现的所有图片（可能为空数组）
 */
export const extractImages = (node: unknown, path = "$"): ExtractedImage[] => {
  const results: ExtractedImage[] = [];

  if (Array.isArray(node)) {
    node.forEach((item, i) => results.push(...extractImages(item, `${path}[${i}]`)));
    return results;
  }

  if (typeof node === "string") {
    // 规则 C：字符串本身是 data URI。
    const match = node.match(DATA_URI_RE);
    if (match?.[1] && match[2] && looksLikeBase64(match[2])) {
      results.push({ base64: match[2], mimeType: match[1], path });
    }
    return results;
  }

  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;

    // 规则 A：本层同时具备 base64 字段 + mime 类型字段。
    const base64Field = BASE64_FIELD_NAMES.find((f) => typeof obj[f] === "string" && looksLikeBase64(obj[f] as string));
    if (base64Field) {
      const mimeValue = MIME_FIELD_NAMES.map((f) => obj[f]).find((v) => typeof v === "string" && matchesImageTypeMarker(v as string));
      if (typeof mimeValue === "string") {
        results.push({ base64: obj[base64Field] as string, mimeType: normalizeMime(mimeValue), path: `${path}.${base64Field}` });
      }
    }

    // 规则 B：isImage===true 旁路标志，检查候选字符串字段是否为 data URI。
    if (obj.isImage === true) {
      for (const field of DATA_URI_CARRIER_FIELDS) {
        const value = obj[field];
        if (typeof value === "string") results.push(...extractImages(value, `${path}.${field}`));
      }
    }

    // 递归所有子字段，覆盖嵌套一层的情况（如 file.base64、source.data）。
    for (const [key, value] of Object.entries(obj)) {
      // 避免对已经在规则 B 里处理过的 data URI 载体字段重复递归产生重复结果。
      if (obj.isImage === true && DATA_URI_CARRIER_FIELDS.includes(key)) continue;
      results.push(...extractImages(value, `${path}.${key}`));
    }
  }

  return results;
};
