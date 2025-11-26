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
            
            if (dstPort === 1935) {
              const payload = packetData.slice(tcpDataStart);
              if (payload.length > 0) {
                payloads.push(payload);
              }
            }
          }
        }
      }
    }
    
    offset += blockLength;
  }
  
  return Buffer.concat(payloads);
}

function analyzeConnect(data, name) {
  console.log(`\n=== ${name} connect 命令分析 ===`);
  
  // 跳过握手 (3073 bytes)
  let offset = 3073;
  
  // 解析第一个 chunk header
  const firstByte = data[offset];
  const fmt = (firstByte >> 6) & 0x03;
  const csid = firstByte & 0x3f;
  offset++;
  
  const timestamp = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
  offset += 3;
  
  const msgLen = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
  const typeId = data[offset + 3];
  offset += 4;
  
  const streamId = data.readUInt32LE(offset);
  offset += 4;
  
  console.log(`Chunk: fmt=${fmt}, csid=${csid}, ts=${timestamp}, len=${msgLen}, type=${typeId}, streamId=${streamId}`);
  
  // 提取消息体
  const msgBody = data.slice(offset, offset + Math.min(msgLen, 500));
  console.log(`消息体前200字节 (hex):`, msgBody.slice(0, 200).toString('hex'));
  
  // 尝试解析 AMF0
  let pos = 0;
  
  // 命令名
  if (msgBody[pos] === 0x02) { // AMF0 String
    pos++;
    const strLen = msgBody.readUInt16BE(pos);
    pos += 2;
    const cmdName = msgBody.slice(pos, pos + strLen).toString('utf8');
    pos += strLen;
    console.log(`命令名: ${cmdName}`);
  }
  
  // Transaction ID
  if (msgBody[pos] === 0x00) { // AMF0 Number
    pos++;
    const txId = msgBody.readDoubleBE(pos);
    pos += 8;
    console.log(`Transaction ID: ${txId}`);
  }
  
  // Command Object
  if (msgBody[pos] === 0x03) { // AMF0 Object
    pos++;
    console.log('Command Object:');
    while (pos < msgBody.length - 3) {
      // 读取属性名
      const keyLen = msgBody.readUInt16BE(pos);
      if (keyLen === 0) {
        if (msgBody[pos + 2] === 0x09) { // Object end
          break;
        }
      }
      pos += 2;
      const key = msgBody.slice(pos, pos + keyLen).toString('utf8');
      pos += keyLen;
      
      // 读取属性值
      const valueType = msgBody[pos++];
      let value;
      
      if (valueType === 0x02) { // String
        const valLen = msgBody.readUInt16BE(pos);
        pos += 2;
        value = msgBody.slice(pos, pos + valLen).toString('utf8');
        pos += valLen;
      } else if (valueType === 0x00) { // Number
        value = msgBody.readDoubleBE(pos);
        pos += 8;
      } else if (valueType === 0x01) { // Boolean
        value = msgBody[pos++] !== 0;
      } else {
        value = `<type ${valueType}>`;
        break;
      }
      
      console.log(`  ${key}: ${value}`);
    }
  }
}

const ffmpegBuf = fs.readFileSync('/home/chwech/tmp/rtmp-node/ffmepg.pcapng');
const publishBuf = fs.readFileSync('/home/chwech/tmp/rtmp-node/publish-example.pcapng');

const ffmpegData = extractTcpPayloads(ffmpegBuf);
const publishData = extractTcpPayloads(publishBuf);

analyzeConnect(ffmpegData, 'ffmpeg');
analyzeConnect(publishData, 'publish-example');

