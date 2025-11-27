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

function findAMFStrings(data, searchStr) {
  const results = [];
  const searchBuf = Buffer.from(searchStr);
  let idx = 0;
  
  while ((idx = data.indexOf(searchBuf, idx)) !== -1) {
    // 检查是否是 AMF0 string
    if (idx >= 3) {
      const marker = data[idx - 3];
      const len = data.readUInt16BE(idx - 2);
      if (marker === 0x02 && len === searchStr.length) {
        // 找到后面的参数
        let pos = idx + searchStr.length;
        const params = [];
        
        for (let i = 0; i < 10 && pos < data.length; i++) {
          const type = data[pos];
          if (type === 0x02) { // string
            pos++;
            const strLen = data.readUInt16BE(pos);
            pos += 2;
            const str = data.slice(pos, pos + strLen).toString('utf8');
            params.push({ type: 'string', value: str.substring(0, 200) });
            pos += strLen;
          } else if (type === 0x00) { // number
            pos++;
            const num = data.readDoubleBE(pos);
            params.push({ type: 'number', value: num });
            pos += 8;
          } else if (type === 0x01) { // boolean
            pos++;
            params.push({ type: 'boolean', value: data[pos++] !== 0 });
          } else if (type === 0x05) { // null
            pos++;
            params.push({ type: 'null' });
          } else if (type === 0x03) { // object
            pos++;
            params.push({ type: 'object', value: '...' });
            break;
          } else {
            break;
          }
        }
        
        results.push({ offset: idx, params });
      }
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
  console.log(`\n========== 连接 ${i + 1} (${i === 0 ? '我们的程序' : 'ffmpeg'}) ==========`);
  const clientData = Buffer.concat(conn.client);
  
  // 查找 releaseStream
  console.log('\n--- releaseStream ---');
  const release = findAMFStrings(clientData, 'releaseStream');
  release.forEach(r => {
    console.log('参数:', r.params.map(p => p.value || p.type).join(', '));
  });
  
  // 查找 FCPublish
  console.log('\n--- FCPublish ---');
  const fcpub = findAMFStrings(clientData, 'FCPublish');
  fcpub.forEach(r => {
    console.log('参数:', r.params.map(p => p.value || p.type).join(', '));
  });
  
  // 查找 publish
  console.log('\n--- publish ---');
  const pub = findAMFStrings(clientData, 'publish');
  pub.forEach(r => {
    console.log('参数:', r.params.map(p => p.value || p.type).join(', '));
  });
});

