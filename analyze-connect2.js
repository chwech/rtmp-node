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
            
            if ((flags & 0x02) && !(flags & 0x10)) {
              if (currentConn) connections.push(currentConn);
              currentConn = { client: [], server: [] };
            }
            
            if (currentConn && (srcPort === 1935 || dstPort === 1935)) {
              const payload = packetData.slice(tcpDataStart);
              if (payload.length > 0) {
                currentConn[dstPort === 1935 ? 'client' : 'server'].push(payload);
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

function parseAMFObject(data, pos) {
  const obj = {};
  while (pos < data.length - 3) {
    const keyLen = data.readUInt16BE(pos);
    if (keyLen === 0 && data[pos + 2] === 0x09) break;
    pos += 2;
    const key = data.slice(pos, pos + keyLen).toString('utf8');
    pos += keyLen;
    
    const valueType = data[pos++];
    let value;
    
    if (valueType === 0x02) {
      const valLen = data.readUInt16BE(pos);
      pos += 2;
      value = data.slice(pos, pos + valLen).toString('utf8');
      pos += valLen;
    } else if (valueType === 0x00) {
      value = data.readDoubleBE(pos);
      pos += 8;
    } else if (valueType === 0x01) {
      value = data[pos++] !== 0;
    } else {
      break;
    }
    
    obj[key] = value;
  }
  return obj;
}

function findConnectCommand(data) {
  const connectStr = Buffer.from('connect');
  let idx = data.indexOf(connectStr, 3073);
  if (idx === -1) return null;
  
  // 验证是 AMF0 string
  if (idx < 3 || data[idx - 3] !== 0x02 || data.readUInt16BE(idx - 2) !== 7) {
    return null;
  }
  
  let pos = idx + 7;
  
  // Transaction ID
  let txId = null;
  if (data[pos] === 0x00) {
    txId = data.readDoubleBE(pos + 1);
    pos += 9;
  }
  
  // Command object
  let cmdObj = null;
  if (data[pos] === 0x03) {
    pos++;
    cmdObj = parseAMFObject(data, pos);
  }
  
  return { txId, cmdObj };
}

// 分析
const buf = fs.readFileSync('/home/chwech/tmp/rtmp-node/aa.pcapng');
const connections = extractTcpPayloads(buf);

console.log(`找到 ${connections.length} 个连接\n`);

connections.forEach((conn, i) => {
  console.log(`\n========== 连接 ${i + 1} (${i === 0 ? '我们的程序' : 'ffmpeg'}) ==========`);
  const clientData = Buffer.concat(conn.client);
  
  const connect = findConnectCommand(clientData);
  if (connect && connect.cmdObj) {
    console.log('\nconnect 命令参数:');
    for (const [key, value] of Object.entries(connect.cmdObj)) {
      if (typeof value === 'string' && value.length > 100) {
        console.log(`  ${key}: ${value.substring(0, 100)}...`);
      } else {
        console.log(`  ${key}: ${value}`);
      }
    }
  }
});

