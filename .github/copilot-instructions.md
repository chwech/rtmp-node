## 项目快速上手（给 AI 代码助手）

本仓库实现了一个基于 `rtmp-client` 的 RTMP 推流客户端与若干示例脚本。下面的说明面向需要马上开始修改、调试和扩展此代码库的 AI 助手。

- **主要用途**: 实现并演示 RTMP 建联与推流（包含握手、setChunkSize、connect、createStream、publish 等流程）。关键实现分散在 `rtmp-publisher.js`（核心），示例在 `publish-*.js`。
- **关键示例**: `publish-example.js`（简单示例入口），`publish-aac.js`（MP3->AAC 转换并推流示例），`index.js`（调试/实验用例）。
- **重要目录/文件**:
  - `rtmp-publisher.js` — 推流逻辑与事件（`publishStart`、`status`、`error` 等）
  - `publish-aac.js` — 使用 `ffmpeg` 将 MP3 转为 ADTS AAC，然后通过 `AACReader` 与 `RTMPPublisher` 推流（展示本项目常用运行方式）
  - `aac-reader.js`, `mp4-reader.js` — 媒体读取器实现，发出 `audioSequenceHeader`、`audioFrame`、`fileChange` 等事件
  - `package.json` — 依赖声明；注意 `pnpm` 下有 patches：`patches/rtmp-client@1.6.3.patch`
  - `music/` — 放示例音频文件供 `publish-aac.js` 使用

- **运行与调试（必读）**:
  - 本地运行示例：`node publish-example.js` 或 `node publish-aac.js`。
  - `publish-aac.js` 需要 `ffmpeg` 在 PATH 中（脚本通过 `child_process.exec('ffmpeg ...')` 做 mp3->aac 转换）。
  - 如果修改 `rtmp-client` 行为，注意仓库使用了 `patches/rtmp-client@1.6.3.patch`，升级时需更新或重做补丁。

- **代码风格与约定（可直接依赖的模式）**:
  - 事件驱动：Publisher 与 Reader 使用事件回调（`on('publishStart', ...)` / `on('audioFrame', ...)`），AI 修改功能时请优先通过事件接口集成，不直接暴力修改内部状态。
  - CLI/示例脚本：以 `publish-*.js` 为可执行示例，编辑示例以快速验证运行结果；`package.json` 的 `main` 指向 `publish-example.js`。
  - 异步与错误处理：多数核心方法返回 Promise（例如 `publisher.connect(...)`），示例通过 try/catch + process.exit 管理失败路径。

- **集成点与外部依赖**:
  - 运行时依赖：`amf-codec`, `rtmp-client`（通过 `pnpm` 管理），本地需安装 `ffmpeg` 用于音频转码。
  - 网络交互：RTMP 地址通常带大量 query 参数（sign/expire/volcSecret 等），请不要拆分或丢弃这些参数（见 README 中的注意事项）。

- **对 AI 助手的具体建议（避免常见错误）**:
  - 不要在未理解 RTMP 时序的情况下随意重排序关键命令（connect -> releaseStream -> FCPublish -> createStream -> publish）。
  - 若需改动第三方库行为，先查看 `patches/` 并保留补丁流程（`pnpm` 的 patchedDependencies 已启用）。
  - 对于新增命令行选项或配置，优先在示例脚本中加入并保持 backward-compatible（不要破坏默认 `publish-example.js` 行为）。

- **快速示例片段（如何发送音频帧）**:
  - 发送序列头：在收到 `audioSequenceHeader` 事件后调用 `publisher.sendAudioSequenceHeader(header, config)`。
  - 发送帧：在 `audioFrame` 事件中使用 `publisher.sendAudioFrame(frame.header, frame.data, frame.timestamp)`，注意跳过未 publish 的情况。

如需我把文档再细化为“代码修改规范”或“PR 检查清单”，告诉我想覆盖的区域（例如：patches 管理、单元/集成测试、或 CI 运行示例）。

*** 请审阅此指南，有不清楚或希望补充的部分请指出。***
