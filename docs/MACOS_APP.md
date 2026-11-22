# Magpie Quick macOS App

仓库增加独立的 SwiftUI macOS 应用。App 内置 Node.js Runtime，复用原项目的 Quick WebSocket、OAuth、工具桥接与会话复用代码，不依赖 magpie 插件宿主。

## 使用步骤

1. 从 GitHub Releases 下载 DMG，将 MagpieQuick.app 拖到 Applications。
2. 打开「账号管理」并点击「添加账号」，通过浏览器完成 Amazon Quick OAuth 登录。
3. 打开「代理设置」，确认端口和 API Key。
4. 打开「服务概览」，点击「启动代理」。

默认监听 127.0.0.1:3426。OpenAI Base URL 为 http://127.0.0.1:3426/v1；Anthropic Messages 为 http://127.0.0.1:3426/v1/messages。客户端按需要填写根 URL 或带 /v1 的 URL。使用本机 App 显示的 API Key。

支持 fast / balanced / smart / advanced 档位。Claude Haiku / Sonnet / Opus 名称分别映射到 fast / balanced / smart，最终实际模型由 Quick 服务端决定。

## Claude Code 本地工具

Claude Code 的文件读取、代码修改、终端调用都在 Claude Code 客户端执行。原项目把调用请求转换为工具标记，模型必须遵循该协议，才能返回正常的 tool_use。已使用 Claude Code 2.1.326、Read 工具和独立临时目录执行真实端到端测试：Read 读取本地文件、Write 在临时目录写入本地文件均成功，退出码均为 0。其他工具仍需按具体场景验证。

## 开发

运行测试：npm test。独立代理：node bin/serve.mjs。账号登录：node bin/manage.mjs login。账号列表：node bin/manage.mjs list。

GitHub Actions 自动构建 Apple Silicon + Intel 通用 App，完成测试后发布预览 DMG 和 ZIP。

其他兼容性限制参见 docs/MACOS_NOTES.md。
