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


## 重型科研任务：长工具输出的处理（2026-11-23）

- Quick 用户消息有单帧大小上限。代理优先保留最新的 Bash/Read/其他本地工具结果，必要时删除旧会话中重复的历史。此前 537 和 802 字节的新结果被旧结果挤掉的问题已通过 87 条历史消息回归测试。
- 本轮工具返回的文本超过安全预算时，代理将较大的结果按最多约 20 KiB 分帧，通过同一个 Quick 线程顺序发送。同一帧可打包多个小结果。每一帧收到独立 ACK 后，才发送下一帧；最终业务请求引用这些已有结果。短结果保留在最终请求。
- 分帧转发默认开启，可使用环境变量 QUICK_TOOL_RELAY=0 关闭。QUICK_SESSION_REUSE=1 可开启会话复用。单轮分帧总量上限 8 MiB，最多 512 帧。超限或无 ACK 明确返回错误。
- 分帧机制确保字节内容作为消息发送；收到 ACK 不等于模型能逐字记住全部历史。处理论文数值、长表格和日志时仍应使用范围读取、表格检索和程序统计。
- Anthropic SSE 转换使用按 tool_call.index 跟踪的状态机，多段 OpenAI 工具参数进入同一个 Anthropic tool_use 内容块。流式错误表现为 error 事件。
- 技术参考及设计取舍记录在 docs/PROXY_REFERENCE_REVIEW.md。


## 工具输出容量（2026-11-23 512 KiB 修复）

- 默认每条客户端工具结果允许 512 KiB（524,288 字节），是此前 16 KiB 预截断上限的 32 倍。旧历史工具结果不再预先压缩到 2 KiB。超过 512 KiB 的单条结果明确返回 HTTP 413，不会静默只保留头尾。
- 同一客户端请求最多可分帧传输 8 MiB 工具结果，最多 512 帧。Quick 每条 WebSocket 消息仍保持约 24 KiB 的安全传输帧（服务器消息限制约 64 KiB）。本地 HTTP 请求体上限提高到 32 MiB，以接纳 Claude Code 的长历史。
- 发送前核对最新工具结果原文。短结果如因历史对话占用预算而未进入最终消息，将自动转为分帧传输。若依然无法完整送达，则返回显式错误。
- 升级后的会话作用域会避开旧版可能存有截断结果的 Quick 缓存线程。OAuth 账号、API Key 和端口配置保持原样。
- 512 KiB 是客户端向代理提交且可分帧发送的字节上限，不代表模型保证逐字记忆 512 KiB。科研数值核对应通过本地程序保存完整审计文件。

## Claude Desktop + CC Switch：工具结果被误判为 PARTIAL（2026-11-23）

根据 Desktop 内嵌 Claude Code 的本地真实会话记录，原始工具输出 3452 B、17442 B、29443 B 完整；CC Switch 的转发日志显示进入本代理的 OpenAI Chat 接口，模型 smart，端口 8810。这不属于独立 Claude Code CLI 验证。

- 新 Quick 线程重建长历史时，旧版本会把陈旧工具结果压成带 PARTIAL 标记的头尾，污染新请求。新版直接省略历史工具结果正文，当前工具结果保持完整；超过预算走分帧，不可交付则明确失败。
- 以最近实际 tool_calls 消息识别当前结果，不让纯文本 Assistant 消息误判工具调用边界。
- 更新线程组版本 desktop-fresh-tools-v4，避免继承之前 Quick 线程的错误标记。
- 可选元数据诊断：在用户数据目录新建空文件 .enable-transport-audit；transport-audit.jsonl 记录仅数字和时间，包括消息数、当前工具结果数量及字节数、分帧数、上下文预算和生成 PARTIAL 数量。绝不记录用户 Prompt、工具正文、文件路径、账号或 API Key。权限 0600，512 KiB 轮转。删除标记文件即可关闭。
- CC Switch 选择 Claude Desktop 代理模式、OpenAI Chat 格式，Base URL 为 http://127.0.0.1:8810/v1，模型路由 Opus->smart、Sonnet->balanced、Haiku->fast、Fable->advanced；不建议将 supports1m 设为 true。
- 新测试复现 Desktop OpenAI Chat 的 45 组历史 tool_call/result、112 工具定义、31KB 系统提示和 300/60 行输出，在模拟 Quick 的完整 HTTP 链路中验证。真实 Desktop GUI 的恢复必须由后续实际请求确认。
