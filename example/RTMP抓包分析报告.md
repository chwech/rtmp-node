# RTMP 建联和推流过程详细分析报告

基于 Wireshark 抓包文件 BB.txt 的完整分析

## 一、TCP 三次握手阶段

### 步骤 1: 客户端发送 SYN
- **包序号**: 1
- **时间**: 0.000000 秒
- **源地址**: 192.168.41.4:22487
- **目标地址**: 125.94.41.96:1935
- **协议**: TCP
- **标志**: SYN
- **窗口大小**: 64240
- **MSS**: 1460
- **说明**: 客户端发起TCP连接，请求建立到RTMP服务器(端口1935)的连接

### 步骤 2: 服务器响应 SYN-ACK
- **包序号**: 2
- **时间**: 0.012457 秒
- **源地址**: 125.94.41.96:1935
- **目标地址**: 192.168.41.4:22487
- **协议**: TCP
- **标志**: SYN, ACK
- **窗口大小**: 64240
- **MSS**: 1400
- **RTT**: 12.457 毫秒
- **说明**: 服务器确认连接请求

### 步骤 3: 客户端发送 ACK
- **包序号**: 3
- **时间**: 0.012530 秒
- **源地址**: 192.168.41.4:22487
- **目标地址**: 125.94.41.96:1935
- **协议**: TCP
- **标志**: ACK
- **说明**: TCP连接建立完成

---

## 二、RTMP 握手阶段

### 步骤 4: 客户端发送 C0+C1 (Handshake)
- **包序号**: 5
- **时间**: 0.012703 秒
- **协议**: RTMP
- **信息**: Handshake C0+C1
- **数据长度**: 137 字节
- **说明**: 
  - C0: 1字节，RTMP版本号(通常为0x03)
  - C1: 1536字节，包含时间戳和随机数据
  - 这是RTMP握手的第一个数据包

### 步骤 5: 服务器响应 S0+S1+S2
- **包序号**: 8, 9, 10
- **时间**: 0.025894 秒开始
- **协议**: RTMP
- **信息**: Handshake S0+S1+S2
- **数据长度**: 约3073字节 (分多个TCP包传输)
- **说明**:
  - S0: 1字节，服务器RTMP版本
  - S1: 1536字节，服务器时间戳和随机数据
  - S2: 1536字节，服务器对C1的响应

### 步骤 6: 客户端发送 C2
- **包序号**: 14
- **时间**: 0.026279 秒
- **协议**: RTMP
- **信息**: Handshake C2
- **数据长度**: 136 字节
- **说明**: 客户端对S1的响应，RTMP握手完成

---

## 三、RTMP 连接建立阶段

### 步骤 7: 客户端设置 Chunk Size
- **包序号**: 17
- **时间**: 0.038395 秒
- **协议**: RTMP
- **信息**: Set Chunk Size 4096
- **RTMP Header**:
  - Format: 0
  - Chunk Stream ID: 2
  - Timestamp: 0
  - Body size: 4
  - Type ID: Set Chunk Size (0x01)
  - Stream ID: 0
- **RTMP Body**:
  - Chunk size: **4096** 字节
- **说明**: 设置RTMP块大小为4096字节，用于后续数据传输

### 步骤 8: 客户端发送 connect 命令
- **包序号**: 17 (同一包中)
- **时间**: 0.038395 秒
- **协议**: RTMP
- **信息**: connect('third')
- **RTMP Header**:
  - Format: 0
  - Chunk Stream ID: 3
  - Timestamp: 0
  - Body size: 198
  - Type ID: AMF0 Command (0x14)
  - Stream ID: 0
- **RTMP Body (AMF0格式)**:
  - 命令名: **"connect"**
  - 事务ID: **1**
  - 命令对象包含以下属性:
    - **app**: "third"
    - **type**: "nonprivate"
    - **flashVer**: "FMLE/3.0 (compatible; FMSc/1.0)"
    - **swfUrl**: "rtmp://push-rtmp-t5.douyincdn.com/third"
    - **tcUrl**: "rtmp://push-rtmp-t5.douyincdn.com/third"

### 步骤 9: 服务器响应 connect
- **包序号**: 19
- **时间**: 0.050128 秒
- **协议**: RTMP
- **信息**: 服务器响应connect命令
- **数据长度**: 251 字节
- **说明**: 服务器返回connect结果，包含:
  - Window Acknowledgement Size
  - Set Peer Bandwidth
  - connect _result (连接结果)
  - onStatus (状态通知)

---

## 四、流创建和发布准备阶段

### 步骤 10: 客户端发送 releaseStream
- **包序号**: 20
- **时间**: 0.050713 秒
- **协议**: RTMP
- **信息**: releaseStream
- **RTMP Header**:
  - Format: 1 (复用)
  - Chunk Stream ID: 3
  - Timestamp delta: 0
  - Body size: 239
  - Type ID: AMF0 Command (0x14)
- **RTMP Body**:
  - 命令名: **"releaseStream"**
  - 事务ID: **2**
  - 参数: Null
  - 流名称: **"stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895"**
- **说明**: 释放流资源，流名称包含抖音推流地址的完整参数

### 步骤 11: 客户端发送 FCPublish 和 createStream
- **包序号**: 22
- **时间**: 0.061775 秒
- **协议**: RTMP
- **信息**: FCPublish + createStream
- **第一个命令 - FCPublish**:
  - 命令名: **"FCPublish"**
  - 事务ID: **3**
  - 参数: Null
  - 流名称: **"stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895"**
- **第二个命令 - createStream**:
  - 命令名: **"createStream"**
  - 事务ID: **4**
  - 参数: Null
