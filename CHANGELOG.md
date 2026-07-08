# Changelog

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
