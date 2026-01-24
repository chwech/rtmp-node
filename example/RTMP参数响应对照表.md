# RTMP 建联和推流 - 发送参数与响应值对照表

## 一、TCP 握手阶段

### 客户端发送 (包1)
```
源地址: 192.168.41.4:22487
目标地址: 125.94.41.96:1935
标志: SYN
窗口大小: 64240
MSS: 1460
```

### 服务器响应 (包2)
```
源地址: 125.94.41.96:1935
目标地址: 192.168.41.4:22487
标志: SYN, ACK
窗口大小: 64240
MSS: 1400
RTT: 12.457 毫秒
```

### 客户端确认 (包3)
```
标志: ACK
```

---

## 二、RTMP 握手阶段

### 客户端发送 C0+C1 (包5)
```
协议: RTMP
类型: Handshake C0+C1
数据长度: 137 字节
内容: 
  - C0: RTMP版本号 (1字节)
  - C1: 时间戳 + 随机数据 (1536字节)
```

### 服务器响应 S0+S1+S2 (包8-10)
```
协议: RTMP
类型: Handshake S0+S1+S2
数据长度: 约3073字节
内容:
  - S0: 服务器RTMP版本 (1字节)
  - S1: 服务器时间戳 + 随机数据 (1536字节)
  - S2: 服务器对C1的响应 (1536字节)
```

### 客户端发送 C2 (包14)
```
协议: RTMP
类型: Handshake C2
数据长度: 136 字节
内容: 客户端对S1的响应
```

---

## 三、RTMP 连接建立

### 客户端发送 Set Chunk Size (包17)
```
RTMP Header:
  Format: 0
  Chunk Stream ID: 2
  Timestamp: 0
  Body size: 4
  Type ID: 0x01 (Set Chunk Size)
  Stream ID: 0

RTMP Body:
  Chunk size: 4096
```

### 客户端发送 connect 命令 (包17)
```
RTMP Header:
  Format: 0
  Chunk Stream ID: 3
  Timestamp: 0
  Body size: 198
  Type ID: 0x14 (AMF0 Command)
  Stream ID: 0

RTMP Body (AMF0):
  命令名: "connect"
  事务ID: 1
  命令对象:
    app: "third"
    type: "nonprivate"
    flashVer: "FMLE/3.0 (compatible; FMSc/1.0)"
    swfUrl: "rtmp://push-rtmp-t5.douyincdn.com/third"
    tcUrl: "rtmp://push-rtmp-t5.douyincdn.com/third"
```

### 服务器响应 connect (包19)
```
数据长度: 251 字节
响应内容:
  - Window Acknowledgement Size
  - Set Peer Bandwidth
  - connect _result (连接结果)
  - onStatus (状态通知)
```

---

## 四、流创建阶段

### 客户端发送 releaseStream (包20)
```
RTMP Header:
  Format: 1 (复用)
  Chunk Stream ID: 3
  Timestamp delta: 0
  Body size: 239
  Type ID: 0x14 (AMF0 Command)

RTMP Body (AMF0):
  命令名: "releaseStream"
  事务ID: 2
  参数1: Null
  流名称: "stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895"
```

### 服务器响应 releaseStream (包21)
```
响应: TCP ACK
说明: 服务器确认收到releaseStream命令
```

### 客户端发送 FCPublish (包22)
```
RTMP Header:
  Format: 1 (复用)
  Chunk Stream ID: 3
  Timestamp delta: 0
  Body size: 235
  Type ID: 0x14 (AMF0 Command)

RTMP Body (AMF0):
  命令名: "FCPublish"
  事务ID: 3
  参数1: Null
  流名称: "stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895"
```

### 客户端发送 createStream (包22，同一包中)
```
RTMP Header:
  Format: 1 (复用)
  Chunk Stream ID: 3
  Timestamp delta: 0
  Body size: 25
  Type ID: 0x14 (AMF0 Command)

RTMP Body (AMF0):
  命令名: "createStream"
  事务ID: 4
  参数1: Null
```

### 服务器响应 createStream (包24)
```
数据长度: 41 字节
响应内容:
  - createStream _result
  - 流ID: 1 (返回给客户端)
```

---

## 五、发布流阶段

### 客户端发送 publish 命令 (包25)
```
RTMP Header:
  Format: 0
  Chunk Stream ID: 4
  Timestamp: 0
  Body size: 240
  Type ID: 0x14 (AMF0 Command)
  Stream ID: 1 (使用服务器返回的流ID)

RTMP Body (AMF0):
  命令名: "publish"
  事务ID: 5
  参数1: Null
  流名称: "stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895"
  发布类型: "live"
```

