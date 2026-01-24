const RTMPPublisher = require('./rtmp-publisher');
const AACReader = require('./aac-reader');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// 全局变量，用于 SIGINT 处理
let globalPublisher = null;
let globalAACReader = null;

/**
 * 获取 MP3 对应的 AAC 文件路径（同目录，改后缀）
 * @param {string} mp3Path - MP3 文件路径
 * @returns {string} - AAC 文件路径
 */
function getAACPath(mp3Path) {
    const dir = path.dirname(mp3Path);
    const baseName = path.basename(mp3Path, path.extname(mp3Path));
    return path.join(dir, `${baseName}.aac`);
}

/**
 * 检查 AAC 文件是否存在
 * @param {string} mp3Path - MP3 文件路径
 * @returns {boolean}
 */
function hasAAC(mp3Path) {
    return fs.existsSync(getAACPath(mp3Path));
}

/**
 * 转换 MP3 为 AAC（异步，返回 Promise）
 * @param {string} mp3Path - MP3 文件路径
 * @returns {Promise<string>} - AAC 文件路径
 */
function convertToAAC(mp3Path) {
    return new Promise((resolve, reject) => {
        const aacPath = getAACPath(mp3Path);
        
        if (fs.existsSync(aacPath)) {
            resolve(aacPath);
            return;
        }
        
        console.log(`🔄 转换: ${path.basename(mp3Path)} -> AAC ...`);
        
        // exec(`ffmpeg -i "${mp3Path}" -c:a aac -b:a 128k -f adts "${aacPath}" -y`, (error) => {
        exec(`ffmpeg -i "${mp3Path}" -c:a aac -b:a 128k -ar 48000 -f adts "${aacPath}" -y`, (error) => {
            if (error) {
                reject(new Error(`转换失败: ${mp3Path}`));
            } else {
                console.log(`✅ 转换完成: ${path.basename(aacPath)}`);
                resolve(aacPath);
            }
        });
    });
}

/**
 * 后台预转换下一首（不阻塞，静默失败）
 * @param {string} mp3Path - MP3 文件路径
 */
function preConvertAAC(mp3Path) {
    if (!mp3Path || hasAAC(mp3Path)) return;
    
    console.log(`⏳ 预转换下一首: ${path.basename(mp3Path)}`);
    convertToAAC(mp3Path).catch(() => {
        // 预转换失败不影响当前播放
    });
}

/**
 * MP3 播放列表推流示例
 * 读取 MP3 文件列表，按需转换为 AAC 并通过 RTMP 推流
 */
