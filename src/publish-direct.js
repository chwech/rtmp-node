const RTMPPublisher = require('./rtmp-publisher');
const PingPong = require('rtmp-client/lib/PingPong');
const { spawn } = require('child_process');
const path = require('path');

/**
 * 直接推流测试
 * 先建立 RTMP 连接，然后看连接能保持多久
 */
async function main() {
  const rtmpUrl = 'rtmp://36.212.31.8/live/test-stream';
  const mp4File = path.join(__dirname, 'demo-1080p.mp4');

  const publisher = new RTMPPublisher();
  let pingPong = null;
  let startTime = null;

  publisher.on('publishStart', (statusInfo) => {
    console.log('\n✅ 推流成功启动！');
    startTime = Date.now();
    
    // 启动 PingPong 保活
    pingPong = new PingPong(2000, 5000); // 更频繁的 ping
    pingPong.start(publisher.client);
    console.log('PingPong 启动（每2秒）');

    // 发送元数据
    publisher.sendCustomMetaData({
      width: 606,
      height: 1080,
      framerate: 30,
      videocodecid: 7,
      audiocodecid: 10
    });

    // 使用 ffmpeg 直接生成 H.264 并发送
    // 使用 -re 以实时速率读取
    const ffmpeg = spawn('ffmpeg', [
      '-re',  // 实时速率
      '-stream_loop', '-1',
      '-i', mp4File,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-r', '30',  // 强制 30fps
      '-g', '30',
      '-keyint_min', '30',
      '-an',
      '-f', 'h264',
      '-bsf:v', 'h264_mp4toannexb',
      'pipe:1'
    ]);

    // 发送队列，用于控制发送速率
    const frameQueue = [];
    let lastSendTime = Date.now();
    const frameInterval = 33; // 30fps = 33ms/帧
    let running = true;

    const processQueue = () => {
      if (!running) return;
      
      const now = Date.now();
      if (frameQueue.length > 0) {
        const expectedTime = lastSendTime + frameInterval;
        
        if (now >= expectedTime) {
          const frame = frameQueue.shift();
          try {
            publisher.sendFLVVideoFrame(frame.videoTag, frame.isKeyframe, frame.timestamp);
            frameCount++;
            lastSendTime = now;

            if (frameCount % 30 === 0) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              console.log(`帧: ${frameCount}, 时间: ${elapsed}s, ts: ${frame.timestamp}ms, 队列: ${frameQueue.length}`);
            }
          } catch (e) {
            console.error('发送失败:', e.message);
            running = false;
            return;
          }
        }
      }
      
      setTimeout(processQueue, 5);
    };
    
    // 启动队列处理
    console.log('启动帧队列处理...');
    processQueue();

    publisher.on('close', () => {
      running = false;
    });

    let sps = null;
    let pps = null;
    let buffer = Buffer.alloc(0);
    let frameCount = 0;
    let timestamp = 0;

    ffmpeg.stdout.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      
      // 简单解析 Annex B NAL
      while (buffer.length > 4) {
        let startPos = -1;
        let startLen = 0;
        
        for (let i = 0; i < buffer.length - 4; i++) {
          if (buffer[i] === 0 && buffer[i+1] === 0 && buffer[i+2] === 0 && buffer[i+3] === 1) {
            startPos = i;
            startLen = 4;
            break;
          }
          if (buffer[i] === 0 && buffer[i+1] === 0 && buffer[i+2] === 1) {
            startPos = i;
            startLen = 3;
            break;
          }
        }
        
        if (startPos === -1) break;
        if (startPos > 0) {
          buffer = buffer.slice(startPos);
          continue;
        }

        // 查找下一个起始码
        let nextPos = -1;
        for (let i = startLen; i < buffer.length - 3; i++) {
          if (buffer[i] === 0 && buffer[i+1] === 0 && 
              (buffer[i+2] === 1 || (buffer[i+2] === 0 && buffer[i+3] === 1))) {
            nextPos = i;
            break;
          }
        }

        if (nextPos === -1) {
          if (buffer.length > 500000) {
            buffer = Buffer.alloc(0);
          }
          break;
        }

        const nalUnit = buffer.slice(startLen, nextPos);
        const nalType = nalUnit[0] & 0x1f;

        if (nalType === 7) { // SPS
          sps = nalUnit;
        } else if (nalType === 8) { // PPS
          pps = nalUnit;
          if (sps && pps) {
            // 发送 AVC 序列头
            const avcConfig = Buffer.concat([
              Buffer.from([0x01, sps[1], sps[2], sps[3], 0xff, 0xe1]),
              Buffer.from([(sps.length >> 8) & 0xff, sps.length & 0xff]),
              sps,
              Buffer.from([0x01]),
              Buffer.from([(pps.length >> 8) & 0xff, pps.length & 0xff]),
              pps
            ]);
            publisher.sendAVCConfig(avcConfig);
          }
        } else if (nalType === 5 || nalType === 1) { // IDR 或 非 IDR
          const isKeyframe = nalType === 5;
          const nalLength = Buffer.allocUnsafe(4);
          nalLength.writeUInt32BE(nalUnit.length, 0);

          const videoTag = Buffer.concat([
            Buffer.from([isKeyframe ? 0x17 : 0x27, 0x01, 0x00, 0x00, 0x00]),
            nalLength,
            nalUnit
          ]);

          // 加入队列，由队列处理器按速率发送
          frameQueue.push({ videoTag, isKeyframe, timestamp });
          timestamp += 33;
        }

        buffer = buffer.slice(nextPos);
      }
    });

    ffmpeg.on('close', (code) => {
      console.log('ffmpeg 退出:', code);
      running = false;
    });
  });

  publisher.on('close', (err) => {
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(1) : 0;
    console.log(`连接关闭，持续时间: ${elapsed}s`);
    if (pingPong) pingPong.stop();
  });

  try {
    console.log('连接 RTMP 服务器...');
    await publisher.connect(rtmpUrl, {
      type: 'nonprivate',
      flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
      publishType: 'live'
    });

    await new Promise(() => {});
  } catch (error) {
    console.error('错误:', error);
  }
}

process.on('SIGINT', () => process.exit(0));

main().catch(console.error);

