const fs = require('fs');

function extractTcpPayloads(buffer) {
  const payloads = [];
  let offset = 0;
  
  while (offset < buffer.length - 8) {
    const blockType = buffer.readUInt32LE(offset);
    const blockLength = buffer.readUInt32LE(offset + 4);
    
    if (blockLength < 12 || blockLength > buffer.length - offset) break;
    
    if (blockType === 0x00000006) {
      const capturedLen = buffer.readUInt32LE(offset + 20);
      const packetData = buffer.slice(offset + 28, offset + 28 + capturedLen);
      
      if (packetData.length > 54) {
        const etherType = packetData.readUInt16BE(12);
        if (etherType === 0x0800) {
          const ipHeaderLen = (packetData[14] & 0x0f) * 4;
          const protocol = packetData[23];
          
          if (protocol === 6) {
            const tcpHeaderStart = 14 + ipHeaderLen;
            const tcpHeaderLen = ((packetData[tcpHeaderStart + 12] >> 4) & 0x0f) * 4;
            const tcpDataStart = tcpHeaderStart + tcpHeaderLen;
            
            const srcPort = packetData.readUInt16BE(tcpHeaderStart);
            const dstPort = packetData.readUInt16BE(tcpHeaderStart + 2);
            
            if (srcPort === 1935 || dstPort === 1935) {
              const payload = packetData.slice(tcpDataStart);
              if (payload.length > 0) {
                payloads.push({
                  isClient: dstPort === 1935,
                  data: payload
                });
              }
            }
          }
        }
      }
    }
    
    offset += blockLength;
  }
  
  return payloads;
}

function getTypeName(typeId) {
  const types = {
    1: 'SetChunkSize',
    2: 'Abort',
    3: 'Ack',
    4: 'UserControl',
    5: 'WindowAckSize',
    6: 'SetPeerBandwidth',
    8: 'Audio',
    9: 'Video',
    15: 'DataAMF3',
    16: 'SharedObjAMF3',
    17: 'CommandAMF3',
    18: 'DataAMF0',
    19: 'SharedObjAMF0',
    20: 'CommandAMF0',
    22: 'Aggregate'
  };
  return types[typeId] || `Unknown(${typeId})`;
}

// 解析 RTMP 消息流
function parseRtmpMessages(payloads, name) {
  console.log(`\n=== ${name} RTMP 消息分析 ===`);
  
  const clientData = Buffer.concat(payloads.filter(p => p.isClient).map(p => p.data));
  const serverData = Buffer.concat(payloads.filter(p => !p.isClient).map(p => p.data));
  
  console.log(`客户端数据: ${clientData.length} bytes`);
  console.log(`服务器数据: ${serverData.length} bytes`);
  
  // 跳过握手
  let clientOffset = 3073;
  
  const messages = [];
  let chunkSize = 128;
  const lastMessage = new Map(); // csid -> {timestamp, msgLen, typeId, streamId, remaining, body}
  
  let count = 0;
  while (clientOffset < clientData.length && count < 100) {
    const startOffset = clientOffset;
    const firstByte = clientData[clientOffset];
    const fmt = (firstByte >> 6) & 0x03;
    let csid = firstByte & 0x3f;
    clientOffset++;
    
    if (csid === 0 && clientOffset < clientData.length) {
      csid = clientData[clientOffset] + 64;
      clientOffset++;
    } else if (csid === 1 && clientOffset + 1 < clientData.length) {
      csid = clientData[clientOffset] + clientData[clientOffset + 1] * 256 + 64;
      clientOffset += 2;
    }
    
    let timestamp = 0, msgLen = 0, typeId = 0, streamId = 0;
    
    // 获取上一个消息的信息
    const prev = lastMessage.get(csid) || {};
    
    if (fmt <= 2 && clientOffset + 3 <= clientData.length) {
      timestamp = (clientData[clientOffset] << 16) | (clientData[clientOffset + 1] << 8) | clientData[clientOffset + 2];
      clientOffset += 3;
    } else {
      timestamp = prev.timestamp || 0;
    }
    
    if (fmt <= 1 && clientOffset + 4 <= clientData.length) {
      msgLen = (clientData[clientOffset] << 16) | (clientData[clientOffset + 1] << 8) | clientData[clientOffset + 2];
      typeId = clientData[clientOffset + 3];
      clientOffset += 4;
    } else {
      msgLen = prev.msgLen || 0;
      typeId = prev.typeId || 0;
    }
    
    if (fmt === 0 && clientOffset + 4 <= clientData.length) {
      streamId = clientData.readUInt32LE(clientOffset);
      clientOffset += 4;
    } else {
      streamId = prev.streamId || 0;
    }
    
    // 扩展时间戳
    if (timestamp === 0xFFFFFF && clientOffset + 4 <= clientData.length) {
      timestamp = clientData.readUInt32BE(clientOffset);
      clientOffset += 4;
    }
    
    // 计算 chunk 数据长度
    const remaining = prev.remaining || msgLen;
    const dataLen = Math.min(chunkSize, remaining);
    
    // 读取数据
    const chunkData = clientData.slice(clientOffset, clientOffset + dataLen);
    clientOffset += dataLen;
    
    // 更新状态
    lastMessage.set(csid, {
      timestamp,
      msgLen,
      typeId,
      streamId,
      remaining: remaining - dataLen
    });
    
    // 如果是 SetChunkSize，更新 chunk size
    if (typeId === 1 && chunkData.length >= 4) {
      chunkSize = chunkData.readUInt32BE(0);
    }
    
    // 只记录第一个 chunk (fmt=0 或 remaining === msgLen)
    if (fmt === 0 || remaining === msgLen) {
      messages.push({
        fmt,
        csid,
        timestamp,
        msgLen,
        typeId,
        streamId,
        typeName: getTypeName(typeId),
        dataPreview: chunkData.slice(0, 50).toString('hex')
      });
    }
    
    count++;
  }
  
  console.log(`\n前 ${messages.length} 个消息:`);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    console.log(`  ${i+1}. csid=${m.csid} ts=${m.timestamp} len=${m.msgLen} type=${m.typeName} sid=${m.streamId}`);
    if (m.typeName === 'CommandAMF0' || m.typeName === 'DataAMF0') {
      // 尝试解析命令名
      const data = Buffer.from(m.dataPreview, 'hex');
      if (data[0] === 0x02) {
        const strLen = data.readUInt16BE(1);
        if (strLen < data.length - 3) {
          const cmdName = data.slice(3, 3 + strLen).toString('utf8');
          console.log(`     命令: ${cmdName}`);
        }
      }
    }
  }
  
  return messages;
}

const ffmpegBuf = fs.readFileSync('/home/chwech/tmp/rtmp-node/ffmepg.pcapng');
const publishBuf = fs.readFileSync('/home/chwech/tmp/rtmp-node/publish-example.pcapng');

const ffmpegPayloads = extractTcpPayloads(ffmpegBuf);
const publishPayloads = extractTcpPayloads(publishBuf);

const ffmpegMsgs = parseRtmpMessages(ffmpegPayloads, 'ffmpeg');
const publishMsgs = parseRtmpMessages(publishPayloads, 'publish-example');

// 比较消息类型顺序
console.log('\n=== 消息类型顺序对比 ===');
console.log('ffmpeg:');
console.log('  ' + ffmpegMsgs.slice(0, 20).map(m => m.typeName).join(' -> '));
console.log('\npublish-example:');
console.log('  ' + publishMsgs.slice(0, 20).map(m => m.typeName).join(' -> '));

