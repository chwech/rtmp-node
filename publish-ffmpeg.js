const { spawn } = require('child_process');
const path = require('path');

/**
 * 使用 ffmpeg 直接推流
 * 这是最可靠的方式，因为 ffmpeg 处理所有 RTMP 协议细节
 */
async function main() {
  const rtmpUrl = 'rtmp://36.212.31.8/live/test-stream';
  const mp4File = path.join(__dirname, 'demo-1080p.mp4');

  console.log('开始 RTMP 推流...');
  console.log('推流地址:', rtmpUrl);
  console.log('MP4文件:', mp4File);
  console.log('='.repeat(80));

  const args = [
    '-re',
    '-stream_loop', '-1',
    '-i', mp4File,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-f', 'flv',
    rtmpUrl
  ];

  console.log('执行命令: ffmpeg', args.join(' '));
  console.log('');

  const ffmpeg = spawn('ffmpeg', args);

  ffmpeg.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    // 过滤掉 ffmpeg 的进度信息，只显示重要信息
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

  // 处理 Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n正在停止推流...');
    ffmpeg.kill('SIGTERM');
  });
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };

