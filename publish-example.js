const RTMPPublisher = require('./rtmp-publisher');

/**
 * RTMP推流示例
 * 演示完整的RTMP建联和推流流程（到第14步）
 */
async function main() {
  // 从分析报告中提取的抖音推流地址
//   const rtmpUrl = "rtmp://push-rtmp-l3.douyincdn.com/third/stream-694839456628998623?arch_hrchy=c1&auth_key=1764583169-0-0-1b56017f1b4f576914c6ae9a62e6bc97&t_id=037-20251124182929B4D21157F40A3D53E603-ldkMbW"

  
// 或者使用测试服务器
  const rtmpUrl = 'rtmp://36.212.31.8/live/test-stream';

  const publisher = new RTMPPublisher();

  // 监听事件
  publisher.on('publishStart', (statusInfo) => {
    console.log('\n✅ 推流成功启动！');
    console.log('状态信息:', JSON.stringify(statusInfo, null, 2));
    console.log('\n已完成所有14个步骤：');
    console.log('1-3: TCP三次握手');
    console.log('4-6: RTMP握手');
    console.log('7: Set Chunk Size');
    console.log('8-9: connect命令');
    console.log('10: releaseStream');
    console.log('11-12: FCPublish和createStream');
    console.log('13-14: publish命令和onStatus响应');
    
    // 开始发送测试视频数据
    console.log('\n开始发送测试视频数据...');
    try {
      publisher.startSendingTestVideo(5, 30); // 发送5秒，30fps
    } catch (error) {
      console.error('发送测试视频数据失败:', error);
    }
  });

  publisher.on('status', (statusInfo) => {
    console.log('状态更新:', statusInfo);
  });

  publisher.on('error', (error) => {
    console.error('发生错误:', error);
  });

  publisher.on('close', (err) => {
    console.log('连接已关闭', err ? err.message : '');
  });

  try {
    console.log('开始RTMP推流流程...\n');
    console.log('推流地址:', rtmpUrl);
    console.log('='.repeat(80));

    // 连接到服务器并完成推流准备
    await publisher.connect(rtmpUrl, {
      type: 'nonprivate',
      flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
      publishType: 'live'
    });
    

    // 保持连接，等待publishStart事件
    // 在实际应用中，这里可以开始发送音视频数据
    
  } catch (error) {
    console.error('推流失败:', error);
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

