const fs = require('fs');

// 简单的 pcapng 解析器
function parsePcapng(buffer) {
  const packets = [];
  let offset = 0;
  
  while (offset < buffer.length - 8) {
    const blockType = buffer.readUInt32LE(offset);
    const blockLength = buffer.readUInt32LE(offset + 4);
    
    if (blockLength < 12 || blockLength > buffer.length - offset) break;
    
    // Enhanced Packet Block (0x00000006)
    if (blockType === 0x00000006) {
      const capturedLen = buffer.readUInt32LE(offset + 20);
      const packetData = buffer.slice(offset + 28, offset + 28 + capturedLen);
      
      // 检查是否是 TCP 数据包 (以太网 + IP + TCP)
      if (packetData.length > 54) {
        const etherType = packetData.readUInt16BE(12);
        if (etherType === 0x0800) { // IPv4
          const ipHeaderLen = (packetData[14] & 0x0f) * 4;
          const protocol = packetData[23];
          
          if (protocol === 6) { // TCP
            const tcpHeaderStart = 14 + ipHeaderLen;
            const tcpHeaderLen = ((packetData[tcpHeaderStart + 12] >> 4) & 0x0f) * 4;
            const tcpDataStart = tcpHeaderStart + tcpHeaderLen;
            
            const srcPort = packetData.readUInt16BE(tcpHeaderStart);
            const dstPort = packetData.readUInt16BE(tcpHeaderStart + 2);
            
            // RTMP 端口 1935
            if (srcPort === 1935 || dstPort === 1935) {
              const payload = packetData.slice(tcpDataStart);
              if (payload.length > 0) {
                packets.push({
                  direction: dstPort === 1935 ? 'C->S' : 'S->C',
                  length: payload.length,
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
  
  return packets;
}

// 分析 RTMP chunk
function analyzeRtmpChunk(data, offset = 0) {
  if (offset >= data.length) return null;
  
  const firstByte = data[offset];
  const fmt = (firstByte >> 6) & 0x03;
  let csid = firstByte & 0x3f;
  let headerLen = 1;
  
  if (csid === 0) {
    csid = data[offset + 1] + 64;
    headerLen = 2;
  } else if (csid === 1) {
    csid = data[offset + 1] + data[offset + 2] * 256 + 64;
    headerLen = 3;
  }
  
  let timestamp = 0, msgLen = 0, typeId = 0, streamId = 0;
  
  if (fmt <= 2 && offset + headerLen + 3 <= data.length) {
    timestamp = (data[offset + headerLen] << 16) | (data[offset + headerLen + 1] << 8) | data[offset + headerLen + 2];
    headerLen += 3;
  }
  
  if (fmt <= 1 && offset + headerLen + 4 <= data.length) {
    msgLen = (data[offset + headerLen] << 16) | (data[offset + headerLen + 1] << 8) | data[offset + headerLen + 2];
    typeId = data[offset + headerLen + 3];
    headerLen += 4;
  }
  
  if (fmt === 0 && offset + headerLen + 4 <= data.length) {
    streamId = data.readUInt32LE(offset + headerLen);
    headerLen += 4;
  }
  
  return {
    fmt,
    csid,
    timestamp,
    msgLen,
    typeId,
    streamId,
    headerLen,
    typeName: getTypeName(typeId)
  };
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

// 分析文件
function analyzeFile(filename) {
  console.log(`\n=== 分析 ${filename} ===\n`);
  
  const buffer = fs.readFileSync(filename);
  const packets = parsePcapng(buffer);
  
  console.log(`总数据包数: ${packets.length}`);
  
  // 统计消息类型
  const msgTypes = { 'C->S': {}, 'S->C': {} };
  let totalData = { 'C->S': 0, 'S->C': 0 };
  
  for (const pkt of packets) {
    totalData[pkt.direction] += pkt.length;
    
    // 尝试解析 RTMP chunk
    const chunk = analyzeRtmpChunk(pkt.data);
    if (chunk && chunk.typeId > 0) {
      const key = chunk.typeName;
      msgTypes[pkt.direction][key] = (msgTypes[pkt.direction][key] || 0) + 1;
    }
  }
  
  console.log(`\n客户端发送数据量: ${totalData['C->S']} bytes`);
  console.log(`服务器发送数据量: ${totalData['S->C']} bytes`);
  
  console.log('\n客户端发送的消息类型:');
  for (const [type, count] of Object.entries(msgTypes['C->S']).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  
  console.log('\n服务器发送的消息类型:');
  for (const [type, count] of Object.entries(msgTypes['S->C']).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  
  // 显示前几个数据包的详细信息
  console.log('\n前10个数据包:');
  for (let i = 0; i < Math.min(10, packets.length); i++) {
    const pkt = packets[i];
    const chunk = analyzeRtmpChunk(pkt.data);
    if (chunk) {
      console.log(`  ${i+1}. ${pkt.direction} len=${pkt.length} fmt=${chunk.fmt} csid=${chunk.csid} type=${chunk.typeName} ts=${chunk.timestamp}`);
    }
  }
  
  return { packets, msgTypes, totalData };
}

// 分析两个文件
const ffmpegData = analyzeFile('/home/chwech/tmp/rtmp-node/ffmepg.pcapng');
const publishData = analyzeFile('/home/chwech/tmp/rtmp-node/publish-example.pcapng');

// 比较差异
console.log('\n=== 差异分析 ===\n');

const ffmpegTypes = new Set(Object.keys(ffmpegData.msgTypes['C->S']));
const publishTypes = new Set(Object.keys(publishData.msgTypes['C->S']));

console.log('ffmpeg 发送但 publish-example 没有发送的消息类型:');
for (const type of ffmpegTypes) {
  if (!publishTypes.has(type)) {
    console.log(`  - ${type}`);
  }
}

console.log('\npublish-example 发送但 ffmpeg 没有发送的消息类型:');
for (const type of publishTypes) {
  if (!ffmpegTypes.has(type)) {
    console.log(`  - ${type}`);
  }
}

