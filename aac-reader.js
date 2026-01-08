const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

/**
 * AAC 文件列表读取器（纯 Node.js，不依赖 ffmpeg）
 * 支持 ADTS 格式的 .aac 文件
 * 解析 AAC 帧并通过事件发送，用于 RTMP 推流
 */
class AACReader extends EventEmitter {
    constructor() {
        super();
        this.playlist = [];           // 文件路径列表
        this.currentIndex = 0;        // 当前文件索引
        this.frames = [];             // 当前文件的 AAC 帧（不含 ADTS 头）
        this.currentFrameIndex = 0;   // 当前帧索引
        this.isRunning = false;
        this.timer = null;
        this.timestamp = 0;
        // this.sampleRate = 44100;      // 默认采样率
        this.sampleRate = 48000;        // 改为 48000 Hz
        this.channels = 2;            // 默认立体声
        // this.frameDuration = 23;      // 每帧约 23ms (1024 samples / 44100)
        this.frameDuration = 21;        // 1024 / 48000 * 1000 ≈ 21.3ms
        this.frameCount = 0;          // 已发送帧数
        this.audioSpecificConfig = null; // AAC 序列头
        this.profile = 2;             // AAC-LC
        // this.sampleRateIndex = 4;     // 44100 Hz
        this.sampleRateIndex = 3;       // 48000 Hz 的索引是 3
        
        // 时间戳抖动相关
        this.correctTimestamp = 0;    // 理论正确的累积时间戳
        this.maxDrift = 50;           // 最大允许偏差（毫秒）
    }

    /**
     * 设置播放列表
     * @param {string[]} files - AAC 文件路径数组
     */
    setPlaylist(files) {
        this.playlist = files;
        this.currentIndex = 0;
        console.log(`设置播放列表: ${files.length} 个文件`);
        files.forEach((f, i) => console.log(`  ${i + 1}. ${path.basename(f)}`));
    }

