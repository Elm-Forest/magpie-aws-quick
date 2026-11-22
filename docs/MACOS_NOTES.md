# macOS 兼容性与限制

- 项目使用 Amazon Quick 未公开的登录和聊天 WebSocket 协议；服务端协议更新可能影响连接。使用自己的账号并遵守上游服务条款。
- Anthropic Messages 适配支持文字、普通响应、SSE、工具声明、tool_use 和 tool_result。未实现完整 Batch、文件、图片、PDF、思考签名、缓存控制等 API。
- count_tokens 使用估算方法，响应中标识 estimated: true。
- Haiku/Sonnet/Opus 仅映射到 Quick 的 fast/balanced/smart 档位；无法强制指定底层具体模型版本。
- 目前工具调用依赖原项目的文本协议标记。已在 Claude Code 2.1.326 通过真实 Read 工具验证本地文件读取；复杂工具调用、写入以及后续客户端版本仍需分别测试。
- Quick 云端内置工具没有用户电脑的文件系统访问权限，本地文件访问必须经 Claude Code 的客户端工具完成。
- App 不依赖用户单独安装 Node.js 或 magpie，但首次使用需要自行完成 OAuth 登录。
- 程序的本机配置和 OAuth 登录令牌保存在 ~/Library/Application Support/MagpieQuick，敏感文件权限 0600，不要共享此目录。
- 本地服务仅监听 127.0.0.1。端口占用会导致启动失败。
- macOS App 使用临时 ad-hoc 代码签名，未经过 Apple 公证；首次打开可能受到系统安全设置限制。
- 退出 App 会尝试结束由该 App 创建的服务进程；不会自动终止旧 QuickProxy 或 magpie 进程。
