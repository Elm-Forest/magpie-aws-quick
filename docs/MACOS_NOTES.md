# macOS 兼容性与限制

- 项目使用 Amazon Quick 未公开的登录和聊天 WebSocket 协议；服务端协议更新可能影响连接。使用自己的账号并遵守上游服务条款。
- Anthropic Messages 适配支持文字、普通响应、SSE、工具声明、tool_use 和 tool_result。未实现完整 Batch、文件、图片、PDF、思考签名、缓存控制等 API。
- count_tokens 使用估算方法，响应中标识 estimated: true。
- Haiku/Sonnet/Opus 仅映射到 Quick 的 fast/balanced/smart 档位；无法强制指定底层具体模型版本。
- 目前工具调用依赖原项目的文本协议标记。已在 Claude Code 2.1.326 真实验证 Read 和 Write 工具，在独立 /tmp 测试目录正确读写文件。复杂工具链和后续客户端版本仍需分别测试。
- Quick 云端内置工具没有用户电脑的文件系统访问权限，本地文件访问必须经 Claude Code 的客户端工具完成。
- App 不依赖用户单独安装 Node.js 或 magpie，但首次使用需要自行完成 OAuth 登录。
- 程序的本机配置和 OAuth 登录令牌保存在 ~/Library/Application Support/MagpieQuick，敏感文件权限 0600，不要共享此目录。
- 本地服务仅监听 127.0.0.1。端口占用会导致启动失败。
- macOS App 使用临时 ad-hoc 代码签名，未经过 Apple 公证；首次打开可能受到系统安全设置限制。
- 退出 App 会尝试结束由该 App 创建的服务进程；不会自动终止旧 QuickProxy 或 magpie 进程。


## 长任务上下文预算与 High 模式（2026-11-23 修复）

- Claude Code 可发送 100+ 项工具定义。代理为当前消息预留最多约 16 KiB（按系统提示词占用动态调整），并使用紧凑工具说明；Bash、Read、Write、Edit 等关键工具保留参数字段提示，其他工具名称仍可查询。
- 当一轮并发工具结果超过剩余消息预算时，代理优先完整保留小结果，再将大结果按字节预算截取头尾，并显式标记 PARTIAL TOOL RESULT 或 TRUNCATED。受 Amazon Quick 单次消息帧上限限制，无法无损传递任意数量的大文件或日志。
- 工具协议仍依赖上游模型生成文本工具调用标记；112 工具负载测试通过并不代表所有复杂工具组合都具有官方 Anthropic 原生工具调用的可靠性。
- output_config.effort 通过 Anthropic 转换层传给原有 OpenAI 代理，最终以 Quick 的 thinking_effort 字段发送。该字段表示请求强度，实际服务端调度由上游决定。
- 工具消息发生压缩时会输出字节数与计数日志，不记录工具内容、文件路径、令牌和系统提示词文本。需要重读原始大文件时应通过客户端工具缩小读取范围。