### 服务器响应 publish (包26)
```
数据长度: 137 字节
响应内容:
  - onStatus
  - 状态码: "NetStream.Publish.Start"
  - 说明: 发布成功，可以开始发送数据
```

---

## 六、发送媒体数据阶段

### 客户端发送 onMetaData (包27)
```
RTMP Header:
  Format: 0
  Chunk Stream ID: 4
  Timestamp: 0
  Body size: 1124
  Type ID: 0x12 (AMF0 Data)
  Stream ID: 1

RTMP Body:
  命令名: "@setDataFrame"
  方法: "onMetaData"
  元数据对象:
    - 视频编码信息
    - 音频编码信息
    - 分辨率
    - 帧率
    - 比特率等
```

### 客户端发送音视频数据 (包29+)
```
音频数据:
  RTMP Header:
    Format: 1 (复用)
    Chunk Stream ID: 4
    Type ID: 0x08 (Audio Data)
    Stream ID: 1
  数据长度: 70 字节

视频数据:
  RTMP Header:
    Format: 1 (复用)
    Chunk Stream ID: 4
    Type ID: 0x09 (Video Data)
    Stream ID: 1
  数据长度: 1454 字节 (第一个视频包)
```

---

## 七、关键参数汇总

### 连接参数
```
服务器地址: 125.94.41.96:1935
应用名称: "third"
Chunk Size: 4096 字节
Stream ID: 1
发布类型: "live"
```

### 抖音推流流名称完整参数
```
stream-694838780041364282?arch_hrchy=c1&expire=1764574895&sign=03202ddf0b0dcae5a3dff7899dc0df89&t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq&volcSecret=03202ddf0b0dcae5a3dff7899dc0df89&volcTime=1764574895
```

**参数解析**:
- `stream-694838780041364282`: 流ID
- `arch_hrchy=c1`: 架构层级
- `expire=1764574895`: 过期时间戳 (Unix时间戳)
- `sign=03202ddf0b0dcae5a3dff7899dc0df89`: 签名 (32位十六进制)
- `t_id=037-20251124154135C2CE6DB2632764B58307-TACXqq`: 事务ID
- `volcSecret=03202ddf0b0dcae5a3dff7899dc0df89`: 火山引擎密钥
- `volcTime=1764574895`: 火山引擎时间戳

### 客户端信息
```
Flash版本: "FMLE/3.0 (compatible; FMSc/1.0)"
SWF URL: "rtmp://push-rtmp-t5.douyincdn.com/third"
TC URL: "rtmp://push-rtmp-t5.douyincdn.com/third"
连接类型: "nonprivate"
```

---

## 八、命令序列总结

### 客户端发送的命令序列
1. **Set Chunk Size** (事务ID: N/A, Chunk Stream ID: 2)
2. **connect** (事务ID: 1, Chunk Stream ID: 3)
3. **releaseStream** (事务ID: 2, Chunk Stream ID: 3)
4. **FCPublish** (事务ID: 3, Chunk Stream ID: 3)
5. **createStream** (事务ID: 4, Chunk Stream ID: 3)
6. **publish** (事务ID: 5, Chunk Stream ID: 4, Stream ID: 1)
7. **onMetaData** (Chunk Stream ID: 4, Stream ID: 1)
8. **音视频数据** (持续发送, Chunk Stream ID: 4, Stream ID: 1)

### 服务器响应的命令序列
1. **Window Acknowledgement Size** (响应connect)
2. **Set Peer Bandwidth** (响应connect)
3. **connect _result** (响应connect, 事务ID: 1)
4. **onStatus** (连接状态通知)
5. **createStream _result** (响应createStream, 事务ID: 4, 返回Stream ID: 1)
6. **onStatus** (响应publish, 状态: NetStream.Publish.Start)

---

## 九、重要发现

1. **流名称必须包含完整参数**: 抖音推流地址的所有参数都作为流名称的一部分，不能拆分
2. **事务ID递增**: 每个命令的事务ID从1开始递增
3. **Chunk Stream ID复用**: 多个命令可以复用同一个Chunk Stream ID (如3)
4. **Stream ID分配**: 服务器在createStream响应中分配Stream ID，后续命令必须使用该ID
5. **发布类型固定**: 必须使用"live"模式
6. **AMF0编码**: 所有命令和响应都使用AMF0格式编码

---

## 十、实现建议

1. **严格按照顺序执行**: 必须等待服务器响应后再发送下一个命令
2. **保存Stream ID**: 服务器返回的Stream ID必须保存并在后续命令中使用
3. **参数完整性**: 流名称中的所有参数都必须包含，否则建联会失败
4. **Chunk Size**: 建议设置为4096字节
5. **错误处理**: 需要处理服务器返回的错误响应

