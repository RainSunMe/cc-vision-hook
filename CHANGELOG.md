# Changelog

## 0.2.0

### Minor Changes

- 新增 `cvh init` 交互式安装向导，以及可选的 MCP server（`cvh mcp install`/`uninstall`/`status`/`serve`），暴露 `vision_ask`/`vision_describe_image`/`vision_describe_data_url` 三个工具，让 Agent 可以对已解析过的图片主动追问，或直接解析一张新图片/data URL（不依赖历史缓存命中）。

  修复：

  - `cvh install` 此前从未真正创建过配置文件——`loadConfig()` 内部自带 try/catch 兜底，文件不存在时会静默返回默认配置对象而不是抛错，导致 `install.ts` 里 `loadConfig().catch(() => null)` 的判空逻辑永远不会触发。新增 `configFileExists()` 显式检查磁盘状态并修正该逻辑。
  - `cvh uninstall`（含 `--purge`）现在会同时移除 MCP server 注册，避免卸载后残留一个孤立的 MCP 条目。
  - 移除了从未被读取的 `CvhConfig.mcpInstalled` 死字段——MCP 注册状态统一通过 `checkMcpInstalled()` 实时读取 `~/.claude.json`，不再有可能与真实状态不一致的静态字段。
  - **`baseUrl` 缺少路径段时报错信息完全看不出原因**：真机回归测试（Claude Code 2.1.205 + 一个自建兼容网关）时发现，AI SDK 不会给自定义网关的 `baseUrl` 自动补路径段（如 `/v1`），传入裸域名会在真正调用视觉模型时收到一句语义不明的 404 `"Not Found"`，排查成本很高。现在 `describeImage()` 会在 404 + `baseUrl` 明显缺路径段时补充排查提示；`cvh config set baseUrl` 会在设置时提前给出非阻断性警告；`cvh doctor` 新增 `baseUrl 路径段检查` 项。

  其他：

  - `cvh doctor`/`cvh status` 新增 MCP 注册状态展示（MCP 未注册不影响整体自检结果，属于可选功能）。
  - 补齐 `pasteScanner.ts`/`seenTracker.ts`/`commands/*.ts` 的单测覆盖。

  真机回归（Claude Code 升级到 2.1.205 后重新验证）：

  - `PostToolUse` Hook（`Read` 工具触发）：真实调用一个静默忽略图片型模型 + 自建兼容网关，图片识别正确率、`additionalContext` 注入、2 轮完成对话均验证通过。
  - MCP server：`claude mcp list` 确认 stdio 连接成功；真实让 Agent 主动调用 `mcp__cc-vision-hook__vision_describe_image` 工具，返回结果正确。

## 0.1.1

### Patch Changes

- Fix `bin` field paths in `package.json` to remove the leading `./` (npm normalizes this automatically on publish but warns every time — this also serves as the first end-to-end test of the automated release pipeline).

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [0.1.0] - 2026-07-08

首个可发布版本（P0 范围）。

### 新增

- `UserPromptSubmit` Hook：扫描 `~/.claude/image-cache/<session_id>/` 识别用户粘贴的图片。
- `PostToolUse` Hook（`matcher: "*"`）：通用递归提取器识别任意工具的图片输出，已验证覆盖
  三种真实 schema（`Read` 判别式对象 / MCP content block 数组 / `Bash`/`PowerShell` 的
  `isImage` 旁路标志 + data URI 字符串）。
- 两个 Hook 均只输出 `additionalContext`（追加文字描述），不替换/删除原始内容——
  仅对"静默忽略图片"型模型有效，对"协议层硬拒绝"型模型无效（已在 README/`doctor` 中显著声明）。
- 视觉解析统一通过 [AI SDK](https://sdk.vercel.ai/) 对接四个 provider：
  `oai`（Chat Completions）、`responses`（Responses API）、`anthropic`、`gemini`。
- 图片解析结果按内容 hash 缓存在本地磁盘（`~/.claude/cc-vision-hook/cache/`），
  全局共享、TTL 7 天惰性清理，跨来源（粘贴/工具产图）同一张图只解析一次。
- Session 级"已展示过的图片"标记（`seenTracker.ts`），避免多轮对话后
  `additionalContext` 随对话轮数线性膨胀。
- CLI 命令：`install`/`uninstall [--purge]`/`enable`/`disable`/`status`/`doctor`/
  `config get`/`config set`/`test-image`，全部支持 `--json` 输出。
- SDK 导出（`cc-vision-hook/sdk`），供其他 Node/Bun 项目直接内置调用。

### 修复

- **AI SDK provider 混淆**：`"oai"` 配置项曾经直接用 `openai(modelId)` 默认调用，
  在当前 AI SDK 版本下实际解析成 Responses API，导致 `"oai"`/`"responses"` 两个
  配置项形同虚设。已改为显式 `openai.chat(modelId)`，并加回归测试。
- `PostToolUse` Hook 注册补充显式 `matcher: "*"`（不依赖未经验证的默认留空行为）。
- `config set` 增加前置值校验（provider 枚举、baseUrl URL 格式、timeoutMs/maxTokens
  正数校验），避免非法值要等到真正调用视觉模型时才报错。

### 测试

- 55+ 单测覆盖 `extract`/`cache`/`claudeSettings`/`vision`/两个 hook，均为 fixture
  驱动（fixture 来自真实 Claude Code payload 样本）。
- 真机验证：用真实 API Key + Claude Code 2.1.144，在隔离 `HOME` 下验证了完整链路——
  一个协议层"静默忽略图片"型模型在未装 cvh 时会瞎猜图片颜色，装了 cvh 后
  transcript 证实 `additionalContext` 被正确注入并最终答对颜色。

### 已知限制

见 README「已知限制」章节：不支持协议层硬拒绝型模型；粘贴图片场景依赖非官方
实现细节（`~/.claude/image-cache/`）；不做模型能力自动判断；只面向 Claude Code。