async function main() {
    // ============ 配置区域 ============
    
    // RTMP 推流地址
    // 可以 const rtmpUrl = 'rtmp://push-rtmp-cold-f5.douyincdn.com/stage/stream-118633289582642005?arch_hrchy=c1&exp_hrchy=c1&expire=1768378597&sign=fceb83da7fcd6eac0f974918913244c3&t_id=037-20260107161637350DE5D6510A0381D15A-LWOfxP&volcSecret=fceb83da7fcd6eac0f974918913244c3&volcTime=1768378597';
    // 不行 const rtmpUrl = 'rtmp://push-rtmp-c11.douyincdn.com/stage/stream-118637343767003607?arch_hrchy=c1&exp_hrchy=c1&expire=1768439120&sign=a82207125ac6ccb7d7b33cc52d8e095e&t_id=037-2026010809052056845A8202259ED40F20-QM0I3H';

    const rtmpUrl = 'rtmp://push-rtmp-c11.douyincdn.com/stage/stream-695141287406600663?arch_hrchy=c1&exp_hrchy=c1&expire=1769082606&sign=d32cd10cbe19ef7ecb02f2104104fca1&t_id=037-202601151950062E940ADA95E9B5838AE5-Vhy8wz'
    // MP3 文件列表（自动转换为 AAC 并缓存到本地）
    // const mp3Files = [
    //     path.join(__dirname, './music/test1.mp3'),
    //     path.join(__dirname, './music/test2.mp3'),
    //     // 添加更多 MP3 文件...
    // ];
    const musicDir = path.join(__dirname, 'music');
    const mp3Files = fs.readdirSync(musicDir)
        .filter(f => f.toLowerCase().endsWith('.mp3'))
        .map(f => path.join(musicDir, f))
        .sort(() => Math.random() - 0.5);  // 乱序

    console.log(`发现 ${mp3Files.length} 个 MP3 文件，已乱序`);
    
    // 是否循环播放
    const loop = true;
    
    // 是否使用抖动时间戳（模拟抖音纯音频直播的特征）
    const jitter = true;
    
    // ============ 配置结束 ============

    // 检查 MP3 文件是否存在
    const existingMP3 = mp3Files.filter(f => {
        if (fs.existsSync(f)) {
            return true;
        } else {
            console.warn(`警告: 文件不存在，跳过: ${f}`);
            return false;
        }
    });

    if (existingMP3.length === 0) {
        console.error('错误: 没有找到任何 MP3 文件！');
        console.log('\n请修改 mp3Files 数组，添加你的 MP3 文件路径');
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('MP3 -> AAC 按需转换 RTMP 推流');
    console.log('='.repeat(60));
    console.log(`推流地址: ${rtmpUrl}`);
    console.log(`循环播放: ${loop}`);
    console.log(`时间戳抖动: ${jitter}`);
    console.log(`MP3 文件: ${existingMP3.length} 个`);
    console.log('='.repeat(60));

    // 转换第一首（必须等待完成）
    console.log('\n准备第一首歌曲...');
    let firstAACPath;
    try {
        firstAACPath = await convertToAAC(existingMP3[0]);
    } catch (error) {
        console.error('转换第一首失败:', error.message);
        process.exit(1);
    }

    // 构建 AAC 播放列表
    const aacFiles = existingMP3.map(mp3 => getAACPath(mp3));

    // 如果有第二首，后台预转换
    if (existingMP3.length > 1) {
        preConvertAAC(existingMP3[1]);
    }

    // 创建 RTMPPublisher
    const publisher = new RTMPPublisher({
        reconnect: true,
        maxReconnectAttempts: 10,
        reconnectInterval: 3000
    });
    globalPublisher = publisher;

    // 创建 AACReader
    const aacReader = new AACReader();
    globalAACReader = aacReader;
    aacReader.setPlaylist(aacFiles);

    let frameCount = 0;
    let sequenceHeaderSent = false;

    // 监听文件切换事件，预转换下一首
    aacReader.on('fileChange', ({ currentIndex, nextIndex, totalFiles }) => {
        console.log(`\n🎵 切换到第 ${currentIndex + 1}/${totalFiles} 首`);
        
        // 预转换下一首（如果存在且还没转换）
        if (nextIndex < existingMP3.length) {
            preConvertAAC(existingMP3[nextIndex]);
        }
    });

    // 监听 AAC 序列头
    aacReader.on('audioSequenceHeader', (audio) => {
        if (publisher.publishStream && !sequenceHeaderSent) {
            console.log('发送 AAC 序列头...');
            publisher.sendAudioSequenceHeader(audio.header, audio.config);
            sequenceHeaderSent = true;
        }
    });

    // 监听音频帧
    aacReader.on('audioFrame', (frame) => {
        if (!publisher.publishStream) return;
        
        try {
            publisher.sendAudioFrame(frame.header, frame.data, frame.timestamp);
            frameCount++;
            
            if (frameCount % 200 === 0) {
                console.log(`已推流 ${frameCount} 帧, 累计时长: ${(frame.timestamp / 1000).toFixed(1)}s`);
            }
        } catch (error) {
            console.error('发送音频帧失败:', error.message);
        }
    });

    aacReader.on('error', (error) => {
        console.error('AAC 读取错误:', error.message);
    });

    aacReader.on('end', () => {
        console.log('播放列表结束');
    });

    // 监听推流事件
    publisher.on('publishStart', (statusInfo) => {
        console.log('\n✅ 推流成功启动！');
        console.log('状态信息:', JSON.stringify(statusInfo, null, 2));

        // 发送元数据
        console.log('\n发送元数据...');
        try {
            const metadata = aacReader.getMetadata();
            publisher.sendCustomMetaData(metadata);
        } catch (error) {
            console.error('发送元数据失败:', error.message);
        }

        // 开始播放
        console.log('\n开始播放...');
        sequenceHeaderSent = false;
        aacReader.start(loop, jitter);
    });

    publisher.on('status', (statusInfo) => {
        console.log('状态更新:', statusInfo);
    });

    publisher.on('error', (error) => {
        console.error('发生错误:', error.message);
    });

    publisher.on('close', (err) => {
        console.log('连接已关闭', err ? err.message : '');
        aacReader.stop();
    });

    // 重连相关事件
    publisher.on('reconnecting', ({ attempt, maxAttempts, interval }) => {
        console.log(`\n🔄 正在尝试重连... (${attempt}/${maxAttempts})`);
    });

    publisher.on('reconnected', () => {
        console.log('\n✅ 重连成功！推流已恢复');
        sequenceHeaderSent = false;
        aacReader.start(loop, jitter);
    });

    publisher.on('reconnectFailed', ({ attempts, error }) => {
        console.error(`\n❌ 重连失败！已尝试 ${attempts} 次`);
        process.exit(1);
    });

    try {
        console.log('\n开始 RTMP 推流流程...\n');

        await publisher.connect(rtmpUrl, {
            type: 'nonprivate',
            flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
            publishType: 'live'
        });

        console.log('\n程序保持运行中，按 Ctrl+C 退出...');
        await new Promise(() => {});
        
    } catch (error) {
        console.error('推流失败:', error.message);
        aacReader.stop();
        process.exit(1);
    }
}

// 处理程序退出
process.on('SIGINT', () => {
    console.log('\n\n正在关闭连接...');
    if (globalAACReader) {
        globalAACReader.stop();
    }
    if (globalPublisher) {
        globalPublisher.stopReconnect();
        globalPublisher.close();
    }
    process.exit(0);
});

// 运行主程序
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { main };
