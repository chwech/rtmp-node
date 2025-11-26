const fs = require('fs');

// 解析 pcapng 并提取 TCP payload
function extractTcpPayloads(buffer) {
  const streams = { client: [], server: [] };
  let offset = 0;
  
  while (offset < buffer.length - 8) {
    const blockType = buffer.readUInt32LE(offset);
    const blockLength = buffer.readUInt32LE(offset + 4);
    
    if (blockLength < 12 || blockLength > buffer.length - offset) break;
    
    if (blockType === 0x00000006) { // Enhanced Packet Block
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
                const isClient = dstPort === 1935;
                streams[isClient ? 'client' : 'server'].push(payload);
              }
            }
          }
        }
      }
    }
    
    offset += blockLength;
  }
  
  return {
    client: Buffer.concat(streams.client),
    server: Buffer.concat(streams.server)
  };
}

// 分析 RTMP 流
function analyzeRtmpStream(data, name) {
  console.log(`\n=== ${name} 客户端发送数据分析 ===`);
  console.log(`总长度: ${data.length} bytes`);
  
  // 跳过握手 (C0 + C1 + C2 = 1 + 1536 + 1536 = 3073 bytes)
  let offset = 3073;
  
  if (offset >= data.length) {
    console.log('数据不足，无法分析');
    return;
  }
  
  console.log(`\n握手后数据开始于 offset ${offset}`);
  console.log(`前100字节 (hex):`, data.slice(offset, offset + 100).toString('hex'));
  
  // 分析 RTMP chunks
  const chunks = [];
  let chunkSize = 128;
  const chunkSizes = new Map(); // csid -> size
  
  let count = 0;
  while (offset < data.length && count < 50) {
    const startOffset = offset;
    const firstByte = data[offset];
    const fmt = (firstByte >> 6) & 0x03;
    let csid = firstByte & 0x3f;
    offset++;
    
    if (csid === 0 && offset < data.length) {
      csid = data[offset] + 64;
      offset++;
    } else if (csid === 1 && offset + 1 < data.length) {
      csid = data[offset] + data[offset + 1] * 256 + 64;
      offset += 2;
    }
    
    let timestamp = 0, msgLen = 0, typeId = 0, streamId = 0;
    
    if (fmt <= 2 && offset + 3 <= data.length) {
      timestamp = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      offset += 3;
    }
    
    if (fmt <= 1 && offset + 4 <= data.length) {
      msgLen = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      typeId = data[offset + 3];
      offset += 4;
    }
    
    if (fmt === 0 && offset + 4 <= data.length) {
      streamId = data.readUInt32LE(offset);
      offset += 4;
    }
    
    // 扩展时间戳
    if (timestamp === 0xFFFFFF && offset + 4 <= data.length) {
      timestamp = data.readUInt32BE(offset);
      offset += 4;
    }
    
    const headerLen = offset - startOffset;
    
    // 计算这个 chunk 的数据长度
    let dataLen = Math.min(chunkSize, msgLen || chunkSize);
    if (fmt === 3) {
      dataLen = chunkSize;
    }
    
    const chunk = {
      offset: startOffset,
      fmt,
      csid,
      timestamp,
      msgLen,
      typeId,
      streamId,
      headerLen,
      dataLen
    };
    
    chunks.push(chunk);
    
    // 如果是 SetChunkSize，更新 chunk size
    if (typeId === 1 && offset + 4 <= data.length) {
      chunkSize = data.readUInt32BE(offset);
      console.log(`*** SetChunkSize = ${chunkSize} ***`);
    }
    
    offset += dataLen;
    count++;
  }
  
  console.log(`\n前 ${chunks.length} 个 chunks:`);
  for (const c of chunks) {
    const typeName = getTypeName(c.typeId);
    console.log(`  offset=${c.offset} fmt=${c.fmt} csid=${c.csid} ts=${c.timestamp} len=${c.msgLen} type=${typeName}`);
  }
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

// 分析
const ffmpegBuf = fs.readFileSync('/home/chwech/tmp/rtmp-node/ffmepg.pcapng');
const publishBuf = fs.readFileSync('/home/chwech/tmp/rtmp-node/publish-example.pcapng');

const ffmpegData = extractTcpPayloads(ffmpegBuf);
const publishData = extractTcpPayloads(publishBuf);

console.log('=== ffmpeg ===');
console.log(`客户端数据: ${ffmpegData.client.length} bytes`);
console.log(`服务器数据: ${ffmpegData.server.length} bytes`);

console.log('\n=== publish-example ===');
console.log(`客户端数据: ${publishData.client.length} bytes`);
console.log(`服务器数据: ${publishData.server.length} bytes`);

analyzeRtmpStream(ffmpegData.client, 'ffmpeg');
analyzeRtmpStream(publishData.client, 'publish-example');

