const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * MP4 文件读取器
 * 使用 ffmpeg 转换为 FLV 格式，同时提取音频和视频
 */
class MP4Reader extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this.ffmpeg = null;
        this.isRunning = false;
        this.frameRate = 30;
        this.width = 1920;
        this.height = 1080;
        this.audioSampleRate = 48000;
        this.audioChannels = 2;
    }

    /**
     * 开始读取 MP4 文件
     * @param {boolean} loop - 是否循环播放
     */
    start(loop = true) {
        if (this.isRunning) return;
        this.isRunning = true;
        this._startFFmpeg(loop);
    }

    stop() {
        this.isRunning = false;
        if (this.ffmpeg) {
            this.ffmpeg.kill('SIGTERM');
            this.ffmpeg = null;
        }
    }

    _startFFmpeg(loop) {
        // 使用 FLV 格式输出，同时包含音频和视频
        const args = [
            '-re',
            '-stream_loop', loop ? '-1' : '0',
            '-i', this.filePath,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-ar', '44100',
            '-f', 'flv',
            'pipe:1'
        ];

        console.log('启动 ffmpeg:', 'ffmpeg', args.join(' '));
        
        this.ffmpeg = spawn('ffmpeg', args);
        
        let buffer = Buffer.alloc(0);
        let headerParsed = false;
        
        this.ffmpeg.stdout.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            
            // 解析 FLV 头部
            if (!headerParsed && buffer.length >= 9) {
                // FLV 头部: FLV + version + flags + header size
                if (buffer[0] === 0x46 && buffer[1] === 0x4C && buffer[2] === 0x56) {
                    const headerSize = buffer.readUInt32BE(5);
                    if (buffer.length >= headerSize + 4) {
                        buffer = buffer.slice(headerSize + 4); // 跳过头部和第一个 PreviousTagSize
                        headerParsed = true;
                    }
                }
            }
            
            // 解析 FLV 标签
            if (headerParsed) {
                buffer = this._parseFLVTags(buffer);
            }
        });

        this.ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            // 解析视频信息
            const sizeMatch = msg.match(/(\d+)x(\d+)/);
            if (sizeMatch) {
                this.width = parseInt(sizeMatch[1]);
                this.height = parseInt(sizeMatch[2]);
            }
            const fpsMatch = msg.match(/(\d+(?:\.\d+)?)\s*fps/);
            if (fpsMatch) {
                this.frameRate = parseFloat(fpsMatch[1]);
            }
        });

        this.ffmpeg.on('close', (code) => {
            console.log('ffmpeg 进程退出，代码:', code);
            if (this.isRunning && loop && code !== 0) {
                console.log('重新启动 ffmpeg...');
                setTimeout(() => this._startFFmpeg(loop), 1000);
            } else if (!loop || code === 0) {
                this.emit('end');
            }
        });

        this.ffmpeg.on('error', (err) => {
            console.error('ffmpeg 错误:', err);
            this.emit('error', err);
        });
    }

    /**
     * 解析 FLV 标签
     */
    _parseFLVTags(buffer) {
        while (buffer.length >= 11) { // 最小标签头部大小
            const tagType = buffer[0];
            const dataSize = (buffer[1] << 16) | (buffer[2] << 8) | buffer[3];
            const timestamp = ((buffer[7] << 24) | (buffer[4] << 16) | (buffer[5] << 8) | buffer[6]) >>> 0;
            
            const totalTagSize = 11 + dataSize + 4; // 头部 + 数据 + PreviousTagSize
            
            if (buffer.length < totalTagSize) {
                break; // 数据不完整，等待更多数据
            }
            
            const tagData = buffer.slice(11, 11 + dataSize);
            
            if (tagType === 8) { // 音频标签
                this._processAudioTag(tagData, timestamp);
            } else if (tagType === 9) { // 视频标签
                this._processVideoTag(tagData, timestamp);
            } else if (tagType === 18) { // Script 数据 (元数据)
                // 可以解析 onMetaData，但我们先跳过
            }
            
            buffer = buffer.slice(totalTagSize);
        }
        
        return buffer;
    }

    /**
     * 处理音频标签
     */
    _processAudioTag(data, timestamp) {
        if (data.length < 2) return;
        
        const soundFormat = (data[0] >> 4) & 0x0f;
        const soundRate = (data[0] >> 2) & 0x03;
        const soundSize = (data[0] >> 1) & 0x01;
        const soundType = data[0] & 0x01;
        
        if (soundFormat === 10) { // AAC
            const aacPacketType = data[1];
            const audioData = data.slice(2);
            
            if (aacPacketType === 0) { // AAC 序列头 (AudioSpecificConfig)
                this.emit('audioSequenceHeader', {
                    header: data[0],
                    config: audioData
                });
            } else if (aacPacketType === 1) { // AAC 原始数据
                this.emit('audioFrame', {
                    header: data[0],
                    data: audioData,
                    timestamp: timestamp
                });
            }
        }
    }

    /**
     * 处理视频标签
     */
    _processVideoTag(data, timestamp) {
        if (data.length < 5) return;
        
        const frameType = (data[0] >> 4) & 0x0f;
        const codecId = data[0] & 0x0f;
        
        if (codecId === 7) { // AVC (H.264)
            const avcPacketType = data[1];
            const compositionTime = ((data[2] << 16) | (data[3] << 8) | data[4]);
            // 处理有符号的 composition time
            const cts = compositionTime >= 0x800000 ? compositionTime - 0x1000000 : compositionTime;
            
            if (avcPacketType === 0) { // AVC 序列头
                const avcConfig = data.slice(5);
                console.log(`[FLV] AVC序列头, ts=${timestamp}, size=${avcConfig.length}`);
                this.emit('avcSequenceHeader', avcConfig);
            } else if (avcPacketType === 1) { // AVC NALU
                const naluData = data.slice(5);
                if (this.videoFrameCount < 5 || frameType === 1) {
                    console.log(`[FLV] 视频帧 #${this.videoFrameCount}, keyframe=${frameType===1}, ts=${timestamp}, cts=${cts}, size=${naluData.length}`);
                }
                this.videoFrameCount = (this.videoFrameCount || 0) + 1;
                this.emit('videoFrame', {
                    isKeyframe: frameType === 1,
                    data: naluData,
                    timestamp: timestamp,
                    compositionTime: cts
                });
            } else if (avcPacketType === 2) { // AVC 序列结束
                console.log('[FLV] AVC序列结束');
            }
        }
    }

    /**
     * 获取元数据
     */
    getMetadata() {
        return {
            width: this.width,
            height: this.height,
            framerate: this.frameRate,
            videocodecid: 7,
            videodatarate: 2500,
            audiocodecid: 10,
            audiodatarate: 128,
            audiosamplerate: 44100,
            audiosamplesize: 16,
            stereo: true
        };
    }
}

module.exports = MP4Reader;
