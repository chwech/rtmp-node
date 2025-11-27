const RTMPPublisher = require('./rtmp-publisher');
const MP4Reader = require('./mp4-reader');
const path = require('path');

/**
 * RTMP推流示例
 * 循环读取 MP4 文件并推流（包含音频和视频）
 */
async function main() {
  // RTMP 推流地址
  const rtmpUrl = 'rtmp://36.212.31.8/live/test-noapp-1764215133';
  
  // MP4 文件路径
  const mp4File = path.join(__dirname, 'demo-1080p.mp4');

  const publisher = new RTMPPublisher();
  const mp4Reader = new MP4Reader(mp4File);
  
  let videoFrameCount = 0;
  let audioFrameCount = 0;
  let avcConfigSent = false;
  let audioConfigSent = false;

  // 监听 AVC 序列头
  mp4Reader.on('avcSequenceHeader', (avcConfig) => {
    if (publisher.publishStream) {
      console.log('发送 AVC 序列头...');
      publisher.sendAVCConfig(avcConfig);
      avcConfigSent = true;
    }
  });

  // 监听视频帧
  mp4Reader.on('videoFrame', (frame) => {
    if (!publisher.publishStream) return;
    
    try {
      // 直接发送 FLV 格式的视频数据
      const videoTag = Buffer.concat([
        Buffer.from([frame.isKeyframe ? 0x17 : 0x27]), // FrameType + CodecID
        Buffer.from([0x01]), // AVC NALU
        Buffer.from([
          (frame.compositionTime >> 16) & 0xff,
          (frame.compositionTime >> 8) & 0xff,
          frame.compositionTime & 0xff
        ]),
        frame.data
      ]);
      
      // 传递时间戳
      publisher.sendFLVVideoFrame(videoTag, frame.isKeyframe, frame.timestamp);
      videoFrameCount++;
      
      if (videoFrameCount % 100 === 0) {
        console.log(`视频: ${videoFrameCount} 帧, 音频: ${audioFrameCount} 帧, ts: ${frame.timestamp}ms`);
      }
    } catch (error) {
      console.error('发送视频帧失败:', error);
    }
  });

  // 监听音频序列头
  mp4Reader.on('audioSequenceHeader', (audio) => {
    if (publisher.publishStream && !audioConfigSent) {
      console.log('发送 AAC 序列头...');
      publisher.sendAudioSequenceHeader(audio.header, audio.config);
      audioConfigSent = true;
    }
  });

  // 监听音频帧
  mp4Reader.on('audioFrame', (frame) => {
    if (!publisher.publishStream) return;
    
    try {
      // 传递时间戳
      publisher.sendAudioFrame(frame.header, frame.data, frame.timestamp);
      audioFrameCount++;
    } catch (error) {
      console.error('发送音频帧失败:', error);
    }
  });

  mp4Reader.on('error', (error) => {
    console.error('MP4 读取错误:', error);
  });

  mp4Reader.on('end', () => {
    console.log('MP4 播放结束');
  });

  // 监听推流事件
  publisher.on('publishStart', (statusInfo) => {
    console.log('\n✅ 推流成功启动！');
    console.log('状态信息:', JSON.stringify(statusInfo, null, 2));
    
    // 注意：按照 ffmpeg 的行为，不主动发送 WindowAckSize 和 PingPong
    // 服务器会在需要时发送 ping，客户端会自动响应 pong

    // 发送元数据
    console.log('\n发送元数据...');
    try {
      const metadata = mp4Reader.getMetadata();
      publisher.sendCustomMetaData(metadata);
    } catch (error) {
      console.error('发送元数据失败:', error);
    }

    // 开始读取 MP4 文件并推流
    console.log('\n开始读取 MP4 文件并推流（包含音频和视频）...');
    console.log('文件:', mp4File);
    mp4Reader.start(true); // true = 循环播放
  });

  publisher.on('status', (statusInfo) => {
    console.log('状态更新:', statusInfo);
  });

  publisher.on('error', (error) => {
    console.error('发生错误:', error);
  });

  publisher.on('close', (err) => {
    console.log('连接已关闭', err ? err.message : '');
    mp4Reader.stop();
  });

  try {
    console.log('开始RTMP推流流程...\n');
    console.log('推流地址:', rtmpUrl);
    console.log('MP4文件:', mp4File);
    console.log('='.repeat(80));

    // 连接到服务器并完成推流准备
    await publisher.connect(rtmpUrl, {
      type: 'nonprivate',
      flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
      publishType: 'live'
    });

    // 保持程序运行
    console.log('\n程序保持运行中，按 Ctrl+C 退出...');
    await new Promise(() => {});
    
  } catch (error) {
    console.error('推流失败:', error);
    mp4Reader.stop();
    process.exit(1);
  }
}

// 处理程序退出
process.on('SIGINT', () => {
  console.log('\n正在关闭连接...');
  process.exit(0);
});

// 运行主程序
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
