const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 使用 ffmpeg pipe 推流
 * Node.js 读取视频数据，通过 pipe 发送给 ffmpeg 处理 RTMP 协议
 */
async function main() {
  const rtmpUrl = 'rtmp://36.212.31.8/live/test-stream';
  const mp4File = path.join(__dirname, 'demo-1080p.mp4');

  console.log('开始 RTMP 推流 (pipe 模式)...');
  console.log('推流地址:', rtmpUrl);
  console.log('MP4文件:', mp4File);
  console.log('='.repeat(80));

  // ffmpeg 接收 stdin 的视频数据，推流到 RTMP
  const args = [
    '-re',
    '-i', 'pipe:0',
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-f', 'flv',
    rtmpUrl
  ];

  console.log('执行命令: ffmpeg', args.join(' '));
  console.log('');

  const ffmpeg = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  ffmpeg.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('frame=') || msg.includes('fps=')) {
      process.stderr.write('\r' + msg.trim());
    } else {
      process.stderr.write(data);
    }
  });

  ffmpeg.on('close', (code) => {
    console.log('\nffmpeg 进程退出，代码:', code);
  });

  ffmpeg.on('error', (err) => {
    console.error('ffmpeg 错误:', err);
  });

  // 循环读取 MP4 文件并发送
  let loopCount = 0;
  const maxLoops = 999999;

  const sendFile = () => {
    if (loopCount >= maxLoops) {
      ffmpeg.stdin.end();
      return;
    }

    loopCount++;
    console.log(`\n开始第 ${loopCount} 次循环播放...`);

    const fileStream = fs.createReadStream(mp4File);
    
    fileStream.on('data', (chunk) => {
      if (!ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.write(chunk);
      }
    });

    fileStream.on('end', () => {
      console.log(`第 ${loopCount} 次循环播放完成`);
      // 继续下一次循环
      setImmediate(sendFile);
    });

    fileStream.on('error', (err) => {
      console.error('读取文件错误:', err);
    });
  };

  // 开始发送
  sendFile();

  // 处理 Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n正在停止推流...');
    ffmpeg.stdin.end();
    ffmpeg.kill('SIGTERM');
  });
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };

