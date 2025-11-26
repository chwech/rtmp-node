# RTMP 推流客户端实现

基于 Wireshark 抓包分析的完整 RTMP 建联和推流流程实现（到第14步：服务器响应 publish）

## 功能特性

实现了完整的 RTMP 推流流程，包括：

1. **TCP 三次握手**（自动处理）
2. **RTMP 握手**（C0+C1, S0+S1+S2, C2）
3. **Set Chunk Size**（4096字节）
4. **connect 命令**
5. **releaseStream 命令**
6. **FCPublish 命令**
7. **createStream 命令**
8. **publish 命令**
9. **接收 onStatus 响应**（NetStream.Publish.Start）

## 文件说明

- `rtmp-publisher.js` - RTMP推流客户端核心实现
- `publish-example.js` - 使用示例
- `README.md` - 本文件

## 使用方法

### 基本使用

```javascript
const RTMPPublisher = require('./rtmp-publisher');

const publisher = new RTMPPublisher();

// 监听推流成功事件
publisher.on('publishStart', (statusInfo) => {
  console.log('推流成功启动！', statusInfo);
});

// 监听错误
publisher.on('error', (error) => {
  console.error('错误:', error);
});

// 连接到RTMP服务器
await publisher.connect('rtmp://server/app/stream-name');
```

### 完整示例

```javascript
const RTMPPublisher = require('./rtmp-publisher');

const publisher = new RTMPPublisher();

publisher.on('publishStart', (statusInfo) => {
  console.log('✅ 推流成功启动！');
  // 这里可以开始发送音视频数据
});

publisher.on('status', (statusInfo) => {
  console.log('状态更新:', statusInfo);
});

publisher.on('error', (error) => {
  console.error('错误:', error);
});

// 抖音推流地址示例
const rtmpUrl = 'rtmp://push-rtmp-t5.douyincdn.com/third/stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=...';

await publisher.connect(rtmpUrl, {
  type: 'nonprivate',
  flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
  publishType: 'live'
});
```

### 运行示例

```bash
node publish-example.js
```

## API 说明

### RTMPPublisher 类

#### 构造函数

```javascript
const publisher = new RTMPPublisher();
```

#### 方法

##### `connect(rtmpUrl, options)`

连接到RTMP服务器并完成推流准备。

**参数：**
- `rtmpUrl` (string) - RTMP推流地址，格式：`rtmp://host:port/app/stream-name?params`
- `options` (object, 可选) - 配置选项
  - `type` (string) - 连接类型，默认：`'nonprivate'`
  - `flashVer` (string) - Flash版本，默认：`'FMLE/3.0 (compatible; FMSc/1.0)'`
  - `publishType` (string) - 发布类型，默认：`'live'`
  - `swfUrl` (string) - SWF URL
  - `connectParams` (object) - 额外的connect参数

**返回：** Promise

##### `close()`

关闭RTMP连接。

#### 事件

##### `publishStart`

当服务器响应 `NetStream.Publish.Start` 时触发。

**参数：** `statusInfo` (object) - 状态信息对象

##### `status`

当收到任何状态更新时触发。

**参数：** `statusInfo` (object) - 状态信息对象

##### `error`

当发生错误时触发。

**参数：** `error` (Error) - 错误对象

##### `close`

当连接关闭时触发。

**参数：** `err` (Error, 可选) - 关闭原因

## 实现细节

### RTMP 流程步骤

1. **TCP 连接**：建立到RTMP服务器（默认端口1935）的TCP连接
2. **RTMP 握手**：
   - 客户端发送 C0+C1
   - 服务器响应 S0+S1+S2
   - 客户端发送 C2
3. **Set Chunk Size**：设置块大小为4096字节
4. **connect 命令**：发送connect命令建立NetConnection
5. **releaseStream**：释放流资源
6. **FCPublish**：通知服务器准备发布流
7. **createStream**：创建流对象，获取Stream ID
8. **publish 命令**：使用Stream ID发送publish命令
9. **onStatus 响应**：接收服务器的 `NetStream.Publish.Start` 响应

### 关键参数

- **Chunk Size**: 4096 字节
- **Stream ID**: 由服务器在 createStream 响应中分配（通常为1）
- **发布类型**: "live"（实时直播模式）

## 注意事项

1. **流名称格式**：抖音推流地址的完整参数必须作为流名称传递，不能拆分
2. **参数完整性**：所有参数（sign、expire、volcSecret等）都必须包含，否则建联会失败
3. **时序要求**：必须按照正确的顺序发送命令，等待服务器响应后再进行下一步
4. **Chunk Size**：设置为4096字节，这是常见的优化值
5. **发布类型**：必须使用"live"模式，不能使用"record"或"append"

## 依赖

- `rtmp-client` - RTMP客户端库
- `amf-codec` - AMF编码/解码库（rtmp-client的依赖）

## 许可证

MIT