- **说明**: 
  - FCPublish: 通知服务器准备发布流
  - createStream: 创建流对象，服务器会返回流ID

### 步骤 12: 服务器响应 createStream
- **包序号**: 24
- **时间**: 0.073485 秒
- **协议**: RTMP
- **信息**: createStream _result
- **数据长度**: 41 字节
- **说明**: 服务器返回流ID，通常为1

---

## 五、发布流阶段

### 步骤 13: 客户端发送 publish 命令
- **包序号**: 25
- **时间**: 0.073757 秒
- **协议**: RTMP
- **信息**: publish
- **RTMP Header**:
  - Format: 0
  - Chunk Stream ID: 4
  - Timestamp: 0
  - Body size: 240
  - Type ID: AMF0 Command (0x14)
  - **Stream ID: 1** (使用步骤12返回的流ID)
- **RTMP Body**:
  - 命令名: **"publish"**
  - 事务ID: **5**
  - 参数: Null
  - 流名称: **"stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895"**
  - 发布类型: **"live"**
- **说明**: 开始发布流，流名称包含完整的抖音推流参数

### 步骤 14: 服务器响应 publish
- **包序号**: 26
- **时间**: 0.086415 秒
- **协议**: RTMP
- **信息**: onStatus (NetStream.Publish.Start)
- **数据长度**: 137 字节
- **说明**: 服务器确认发布开始，状态为"NetStream.Publish.Start"

---

## 六、发送媒体数据阶段

### 步骤 15: 客户端发送 onMetaData
- **包序号**: 27
- **时间**: 0.092619 秒
- **协议**: RTMP
- **信息**: onMetaData()
- **数据长度**: 1124 字节
- **说明**: 发送流元数据，包含视频/音频编码信息、分辨率、帧率等

### 步骤 16: 客户端开始发送音视频数据
- **包序号**: 29+
- **时间**: 0.395485 秒开始
- **协议**: RTMP
- **信息**: 
  - Audio Data (音频数据)
  - Video Data (视频数据)
- **说明**: 开始持续发送音视频数据包

---

## 七、关键参数总结

### 抖音推流地址参数解析
从抓包中提取的完整流名称:
```
stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895
```

**参数说明**:
- **stream-694838780041364282**: 流ID
- **arch_hrchy=c1**: 架构层级
- **expire=1764574895**: 过期时间戳
- **sign=03202ddf0b0dcae5a3dff7899dc0df89**: 签名
- **t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq**: 事务ID
- **volcSecret=03202ddf0b0dcae5a3dff7899dc0df89**: 火山引擎密钥
- **volcTime=1764574895**: 火山引擎时间戳

### RTMP 连接参数
- **服务器地址**: 125.94.41.96:1935
- **应用名称**: "third"
- **Chunk Size**: 4096 字节
- **Stream ID**: 1
- **发布类型**: "live"

### 客户端信息
- **Flash版本**: "FMLE/3.0 (compatible; FMSc/1.0)"
- **SWF URL**: "rtmp://push-rtmp-t5.douyincdn.com/third"
- **TC URL**: "rtmp://push-rtmp-t5.douyincdn.com/third"
- **连接类型**: "nonprivate"

---

## 八、时序总结

| 步骤 | 时间(秒) | 操作 | 方向 |
|------|---------|------|------|
| 1 | 0.000000 | TCP SYN | 客户端→服务器 |
| 2 | 0.012457 | TCP SYN-ACK | 服务器→客户端 |
| 3 | 0.012530 | TCP ACK | 客户端→服务器 |
| 4 | 0.012703 | RTMP C0+C1 | 客户端→服务器 |
| 5 | 0.025894 | RTMP S0+S1+S2 | 服务器→客户端 |
| 6 | 0.026279 | RTMP C2 | 客户端→服务器 |
| 7 | 0.038395 | Set Chunk Size + connect | 客户端→服务器 |
| 8 | 0.050128 | connect _result | 服务器→客户端 |
| 9 | 0.050713 | releaseStream | 客户端→服务器 |
| 10 | 0.061775 | FCPublish + createStream | 客户端→服务器 |
| 11 | 0.073485 | createStream _result | 服务器→客户端 |
| 12 | 0.073757 | publish | 客户端→服务器 |
| 13 | 0.086415 | onStatus (Publish.Start) | 服务器→客户端 |
| 14 | 0.092619 | onMetaData | 客户端→服务器 |
| 15 | 0.395485 | 音视频数据 | 客户端→服务器 |

**总建联时间**: 约 86.4 毫秒 (从TCP握手到发布成功)

---

## 九、重要发现

1. **完整的RTMP握手流程**: 包含C0+C1、S0+S1+S2、C2三个阶段
2. **Chunk Size设置**: 客户端主动设置4096字节的块大小
3. **流名称包含完整参数**: 抖音推流地址的所有参数都作为流名称的一部分传递
4. **发布类型**: 使用"live"模式，适合实时直播
5. **AMF0编码**: 所有命令使用AMF0格式编码
6. **Stream ID分配**: 服务器在createStream响应中分配Stream ID为1

---

## 十、注意事项

1. **流名称格式**: 抖音推流地址的完整参数必须作为流名称传递，不能拆分
2. **参数完整性**: 所有参数(sign、expire、volcSecret等)都必须包含，否则建联会失败
3. **时序要求**: 必须按照正确的顺序发送命令，等待服务器响应后再进行下一步
4. **Chunk Size**: 建议设置为4096字节，这是常见的优化值
5. **发布类型**: 必须使用"live"模式，不能使用"record"或"append"