    /**
     * 加载 AAC 文件并解析帧
     * @param {string} filePath - AAC 文件路径
     */
    loadFile(filePath) {
        console.log(`\n加载 AAC 文件: ${filePath}`);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`文件不存在: ${filePath}`);
        }
        
        const data = fs.readFileSync(filePath);
        this.frames = this.parseADTSFrames(data);
        this.currentFrameIndex = 0;
        
        const duration = (this.frames.length * this.frameDuration / 1000).toFixed(1);
        console.log(`  Profile: AAC-LC`);
        console.log(`  采样率: ${this.sampleRate} Hz`);
        console.log(`  声道数: ${this.channels}`);
        console.log(`  帧数量: ${this.frames.length}`);
        console.log(`  时长约: ${duration} 秒`);
    }

    /**
     * 解析 ADTS AAC 帧
     * ADTS 帧以 0xFFF 同步字开头（12位）
     * @param {Buffer} data - AAC 文件数据
     * @returns {Buffer[]} - AAC 原始帧数组（不含 ADTS 头）
     */
    parseADTSFrames(data) {
        const frames = [];
        let offset = 0;

        // 采样率表
        const sampleRates = [
            96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
            16000, 12000, 11025, 8000, 7350, 0, 0, 0
        ];

        while (offset < data.length - 7) {
            // 查找 ADTS 同步字: 0xFFF (12 bits)
            if (data[offset] === 0xFF && (data[offset + 1] & 0xF0) === 0xF0) {
                // 解析 ADTS 固定头部 (28 bits)
                const protectionAbsent = (data[offset + 1] >> 0) & 0x01;  // 1 = no CRC
                const profile = ((data[offset + 2] >> 6) & 0x03);         // 0=Main, 1=LC, 2=SSR, 3=LTP
                const sampleRateIndex = (data[offset + 2] >> 2) & 0x0F;
                const channelConfig = ((data[offset + 2] & 0x01) << 2) | ((data[offset + 3] >> 6) & 0x03);
                
                // 帧长度 (13 bits)
                const frameLength = ((data[offset + 3] & 0x03) << 11) |
                                   (data[offset + 4] << 3) |
                                   ((data[offset + 5] >> 5) & 0x07);
                
                // ADTS 头部大小: 7 bytes (no CRC) 或 9 bytes (with CRC)
                const headerSize = protectionAbsent ? 7 : 9;
                
                if (frameLength > headerSize && offset + frameLength <= data.length) {
                    // 提取原始 AAC 数据（不含 ADTS 头）
                    const rawFrame = data.slice(offset + headerSize, offset + frameLength);
                    frames.push(rawFrame);
                    
                    // 记录第一帧的信息
                    if (frames.length === 1) {
                        this.profile = profile + 1;  // ADTS profile 从 0 开始，AudioSpecificConfig 从 1 开始
                        this.sampleRateIndex = sampleRateIndex;
                        this.sampleRate = sampleRates[sampleRateIndex] || 44100;
                        this.channels = channelConfig || 2;
                        this.frameDuration = Math.round(1024 / this.sampleRate * 1000);
                        
                        // 生成 AudioSpecificConfig (2 bytes for AAC-LC)
                        this.audioSpecificConfig = this.generateAudioSpecificConfig();
                    }
                    
                    offset += frameLength;
                    continue;
                }
            }
            offset++;
        }

        return frames;
    }

    /**
     * 生成 AudioSpecificConfig (AAC 序列头)
     * 格式: 5 bits objectType + 4 bits sampleRateIndex + 4 bits channelConfig + 3 bits padding
     * @returns {Buffer} - AudioSpecificConfig (2 bytes)
     */
    generateAudioSpecificConfig() {
        // objectType (5 bits): 1=Main, 2=LC, 3=SSR, 4=LTP
        // sampleRateIndex (4 bits)
        // channelConfig (4 bits)
        // 总共 13 bits，填充到 16 bits (2 bytes)
        
        const objectType = this.profile;  // 通常是 2 (AAC-LC)
        const sampleRateIndex = this.sampleRateIndex;
        const channelConfig = this.channels;
        
        // 构建 16 位值
        // [objectType(5)][sampleRateIndex(4)][channelConfig(4)][frameLengthFlag(1)][dependsOnCoreCoder(1)][extensionFlag(1)]
        const config = (objectType << 11) | (sampleRateIndex << 7) | (channelConfig << 3);
        
        const buffer = Buffer.allocUnsafe(2);
        buffer.writeUInt16BE(config, 0);
        
        console.log(`  AudioSpecificConfig: ${buffer.toString('hex').toUpperCase()}`);
        return buffer;
    }

    /**
     * 获取 FLV 音频头字节
     * Format: SoundFormat(4) | SoundRate(2) | SoundSize(1) | SoundType(1)
     * @returns {number} - 音频头字节
     */
    getAudioHeader() {
        // SoundFormat = 10 (AAC)
        let header = 0xA0;
        
        // SoundRate: 对于 AAC，固定为 3 (44kHz)
        // AAC 实际采样率由 AudioSpecificConfig 指定
        header |= 0x0C; // 3 << 2
        
        // SoundSize = 1 (16-bit)
        header |= 0x02;
        
        // SoundType: 0=Mono, 1=Stereo
        // 对于 AAC，固定为 1 (Stereo)
        header |= 0x01;
        
        return header; // 0xAF
    }

    /**
     * 生成不稳定的帧间隔（模拟抖音纯音频直播的特征）
     * 策略：delta 随机波动，但每 3 帧校正一次，保证累积时间戳正确
     * 这模拟了截图中"每3帧总和约 63-67ms"的特征
     * @returns {number} - 时间戳增量（毫秒）
     */
    // getJitteredDelta() {
    //     // 更新理论正确的累积时间戳
    //     this.correctTimestamp += this.frameDuration;
        
    //     // 当前帧编号 (frameCount 在 _sendFrame 结束时才+1，所以这里+1代表当前帧)
    //     const currentFrameNum = this.frameCount + 1;
        
    //     // 每 3 帧校正一次 (第3、6、9...帧)，或者偏差过大时强制校正
    //     const currentDrift = this.timestamp - this.correctTimestamp;
    //     const shouldCorrect = (currentFrameNum % 3 === 0) || Math.abs(currentDrift) > this.maxDrift;
        
    //     if (shouldCorrect) {
    //         // 校正：让实际时间戳回到正确轨道
    //         const correctedDelta = this.correctTimestamp - this.timestamp;
    //         return Math.max(0, Math.min(60, Math.round(correctedDelta)));
    //     } else {
    //         // 随机 delta（从截图观察到的模式）
    //         const patterns = [0, 1, 3, 4, 6, 7, 8, 9, 11, 22, 23, 24, 25, 27, 28, 29, 30, 32, 33, 34];
    //         return patterns[Math.floor(Math.random() * patterns.length)];
    //     }
    // }
    getJitteredDelta() {
        // 更新理论正确的累积时间戳
        this.correctTimestamp += this.frameDuration;
        
        // 随机 delta（模拟观察到的模式）
        const patterns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34];
        let delta = patterns[Math.floor(Math.random() * patterns.length)];
        
        // 计算如果用这个 delta，累积偏差会是多少
        const newTimestamp = this.timestamp + delta;
        const drift = newTimestamp - this.correctTimestamp;
        
        // 如果偏差过大，强制调整
        if (drift > 30) {
            // 超前太多，用小 delta
            delta = Math.max(0, this.correctTimestamp - this.timestamp - 10);
        } else if (drift < -30) {
            // 落后太多，用大 delta
            delta = Math.min(50, this.correctTimestamp - this.timestamp + 10);
        }
        
        return Math.max(0, delta);
    }

    /**
     * 获取元数据
     * @returns {Object} - 音频元数据
     */
    getMetadata() {
        return {
            audiocodecid: 10,  // AAC
            audiosamplerate: this.sampleRate,
            audiosamplesize: 16,
            stereo: this.channels === 2
        };
    }

    /**
     * 获取 AudioSpecificConfig
     * @returns {Buffer} - AAC 序列头
     */
    getAudioSpecificConfig() {
        return this.audioSpecificConfig;
    }

    /**
     * 开始播放
     * @param {boolean} loop - 是否循环播放，默认 true
     * @param {boolean} jitter - 是否使用不稳定的帧间隔，默认 true
     */
    start(loop = true, jitter = true) {
        if (this.isRunning) {
            console.log('已在运行中');
            return;
        }
        if (this.playlist.length === 0) {
            console.error('播放列表为空，请先调用 setPlaylist()');
            return;
        }

        this.isRunning = true;
        this.loop = loop;
        this.jitter = jitter;
        this.timestamp = 0;
        this.frameCount = 0;
        this.correctTimestamp = 0;  // 重置理论时间戳
        
        console.log(`\n开始播放 AAC 列表 (循环=${loop}, 抖动=${jitter})`);
        
        // 加载第一个文件
        this.loadFile(this.playlist[this.currentIndex]);
        
        // 发送 AAC 序列头事件
        this.emit('audioSequenceHeader', {
            header: this.getAudioHeader(),
            config: this.audioSpecificConfig
        });
        
        // 等待一小段时间后开始发送音频帧
        setTimeout(() => {
            // 发送第一帧
            this._sendFrame(true);
            
            // 开始定时发送
            this._scheduleNextFrame();
        }, 100);
    }

    /**
     * 停止播放
     */
    stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        console.log(`\n停止播放，已发送 ${this.frameCount} 帧`);
    }

    /**
     * 发送一帧音频数据
     * @param {boolean} isFirst - 是否为第一帧
     */
    _sendFrame(isFirst = false) {
        if (this.frames.length === 0 || this.currentFrameIndex >= this.frames.length) {
            return false;
        }
        
        const frame = this.frames[this.currentFrameIndex];
        const header = this.getAudioHeader();
        
        // 计算时间戳
        let delta;
        if (isFirst) {
            delta = 0;
        } else {
            delta = this.jitter ? this.getJitteredDelta() : this.frameDuration;
        }
        
        this.timestamp += delta;
        
        this.emit('audioFrame', {
            header: header,
            data: frame,
            timestamp: this.timestamp,
            delta: delta,
            frameIndex: this.currentFrameIndex,
            fileIndex: this.currentIndex
        });
        
        this.currentFrameIndex++;
        this.frameCount++;
        
        // 打印进度
        if (this.frameCount % 100 === 0) {
            // console.log(`已发送 ${this.frameCount} 帧, ts=${this.timestamp}ms, 文件 ${this.currentIndex + 1}/${this.playlist.length}`);
            console.log(`帧${this.frameCount}: timestamp=${this.timestamp}, correct=${this.correctTimestamp}, drift=${this.timestamp - this.correctTimestamp}`);
        }
        
        return true;
    }

    /**
     * 调度下一帧发送
     */
    _scheduleNextFrame() {
        if (!this.isRunning) return;

        // 检查是否需要加载下一个文件
        if (this.currentFrameIndex >= this.frames.length) {
            this.currentIndex++;
            
            if (this.currentIndex >= this.playlist.length) {
                if (this.loop) {
                    console.log('\n播放列表循环，从头开始');
                    this.currentIndex = 0;
                } else {
                    console.log('\n播放列表结束');
                    this.isRunning = false;
                    this.emit('end');
                    return;
                }
            }
            
            try {
                this.loadFile(this.playlist[this.currentIndex]);
                // 触发文件切换事件，通知外部可以预加载下一个文件
                this.emit('fileChange', {
                    currentIndex: this.currentIndex,
                    nextIndex: (this.currentIndex + 1) % this.playlist.length,
                    totalFiles: this.playlist.length
                });
            } catch (error) {
                console.error('加载文件失败:', error.message);
                this.emit('error', error);
                // 尝试下一个文件
                this._scheduleNextFrame();
                return;
            }
        }

        // 发送当前帧
        this._sendFrame();
        
        // 调度下一帧（实际发送间隔使用标准帧时长，保证播放流畅）
        // const sendInterval = Math.floor(this.frameDuration * 0.85);  // 21 * 0.85 ≈ 18ms
        const sendInterval = 15 + Math.floor(Math.random() * 7); //15-21ms
        this.timer = setTimeout(() => this._scheduleNextFrame(), sendInterval);
    }
}

module.exports = AACReader;

