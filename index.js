const { NetConnection } = require('rtmp-client');

const nc = new NetConnection();
nc.onStatus = function (info) {
  console.log('NetConnection status:', info);
  console.log('NetConnection connected:', nc.isConnected);
	if (info.code === 'NetConnection.Connect.Success') {      
      nc.call('releaseStream', {
        'onResult': console.log.bind(console),
        'onStatus': console.error.bind(console),
      }, 'bar');

      nc.call('', {
        'onResult': console.log.bind(console),
        'onStatus': console.error.bind(console),
      }, 'bar');
	}
};
nc.rpcName = async function (...args) {
	console.log('server called rpcName', ...args);
};
nc.connect('rtmp://36.212.31.8/live/test-stream');
// nc.connect('rtmp://push-rtmp-cold-f5.douyincdn.com/stage/stream-406608292217881429?arch_hrchy=c1&exp_hrchy=c1&expire=1764573240&sign=aa776f85144f9a235248cbe050020987&t_id=037-2025112415140071238DB26984A5417873-psjQ3R&volcSecret=aa776f85144f9a235248cbe050020987&volcTime=1764573240');
