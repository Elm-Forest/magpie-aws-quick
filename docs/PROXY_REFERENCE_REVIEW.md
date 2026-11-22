# 高 Star 代理项目参考与兼容性设计

研究日期：2026-11-23。以下仓库只作为架构、测试方法与协议状态机设计的技术参考，不直接将它们的后端服务嵌入 Magpie Quick，也没有复制整块源代码。

| 项目 | 参考范围 | 许可 | 采取的方法 |
| --- | --- | --- | --- |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Claude/OpenAI 协议转换、Tool Search、Responses Compaction 的输入保留与失败处理 | MIT | 区分原始工具结果、压缩结果；保持 tool_call ID；显式拒绝不完整恢复 |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | Context Archive、history replay、工具调用循环上限及失败路径 | MIT | 对跨请求/长上下文设定上限、确认与可测试的恢复过程 |
| [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) | Anthropic SSE 工具块状态机：按 tool_call.index 保持同一个流式工具块 | MIT | 将碎片化 OpenAI tool_calls 合并到一个 Anthropic tool_use 块 |

本实现保留了原有的 Quick WebSocket 后端。当前 Quick 用户消息有单帧上限，无法像原生 Anthropic/Responses API 那样完整传递无限大的工具结果。因此采用如下分级策略：

1. 优先把最新一轮短工具结果原样放入请求，压缩旧历史并保留最新用户问题。
2. 当前工具结果过大时，从较大结果开始分批，使用同一 Quick thread_id 顺序发送；每批必须收到 ACK。最终请求只保留传输记录索引及未分批的短结果。
3. 逐批传输失败、总量超过 2 MiB 或批次数超过 112 时明确报错，不向 Claude Code 返回虚假的成功内容。
4. Anthropic 流式工具调用按 OpenAI tool_call.index 跟踪参数碎片、块编号及完成状态，防止多次开始或结束同一个工具块。
5. 测试包含 112 个工具定义、31KB 系统提示、并发大结果和短结果、87 条历史消息回归、UTF-8 分批重组、ACK 拒绝与流式参数分片。

## 能力边界

- 上游 ACK 证明消息已收到并经过模型响应，不保证模型能逐字记住任意大文件。实际科研任务仍应使用文件检索、分页读取和精确数字核对，避免要求模型凭记忆重建整篇论文。
- 多批传输带来额外延迟与调用次数。超过传输上限的内容应缩小范围后再读，或采用明确的文档检索。
- Amazon Quick 是非原生的文本工具桥接，工具遵循能力与模型状态有关。源代码和本地运行测试分别提供协议正确性证据与有限的实战验证。
- MIT 许可允许在遵守著作权和许可条件下复用代码。当前借鉴的是接口状态与调度思路；如以后实质复制第三方代码，应保留对应版权和许可证通知。
