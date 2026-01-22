const { NetConnection } = require('rtmp-client');

const rtmpUrl = "rtmp://push-rtmp-l26.douyincdn.com/stage/stream-118679693617266827?arch_hrchy=w1&exp_hrchy=c1&expire=6971dde9&sign=ec7d7e4559d871faba216ecc4dd06c36&t_id=037-2026011516205739D53F2C40EAB583833D-s37V7g"

const nc = new NetConnection();
nc.onStatus = function (info) {
  console.log('NetConnection status:', info);
  console.log('NetConnection connected:', nc.isConnected);
  if (info.code === 'NetConnection.Connect.Success') {
    console.log('✅ 连接成功！');
  } else if (info.level === 'error') {
    console.error('❌ 连接失败:', info);
  }
};

console.log('测试使用原始NetConnection连接...');
console.log('URL:', rtmpUrl);
console.log('='.repeat(80));

nc.connect(rtmpUrl);

setTimeout(() => {
  console.log('\n测试完成，关闭连接...');
  nc.close();
  process.exit(0);
}, 5000);

