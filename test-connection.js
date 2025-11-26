const { NetConnection } = require('rtmp-client');

const rtmpUrl = "rtmp://push-rtmp-l26.douyincdn.com/third/stream-694838987735171558?arch_hrchy=c1&expire=692d54e9&sign=52e02064d7efa40da550a0d9569306a3&t_id=037-2025112416421726C8F95148A0B44B2F5E-eBVyml";

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

