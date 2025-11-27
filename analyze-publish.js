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

function findAndParsePublish(data) {
  // 搜索 "publish" 字符串
  const publishStr = Buffer.from('publish');
  let idx = 0;
  const results = [];
  
  while ((idx = data.indexOf(publishStr, idx)) !== -1) {
    // 检查前面是否是 AMF0 string marker (0x02) 和长度 (0x00 0x07)
    if (idx >= 3 && data[idx - 3] === 0x02 && data[idx - 2] === 0x00 && data[idx - 1] === 0x07) {
      console.log(`\n找到 publish 命令 @ offset ${idx - 3}`);
      console.log('前后 100 字节 (hex):');
      const start = Math.max(0, idx - 20);
      const end = Math.min(data.length, idx + 200);
      console.log(data.slice(start, end).toString('hex'));
      
      // 解析参数
      let pos = idx + 7; // 跳过 "publish"
      
      // Transaction ID (number: 0x00 + 8 bytes)
      if (data[pos] === 0x00) {
        const txId = data.readDoubleBE(pos + 1);
        console.log('Transaction ID:', txId);
        pos += 9;
      }
      
      // Command object (null: 0x05)
      if (data[pos] === 0x05) {
        console.log('Command object: null');
        pos++;
      }
      
      // Stream name (string: 0x02 + 2 bytes len + string)
      if (data[pos] === 0x02) {
        pos++;
        const strLen = data.readUInt16BE(pos);
        pos += 2;
        const streamName = data.slice(pos, pos + strLen).toString('utf8');
        console.log('Stream name:', streamName.substring(0, 100) + (streamName.length > 100 ? '...' : ''));
        console.log('Stream name length:', strLen);
        pos += strLen;
        
        // Publish type (string: 0x02 + 2 bytes len + string)
        console.log('Next byte after stream name:', data[pos]?.toString(16));
        if (data[pos] === 0x02) {
          pos++;
          const typeLen = data.readUInt16BE(pos);
          pos += 2;
          const publishType = data.slice(pos, pos + typeLen).toString('utf8');
          console.log('Publish type:', publishType);
          console.log('Publish type length:', typeLen);
        } else {
          console.log('No publish type found! Next bytes:', data.slice(pos, pos + 10).toString('hex'));
        }
      }
      
      results.push(idx);
    }
    idx++;
  }
  
  return results;
}

// 分析
const buf = fs.readFileSync('/home/chwech/tmp/rtmp-node/aa.pcapng');
const connections = extractTcpPayloads(buf);

console.log(`找到 ${connections.length} 个连接\n`);

connections.forEach((conn, i) => {
  console.log(`\n========== 连接 ${i + 1} ==========`);
  const clientData = Buffer.concat(conn.client);
  findAndParsePublish(clientData);
});

