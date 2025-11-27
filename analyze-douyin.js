const fs = require('fs');

function extractTcpPayloads(buffer) {
  const connections = [];
  let currentConn = null;
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
            const flags = packetData[tcpHeaderStart + 13];
            
            const srcPort = packetData.readUInt16BE(tcpHeaderStart);
            const dstPort = packetData.readUInt16BE(tcpHeaderStart + 2);
            
            // 检测新连接 (SYN)
            if ((flags & 0x02) && !(flags & 0x10)) {
              if (currentConn) connections.push(currentConn);
              currentConn = { client: [], server: [] };
            }
            
            if (currentConn && (srcPort === 1935 || dstPort === 1935)) {
              const payload = packetData.slice(tcpDataStart);
              if (payload.length > 0) {
                const isClient = dstPort === 1935;
                currentConn[isClient ? 'client' : 'server'].push(payload);
              }
            }
          }
        }
      }
    }
    
    offset += blockLength;
  }
  
  if (currentConn) connections.push(currentConn);
  return connections;
}

function parseConnectCommand(data) {
  // 跳过握手 (3073 bytes)
  let offset = 3073;
  if (offset >= data.length) return null;
  
  // 找到 connect 命令
  // 解析第一个 chunk header
  const firstByte = data[offset];
  const fmt = (firstByte >> 6) & 0x03;
  const csid = firstByte & 0x3f;
  offset++;
  
  if (fmt <= 2) offset += 3; // timestamp
  
  let msgLen = 0, typeId = 0;
  if (fmt <= 1 && offset + 4 <= data.length) {
    msgLen = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    typeId = data[offset + 3];
    offset += 4;
  }
  
  if (fmt === 0) offset += 4; // streamId
  
  if (typeId !== 20) return null; // 不是 CommandAMF0
  
  const msgBody = data.slice(offset, offset + Math.min(msgLen, 1000));
  
  // 解析 AMF0
  let pos = 0;
  const result = {};
  
  // 命令名
  if (msgBody[pos] === 0x02) {
    pos++;
    const strLen = msgBody.readUInt16BE(pos);
    pos += 2;
    result.command = msgBody.slice(pos, pos + strLen).toString('utf8');
    pos += strLen;
  }
  
  // Transaction ID
  if (msgBody[pos] === 0x00) {
    pos++;
    result.transactionId = msgBody.readDoubleBE(pos);
    pos += 8;
  }
  
  // Command Object
  if (msgBody[pos] === 0x03) {
    pos++;
    result.properties = {};
    while (pos < msgBody.length - 3) {
      const keyLen = msgBody.readUInt16BE(pos);
      if (keyLen === 0 && msgBody[pos + 2] === 0x09) break;
      pos += 2;
      const key = msgBody.slice(pos, pos + keyLen).toString('utf8');
      pos += keyLen;
      
      const valueType = msgBody[pos++];
      let value;
      
      if (valueType === 0x02) {
        const valLen = msgBody.readUInt16BE(pos);
        pos += 2;
        value = msgBody.slice(pos, pos + valLen).toString('utf8');
        pos += valLen;
      } else if (valueType === 0x00) {
        value = msgBody.readDoubleBE(pos);
        pos += 8;
      } else if (valueType === 0x01) {
        value = msgBody[pos++] !== 0;
      } else {
        break;
      }
      
      result.properties[key] = value;
    }
  }
  
  return result;
}

function findPublishCommand(data) {
  // 搜索 publish 命令
  const publishStr = Buffer.from([0x02, 0x00, 0x07, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x73, 0x68]); // AMF0 string "publish"
  let idx = data.indexOf(publishStr, 3073);
  if (idx === -1) return null;
  
  // 找到 publish 后面的参数
  let pos = idx + publishStr.length;
  
  // 跳过 transaction ID (number)
  if (data[pos] === 0x00) {
    pos += 9;
  }
  
  // 跳过 command object (null)
  if (data[pos] === 0x05) {
    pos++;
  }
  
  // 读取 stream name
  if (data[pos] === 0x02) {
    pos++;
    const strLen = data.readUInt16BE(pos);
    pos += 2;
    const streamName = data.slice(pos, pos + strLen).toString('utf8');
    pos += strLen;
    
    // 读取 publish type
    let publishType = '';
    if (data[pos] === 0x02) {
      pos++;
      const typeLen = data.readUInt16BE(pos);
      pos += 2;
      publishType = data.slice(pos, pos + typeLen).toString('utf8');
    }
    
    return { streamName, publishType };
  }
  
  return null;
}

// 分析
const buf = fs.readFileSync('/home/chwech/tmp/rtmp-node/aa.pcapng');
const connections = extractTcpPayloads(buf);

console.log(`找到 ${connections.length} 个连接\n`);

connections.forEach((conn, i) => {
  console.log(`=== 连接 ${i + 1} ===`);
  const clientData = Buffer.concat(conn.client);
  console.log(`客户端数据: ${clientData.length} bytes`);
  
  const connectCmd = parseConnectCommand(clientData);
  if (connectCmd) {
    console.log('\nconnect 命令:');
    console.log('  command:', connectCmd.command);
    if (connectCmd.properties) {
      console.log('  app:', connectCmd.properties.app);
      console.log('  tcUrl:', connectCmd.properties.tcUrl);
      console.log('  flashVer:', connectCmd.properties.flashVer);
      console.log('  type:', connectCmd.properties.type);
    }
  }
  
  const publishCmd = findPublishCommand(clientData);
  if (publishCmd) {
    console.log('\npublish 命令:');
    console.log('  streamName:', publishCmd.streamName);
    console.log('  publishType:', publishCmd.publishType);
  }
  
  console.log('\n');
});

