const { EventEmitter } = require('events');
const { URL } = require('url');
const Client = require('rtmp-client/lib/Client');
const NetConnection = require('rtmp-client/lib/NetConnection');
const { CLIENT } = require('rtmp-client/lib/Symbols');
const { SET_CHUNK_SIZE, WINDOW_ACKNOWLEDGEMENT_SIZE, SET_PEER_BANDWIDTH, ACKNOWLEDGEMENT, DATA_MESSAGE_AMF0, VIDEO_MESSAGE, AUDIO_MESSAGE } = require('rtmp-client/lib/MessageTypes');
const { toAMF } = require('amf-codec');
const { createLogger } = require('./shared/logger');

const log = createLogger('RTMP');

/**
 * RTMP推流客户端
 * 实现完整的RTMP建联和推流流程（到第14步：服务器响应publish）
 */
class RTMPPublisher extends EventEmitter {
    constructor(options = {}) {
        super();
        this.client = null;
        this.netConnection = null;
        this.isConnected = false;
        this.streamId = null;
        this.publishStream = null; // 保存publish stream的引用，用于发送视频数据
        // transactionId从2开始，因为connect通常使用1
        // 根据对照表：connect=1, releaseStream=2, FCPublish=3, createStream=4
        this.transactionId = 2;
        this.chunkSize = 4096;
        this.timestamp = 0; // 用于视频帧的时间戳
        
        // 帧发送状态跟踪（与 Python rtmp_connector.py 相同的逻辑）
        this.audioSent = false;  // 是否已发送过音频帧
        this.videoSent = false;  // 是否已发送过视频帧
        this.lastAudioTimestamp = 0;  // 上一个音频帧的时间戳
        this.lastVideoTimestamp = 0;  // 上一个视频帧的时间戳

        // 重连配置
        this.reconnectEnabled = options.reconnect !== false; // 默认启用重连
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10; // 最大重连次数
        this.reconnectInterval = options.reconnectInterval || 3000; // 重连间隔（毫秒）
        this.reconnectAttempts = 0; // 当前重连次数
        this.isReconnecting = false; // 是否正在重连
        this.shouldReconnect = true; // 是否应该重连（用于手动关闭时禁用）
        
        // 保存连接参数用于重连
        this._rtmpUrl = null;
        this._connectOptions = null;
        this._streamingMode = null; // 'random' 或 'custom'
        this._customStreamingCallback = null; // 自定义推流回调
    }

    /**
     * 连接到RTMP服务器并完成推流准备
     * @param {string} rtmpUrl - RTMP推流地址
     * @param {object} options - 可选参数
     */
    connect(rtmpUrl, options = {}) {
        // 保存连接参数用于重连
        this._rtmpUrl = rtmpUrl;
        this._connectOptions = options;
        this.shouldReconnect = true;

        return new Promise((resolve, reject) => {
            const url = new URL(rtmpUrl);
            log.info('url:', url);
            if (url.protocol !== 'rtmp:') {
                throw new Error('仅支持rtmp协议');
            }

            const hostname = url.hostname;
            const port = url.port || 1935;
            const pathname = url.pathname;
            const search = url.search || '';

            // 解析应用名称和流名称
            // RTMP URL格式: rtmp://host:port/app/stream?params
            const pathParts = pathname.split('/').filter(p => p);
            const app = pathParts[0] || '';
            // 流名称包含路径的剩余部分和查询参数
            const streamName = pathParts.slice(1).join('/') + search;

            if (!app) {
                throw new Error('应用名称不能为空');
            }

            // 构建tcUrl和swfUrl
            // 注意：根据NetConnection的实现，tcUrl应该包含查询参数（search）
            // 这与分析报告不同，但为了兼容性，我们使用与NetConnection相同的格式
            const tcUrl = `rtmp://${hostname}:${port}/${app}${search}`;
            const swfUrl = options.swfUrl || `rtmp://${hostname}:${port}/${app}${search}`;

            log.info('步骤1-3: 建立TCP连接...');

            // 使用NetConnection来完成connect，确保兼容性
            this.netConnection = new NetConnection();

            // 监听NetConnection的状态
            this.netConnection.onStatus = (info) => {
                log.info('NetConnection状态:', info);
                // 连接成功
                if (info.code === 'NetConnection.Connect.Success') {
                    log.info('步骤9: connect成功！');
                    // 获取内部的client
                    this.client = this.netConnection[CLIENT];

                    if (this.client) {
                        // 设置监听
                        this.setupClientListeners();
                        // 继续后续步骤
                        this.onConnectSuccess(app, tcUrl, swfUrl, streamName, options).catch((err) => {
                            log.error('onConnectSuccess处理失败:', err);
                            this.emit('error', err);
                        });
                        resolve(this.client);
                    } else {
                        log.error('无法获取内部client对象');
                        this.emit('error', new Error('无法获取内部client对象'));
                        reject(new Error('无法获取内部client对象'));
                    }
                } else if (info.level === 'error') {
                    log.error('NetConnection连接失败:', info);
                    this.emit('error', new Error(info.description || info.code));
                    reject(new Error(info.description || info.code));
                }
            };

            // 开始连接
            const connectResult = this.netConnection.connect(rtmpUrl);
            if (!connectResult) {
                throw new Error('NetConnection.connect返回false');
            }
        })
    }

    /**
     * 设置client监听器
     */
    setupClientListeners() {
        if (!this.client) return;

        // 监听控制消息
        if (this.client.controlStream) {
            log.info('设置 controlStream 监听器');
            this.client.controlStream.on('control', (messageTypeId, value, limitType) => {
                log.info('收到控制消息:', { messageTypeId, value, limitType });
                this.handleControlMessage(messageTypeId, value, limitType);
            });
        } else {
            log.info('警告: controlStream 不可用');
        }

        this.client.on('command', (name, transactionId, command, ...args) => {
            log.info(`[Client command事件] ${name}, transactionId: ${transactionId}`);
            this.handleCommand(name, transactionId, command, ...args);
        });

        // 直接监听commandStream的命令事件（用于调试）
        if (this.client.commandStream) {
            this.client.commandStream.on('command', (name, transactionId, command, ...args) => {
                log.info(`[CommandStream command事件] ${name}, transactionId: ${transactionId}, args长度: ${args.length}`);
                if (name === '_result') {
                    log.info(`收到_result响应，transactionId: ${transactionId}`);
                    log.info(`当前transactions Map中的keys:`, Array.from(this.client.commandStream.transactions.keys()));
                    if (args.length > 0) {
                        log.info(`_result参数:`, args[0]);
                    }
                }
                // invoke会自动处理transaction匹配，这里只用于日志
            });
        }

        this.client.on('close', (err) => {
            log.info('连接关闭事件触发', err ? err.message : '正常关闭');
            if (err) {
                log.error('连接关闭原因:', err);
            }
            // 检查是否有pending的请求
            if (this.client && this.client.commandStream) {
                const pendingTransactions = Array.from(this.client.commandStream.transactions.keys());
                log.info('连接关闭时，transactions Map中的keys:', pendingTransactions);
                log.info('连接关闭时，commandStream当前transactionId:', this.client.commandStream.transactionId);
                if (pendingTransactions.length > 0) {
                    log.error('警告：连接关闭时仍有pending的请求:', pendingTransactions);
                }
            }
            // 检查socket状态
            if (this.client && this.client.socket) {
                log.info('连接关闭时，socket状态:', {
                    destroyed: this.client.socket.destroyed,
                    readable: this.client.socket.readable,
                    writable: this.client.socket.writable
                });
            }
            // 检查NetConnection状态
            if (this.netConnection) {
                log.info('连接关闭时，NetConnection.isConnected:', this.netConnection.isConnected);
            }
            this.isConnected = false;
            this.emit('close', err);

            // 触发重连
            if (this.reconnectEnabled && this.shouldReconnect && !this.isReconnecting) {
                this._tryReconnect();
            }
        });

        this.client.on('error', (err) => {
            log.error('Client错误:', err);
            this.emit('error', err);
        });
    }

    /**
     * connect成功后的处理
     */
    async onConnectSuccess(app, tcUrl, swfUrl, streamName, options) {
        try {
            log.info('步骤4-6: RTMP握手完成');

            // 等待一小段时间确保controlStream和commandStream已初始化
            await new Promise(resolve => setImmediate(resolve));

            // 注意：controlStream 监听器已在 setupClientListeners 中设置，这里不重复注册

            // 步骤7: 发送 Set Chunk Size (必须发送，ffmpeg 也发送了)
            // 注意：rtmp-client 库内部硬编码了 CHUNK_SIZE=128，必须与库保持一致
            // 如果要改成 4096 需要同时修改 node_modules/rtmp-client/lib/ChunkStream/ChunkConstants.js
            log.info('步骤7: 发送 Set Chunk Size (128字节)');
            this.setChunkSize(128);

            // 等待一小段时间，让服务器可能发送的控制消息先到达
            await new Promise(resolve => setTimeout(resolve, 200));

            // connect已经由NetConnection完成，跳过步骤8-9
            log.info('步骤8-9: connect命令已由NetConnection完成');

            // 步骤10: 发送releaseStream
            log.info('步骤10: 发送releaseStream');
            this.sendReleaseStream(streamName);
     

            // 等待一小段时间，确保releaseStream被发送
            // 虽然releaseStream通常不需要响应，但服务器可能会发送_result
            await new Promise(resolve => setTimeout(resolve, 100));

            // 步骤11: 发送FCPublish、createStream 和 _checkbw
            log.info('步骤11: 发送FCPublish、createStream 和 _checkbw');

            // 发送FCPublish，但不等待响应（因为它通常不需要响应）
            this.sendFCPublish(streamName)

            // 立即发送createStream，不等待FCPublish完成
            // 使用setImmediate确保在同一个事件循环中发送，可能被合并到同一个包中
            await new Promise(resolve => setImmediate(resolve));

            try {
                log.info('等待createStream响应...');
                // createStream 不需要 streamName 参数（与 Python 版本一致）
                const createStreamResult = await this.sendCreateStream();
                
                // 发送 _checkbw 命令（某些服务器需要）
                this.sendCheckBW();
                log.info('步骤12: 收到createStream响应', createStreamResult);

                // 提取Stream ID
                // 从对照表看，createStream _result返回的是流ID（数字）
                // result格式: [command, streamId]，command通常是null，streamId是数字
                if (createStreamResult && createStreamResult.length > 1) {
                    // result[0]是command对象（null），result[1]是stream ID
                    this.streamId = createStreamResult[1];
                    log.info(`分配的Stream ID: ${this.streamId}`);
                } else if (createStreamResult && createStreamResult.length > 0) {
                    // 备用：如果格式不同，尝试第一个元素
                    this.streamId = createStreamResult[0];
                    log.info(`分配的Stream ID (备用): ${this.streamId}`);
                } else {
                    throw new Error('未收到有效的Stream ID');
                }
            } catch (error) {
                log.error('createStream失败:', error);
                throw error;
            }

            // 步骤13: 发送publish命令
            log.info('步骤13: 发送publish命令');
            this.sendPublish(streamName, options.publishType || 'live');

            // 步骤14: 等待服务器响应onStatus (NetStream.Publish.Start)
            // 这个响应会通过handleCommand方法处理
            log.info('等待服务器响应publish状态...');
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * 步骤7: 设置Chunk Size
     */
    setChunkSize(size) {
        const chunkSizeBuffer = Buffer.allocUnsafe(4);
        chunkSizeBuffer.writeUInt32BE(size, 0);

        // 使用controlStream发送Set Chunk Size消息
        // Chunk Stream ID 2用于控制消息
        if (this.client && this.client.controlStream) {
            this.client.controlStream.send(SET_CHUNK_SIZE, chunkSizeBuffer);
            this.chunkSize = size;
        } else {
            log.warn('controlStream未就绪，稍后重试');
            setTimeout(() => this.setChunkSize(size), 100);
        }
    }

    /**
     * 步骤10: 发送releaseStream命令
     * 根据 Python 版本，使用 transactionId = 2
     */
    sendReleaseStream(streamName) {
        // 使用 transactionId = 2（与 Python 版本一致）
        this.client.command('releaseStream', 2, null, streamName);
    }

    /**
     * 步骤11: 发送FCPublish命令
     * 根据 Python 版本，使用 transactionId = 3
     */
    sendFCPublish(streamName) {
        // 使用 transactionId = 3（与 Python 版本一致）
        this.client.command('FCPublish', 3, null, streamName);
    }

    /**
     * 步骤11: 发送createStream命令
     * 根据 Python 版本，使用 transactionId = 4
     * 注意：这里不使用 invoke，而是手动管理 transactionId
     */
    sendCreateStream(streamName) {
        // 使用 transactionId = 4（与 Python 版本一致）
        return this.client.invoke('createStream', null);
    }

    /**
     * 发送 _checkbw 命令（带宽检测）
     * 根据 Python 版本，使用 transactionId = 5
     */
    sendCheckBW() {
        // 使用 transactionId = 5（与 Python 版本一致）
        this.client.command('_checkbw', 5, null);
        log.info('发送 _checkbw 命令，transactionId: 5');
    }

    /**
     * 步骤13: 发送publish命令
     * 根据 Python 版本，publish 使用 transactionId = 5
     * 注意：某些服务器（如抖音）可能需要非零的 transactionId
     */
    sendPublish(streamName, publishType = 'live') {
        // publish命令需要使用特定的stream ID
        // 我们需要创建一个新的MessageStream用于发布
        this.publishStream = this.client.createStream(this.streamId);

        // 监听publish stream的命令
        this.publishStream.on('command', (name, transId, command, ...args) => {
            if (name === 'onStatus') {
                const statusInfo = args[0];
                if (statusInfo && statusInfo.code === 'NetStream.Publish.Start') {
                    log.info('步骤14: 收到onStatus响应 - NetStream.Publish.Start');
                    log.info('发布状态:', statusInfo);
                    this.isConnected = true;
                    log.info('触发publishStart事件...');
                    this.emit('publishStart', statusInfo);
                    log.info('publishStart事件已触发');
                } else if (statusInfo) {
                    log.info('收到onStatus:', statusInfo);
                    this.emit('status', statusInfo);
                }
            }
        });

        // 发送publish命令
        // publish命令格式: command name, transaction ID, command object (null), stream name, publish type
        // 根据 Python 版本，使用 transactionId = 5
        log.info(`发送 publish 命令: streamName=${streamName.substring(0, 50)}..., publishType=${publishType}`);
        this.publishStream.command('publish', 5, null, streamName, publishType);
    }

    /**
     * 发送onMetaData（元数据）
     */
    sendMetaData() {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        const metadata = {
            '@setDataFrame': 'onMetaData',
            width: 640,
            height: 480,
            videodatarate: 250,
            framerate: 30,
            videocodecid: 7, // H.264
            audiocodecid: 10, // AAC
            audiodatarate: 128,
            audiosamplerate: 44100,
            audiosamplesize: 16,
            stereo: true,
            encoder: 'RTMP Publisher Test'
        };

        // 构建AMF0编码的元数据
        const metadataBuffer = Buffer.concat([
            toAMF('@setDataFrame'),
            toAMF('onMetaData'),
            toAMF(metadata)
        ]);

        this.publishStream.send(DATA_MESSAGE_AMF0, metadataBuffer);
        log.info('已发送onMetaData');
    }

    /**
     * 发送 AVC 序列头（H.264 解码配置信息）
     * 包含 SPS 和 PPS，必须在发送视频帧之前发送
     */
    sendAVCSequenceHeader() {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        // AVC Sequence Header 格式:
        // [FrameType(4bits) + CodecID(4bits)] + [AVCPacketType] + [CompositionTime(3bytes)] + [AVCDecoderConfigurationRecord]
        
        // 简单的 SPS (Sequence Parameter Set) - 640x480 baseline profile
        const sps = Buffer.from([
            0x67, 0x42, 0x00, 0x1e, 0x96, 0x52, 0x02, 0x83, 0xf6, 0x02, 0xa1, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x03, 0x00, 0x30, 0x8f, 0x16, 0x2e, 0x48
        ]);
        
        // 简单的 PPS (Picture Parameter Set)
        const pps = Buffer.from([0x68, 0xce, 0x06, 0xe2]);

        // AVCDecoderConfigurationRecord
        const avcConfig = Buffer.concat([
            Buffer.from([
                0x01,             // configurationVersion
                sps[1],           // AVCProfileIndication
                sps[2],           // profile_compatibility
                sps[3],           // AVCLevelIndication
                0xff,             // lengthSizeMinusOne (4 bytes NAL length)
                0xe1,             // numOfSequenceParameterSets (1)
            ]),
            Buffer.from([(sps.length >> 8) & 0xff, sps.length & 0xff]), // SPS length
            sps,
            Buffer.from([0x01]), // numOfPictureParameterSets (1)
            Buffer.from([(pps.length >> 8) & 0xff, pps.length & 0xff]), // PPS length
            pps
        ]);

        // FLV Video Tag 格式
        const videoTag = Buffer.concat([
            Buffer.from([
                0x17,             // FrameType=1(keyframe) + CodecID=7(AVC)
                0x00,             // AVCPacketType=0 (AVC sequence header)
                0x00, 0x00, 0x00  // CompositionTime=0
            ]),
            avcConfig
        ]);

        this.publishStream.send(VIDEO_MESSAGE, videoTag);
        log.info('已发送 AVC 序列头');
    }

    /**
     * 发送测试视频帧
     * @param {boolean} isKeyframe - 是否为关键帧
     */
    sendTestVideoFrame(isKeyframe = false) {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        // 每隔30帧发送一个关键帧
        if (this.timestamp % 1000 < 33) {
            isKeyframe = true;
        }

        // FLV Video Tag 格式:
        // [FrameType(4bits) + CodecID(4bits)] + [AVCPacketType] + [CompositionTime(3bytes)] + [NAL Unit Data]
        
        const frameType = isKeyframe ? 1 : 2; // 1=keyframe, 2=inter frame
        const codecId = 7; // AVC (H.264)

        // 创建一个简单的 NAL 单元
        // IDR slice (keyframe) 或 Non-IDR slice (P-frame)
        const nalType = isKeyframe ? 0x65 : 0x41; // 5=IDR, 1=non-IDR
        const nalData = Buffer.from([
            nalType,
            0x88, 0x84, 0x00, 0x33, 0xff  // 简化的slice数据
        ]);

        // NAL Unit Length (4 bytes, big-endian)
        const nalLength = Buffer.allocUnsafe(4);
        nalLength.writeUInt32BE(nalData.length, 0);

        const videoTag = Buffer.concat([
            Buffer.from([
                (frameType << 4) | codecId, // FrameType + CodecID
                0x01,                        // AVCPacketType=1 (AVC NALU)
                0x00, 0x00, 0x00             // CompositionTime=0
            ]),
            nalLength,
            nalData
        ]);

        this.publishStream.send(VIDEO_MESSAGE, videoTag);
        this.timestamp += 33;
    }

    /**
     * 发送真实视频帧（从 MP4 提取的 NAL 单元）
     * @param {Buffer} nalUnit - NAL 单元数据
     * @param {boolean} isKeyframe - 是否为关键帧
     * @param {number} compositionTime - 组合时间偏移
     */
    sendVideoFrame(nalUnit, isKeyframe = false, compositionTime = 0) {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        const frameType = isKeyframe ? 1 : 2;
        const codecId = 7; // AVC (H.264)

        // NAL Unit Length (4 bytes, big-endian)
        const nalLength = Buffer.allocUnsafe(4);
        nalLength.writeUInt32BE(nalUnit.length, 0);

        // 组合时间偏移 (3 bytes, big-endian, signed)
        const ctsBuf = Buffer.allocUnsafe(3);
        ctsBuf.writeUIntBE(compositionTime & 0xffffff, 0, 3);

        const videoTag = Buffer.concat([
            Buffer.from([
                (frameType << 4) | codecId,
                0x01  // AVCPacketType=1 (AVC NALU)
            ]),
            ctsBuf,
            nalLength,
            nalUnit
        ]);

        this.publishStream.send(VIDEO_MESSAGE, videoTag);
        this.timestamp += Math.round(1000 / 30);
    }

    /**
     * 发送 AVC 序列头（从 MP4 提取的配置）
     * @param {Buffer} avcConfig - AVCDecoderConfigurationRecord
     */
    sendAVCConfig(avcConfig) {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        const videoTag = Buffer.concat([
            Buffer.from([
                0x17,             // FrameType=1(keyframe) + CodecID=7(AVC)
                0x00,             // AVCPacketType=0 (AVC sequence header)
                0x00, 0x00, 0x00  // CompositionTime=0
            ]),
            avcConfig
        ]);

        this.publishStream.send(VIDEO_MESSAGE, videoTag, 0);
        log.info('已发送 AVC 配置');
    }

    /**
     * 发送自定义元数据
     * @param {object} metadata - 元数据对象
     */
    sendCustomMetaData(metadata) {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        const fullMetadata = {
            '@setDataFrame': 'onMetaData',
            ...metadata,
            encoder: 'RTMP Publisher'
        };

        const metadataBuffer = Buffer.concat([
            toAMF('@setDataFrame'),
            toAMF('onMetaData'),
            toAMF(fullMetadata)
        ]);

        this.publishStream.send(DATA_MESSAGE_AMF0, metadataBuffer, 0);
        log.info('已发送自定义元数据');
    }

    /**
     * 发送 AAC 音频序列头
     * @param {number} header - 音频头部字节
     * @param {Buffer} config - AudioSpecificConfig
     */
    sendAudioSequenceHeader(header, config) {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        const audioTag = Buffer.concat([
            Buffer.from([header]),      // 音频头
            Buffer.from([0x00]),        // AAC Packet Type = 0 (sequence header)
            config                       // AudioSpecificConfig
        ]);

        this.publishStream.send(AUDIO_MESSAGE, audioTag, 0);
        log.info('已发送 AAC 序列头');
    }

    /**
     * 发送 AAC 音频帧
     * 使用与 Python rtmp_connector.py 相同的逻辑：
     * - 第一帧使用 timestamp=0
     * - 后续帧使用 timestamp=delta（时间戳增量）
     * @param {number} header - 音频头部字节
     * @param {Buffer} data - AAC 音频数据
     * @param {number} timestamp - 时间戳（毫秒）
     */
    sendAudioFrame(header, data, timestamp = 0) {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        const audioTag = Buffer.concat([
            Buffer.from([header]),      // 音频头
            Buffer.from([0x01]),        // AAC Packet Type = 1 (raw data)
            data                         // AAC 原始数据
        ]);

        // 与 Python rtmp_connector.py 相同的逻辑：
        // 第一帧使用 timestamp=0，后续帧使用 delta
        let actualTimestamp;
        if (!this.audioSent) {
            actualTimestamp = 0;
            this.audioSent = true;
            this.lastAudioTimestamp = timestamp;
        } else {
            // 计算时间戳增量
            actualTimestamp = timestamp - this.lastAudioTimestamp;
            if (actualTimestamp < 0) actualTimestamp = 0;
            this.lastAudioTimestamp = timestamp;
        }

        this.publishStream.send(AUDIO_MESSAGE, audioTag, actualTimestamp);
    }

    /**
     * 发送 FLV 格式的视频帧（已封装好的）
     * 使用与 Python rtmp_connector.py 相同的逻辑：
     * - 第一帧使用 timestamp=0
     * - 后续帧使用 timestamp=delta（时间戳增量）
     * @param {Buffer} data - 完整的 FLV 视频标签数据（不含标签头）
     * @param {boolean} isKeyframe - 是否为关键帧
     * @param {number} timestamp - 时间戳（毫秒）
     */
    sendFLVVideoFrame(data, isKeyframe = false, timestamp = 0) {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        // 与 Python rtmp_connector.py 相同的逻辑：
        // 第一帧使用 timestamp=0，后续帧使用 delta
        let actualTimestamp;
        if (!this.videoSent) {
            actualTimestamp = 0;
            this.videoSent = true;
            this.lastVideoTimestamp = timestamp;
        } else {
            // 计算时间戳增量
            actualTimestamp = timestamp - this.lastVideoTimestamp;
            if (actualTimestamp < 0) actualTimestamp = 0;
            this.lastVideoTimestamp = timestamp;
        }

        this.publishStream.send(VIDEO_MESSAGE, data, actualTimestamp);
    }

    /**
     * 发送随机音频数据（与 Python rtmp_connector.py 相同的逻辑）
     * - Control byte: 0xaf (HE-AAC 44 kHz 16 bit stereo)
     * - 随机数据：3字节
     * - 时间戳增量：23ms
     */
    sendRandomAudioData() {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        // 音频数据格式：Control byte + 音频数据
        // Control byte: 0xaf (HE-AAC 44 kHz 16 bit stereo)
        const audioControl = 0xaf;
        // 随机3字节音频数据
        const audioData = Buffer.alloc(3);
        for (let i = 0; i < 3; i++) {
            audioData[i] = Math.floor(Math.random() * 256);
        }

        const audioTag = Buffer.concat([
            Buffer.from([audioControl]),
            audioData
        ]);

        // 与 Python 相同的逻辑：第一帧 timestamp=0，后续帧使用 delta
        let actualTimestamp;
        if (!this.audioSent) {
            actualTimestamp = 0;
            this.audioSent = true;
            this.lastAudioTimestamp = 0;
            log.info(`发送第一帧随机音频数据 (timestamp=0, size=${audioTag.length})`);
        } else {
            // 时间戳增量：23ms (44.1kHz采样率，每帧约1024样本)
            actualTimestamp = 23;
            this.lastAudioTimestamp += 23;
        }

        this.publishStream.send(AUDIO_MESSAGE, audioTag, actualTimestamp);
    }

    /**
     * 发送随机视频数据（与 Python rtmp_connector.py 相同的逻辑）
     * - Control byte: 0x17 (keyframe) 或 0x27 (interframe)
     * - 随机数据：100字节
     * - 时间戳增量：33ms (30fps)
     */
    sendRandomVideoData() {
        if (!this.publishStream) {
            throw new Error('publishStream不可用');
        }

        // 视频数据格式：Control byte + 视频数据
        // 第一帧是关键帧
        const isKeyframe = !this.videoSent;
        const videoControl = isKeyframe ? 0x17 : 0x27;
        
        // 随机100字节视频数据
        const videoData = Buffer.alloc(100);
        for (let i = 0; i < 100; i++) {
            videoData[i] = Math.floor(Math.random() * 256);
        }

        const videoTag = Buffer.concat([
            Buffer.from([videoControl]),
            videoData
        ]);

        // 与 Python 相同的逻辑：第一帧 timestamp=0，后续帧使用 delta
        let actualTimestamp;
        if (!this.videoSent) {
            actualTimestamp = 0;
            this.videoSent = true;
            this.lastVideoTimestamp = 0;
            log.info(`发送第一帧随机视频数据 (timestamp=0, keyframe=${isKeyframe}, size=${videoTag.length})`);
        } else {
            // 时间戳增量：33ms (30fps)
            actualTimestamp = 33;
            this.lastVideoTimestamp += 33;
        }

        this.publishStream.send(VIDEO_MESSAGE, videoTag, actualTimestamp);
    }

    /**
     * 开始推送随机音视频数据（与 Python rtmp_connector.py 相同的逻辑）
     * 每秒发送一次音视频数据
     */
    startRandomStreaming() {
        if (!this.publishStream) {
            throw new Error('publishStream不可用，请先完成publish');
        }

        // 设置推流模式，用于重连后恢复
        this._streamingMode = 'random';

        // 如果是重连成功，标记重连完成
        if (this.isReconnecting) {
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            log.info('重连成功，恢复推流！');
            this.emit('reconnected');
        }

        log.info('开始推送随机音视频数据...');
        log.info(`Stream ID: ${this.streamId}`);

        // 先发送元数据
        log.info('发送 onMetaData...');
        this.sendMetaData();
        log.info('onMetaData 发送成功，等待1秒后开始推流音视频数据...');

        // 等待1秒后开始推流
        setTimeout(() => {
            let frameCount = 0;
            this._streamingInterval = setInterval(() => {
                try {
                    // 发送随机音频数据
                    this.sendRandomAudioData();
                    
                    // 发送随机视频数据
                    this.sendRandomVideoData();
                    
                    frameCount++;
                    if (frameCount % 10 === 0) {
                        log.info(`已推流 ${frameCount} 帧`);
                    }
                } catch (error) {
                    log.error('发送音视频数据失败:', error);
                    this.stopRandomStreaming();
                }
            }, 1000); // 每秒发送一次
        }, 1000);
    }

    /**
     * 停止推送随机音视频数据
     */
    stopRandomStreaming() {
        if (this._streamingInterval) {
            clearInterval(this._streamingInterval);
            this._streamingInterval = null;
            log.info('已停止推送随机音视频数据');
        }
        // 重置状态
        this.audioSent = false;
        this.videoSent = false;
        this.lastAudioTimestamp = 0;
        this.lastVideoTimestamp = 0;
    }

    /**
     * 开始发送测试视频数据
     * @param {number} duration - 发送持续时间（秒），默认5秒
     * @param {number} fps - 帧率，默认30fps
     */
    startSendingTestVideo(duration = 5, fps = 30) {
        log.info('startSendingTestVideo被调用');
        if (!this.publishStream) {
            log.error('publishStream不可用');
            throw new Error('publishStream不可用，请先完成publish');
        }

        log.info(`\n开始发送测试视频数据，持续${duration}秒，帧率${fps}fps...`);

        // 先发送元数据
        try {
            this.sendMetaData();
        } catch (error) {
            log.error('发送元数据失败:', error);
            throw error;
        }

        // 计算帧间隔（毫秒）
        const frameInterval = 1000 / fps;
        let frameCount = 0;
        const maxFrames = duration * fps;

        const sendFrame = () => {
            if (frameCount >= maxFrames) {
                log.info(`\n已发送${frameCount}帧测试视频数据`);
                return;
            }

            try {
                this.sendTestVideoFrame();
                frameCount++;

                // 继续发送下一帧
                setTimeout(sendFrame, frameInterval);
            } catch (error) {
                log.error('发送视频帧失败:', error);
            }
        };

        // 开始发送
        sendFrame();
    }

    /**
     * 处理控制消息
     */
    handleControlMessage(messageTypeId, value, limitType) {
        switch (messageTypeId) {
            case WINDOW_ACKNOWLEDGEMENT_SIZE:
                log.info(`收到Window Acknowledgement Size: ${value}`);
                // 记录窗口大小，但不需要立即响应
                this.windowAckSize = value;
                this.bytesReceived = 0;
                break;
            case SET_PEER_BANDWIDTH:
                log.info(`收到Set Peer Bandwidth: ${value}, limitType: ${limitType}`);
                // 如果limitType是2，需要发送Window Acknowledgement Size响应
                if (limitType === 2 && this.windowAckSize) {
                    this.sendWindowAckSize(this.windowAckSize);
                }
                break;
            case SET_CHUNK_SIZE:
                log.info(`服务器设置Chunk Size: ${value}`);
                break;
            default:
                log.info(`未知控制消息类型: ${messageTypeId}, 值: ${value}`);
        }
    }

    /**
     * 发送Window Acknowledgement Size响应
     */
    sendWindowAckSize(size) {
        if (this.client && this.client.controlStream) {
            const buffer = Buffer.allocUnsafe(4);
            buffer.writeUInt32BE(size, 0);
            this.client.controlStream.send(WINDOW_ACKNOWLEDGEMENT_SIZE, buffer);
            log.info(`发送Window Acknowledgement Size响应: ${size}`);
        }
    }

    /**
     * 处理服务器命令
     */
    handleCommand(name, transactionId, command, ...args) {
        log.info(`收到服务器命令: ${name}`, { transactionId, command, args: args.length > 0 ? args : '无参数' });

        if (name === 'onStatus') {
            const statusInfo = args[0];
            if (statusInfo) {
                log.info('状态信息:', JSON.stringify(statusInfo, null, 2));
                // 检查是否是错误状态
                if (statusInfo.level === 'error' || statusInfo.code && statusInfo.code.includes('Failed')) {
                    log.error('收到错误状态:', statusInfo);
                    this.emit('error', new Error(statusInfo.description || statusInfo.code));
                }
                if (statusInfo.code === 'NetStream.Publish.Start') {
                    this.emit('publishStart', statusInfo);
                }
                this.emit('status', statusInfo);
            }
        } else if (name === '_error') {
            log.error('收到_error命令:', args);
            const errorInfo = args[0] || {};
            this.emit('error', new Error(errorInfo.description || errorInfo.code || '服务器返回错误'));
        }
    }

    /**
     * 关闭连接（不触发重连）
     */
    close() {
        this.shouldReconnect = false; // 手动关闭时禁用重连
        this.stopRandomStreaming();
        if (this.client) {
            this.client.close();
            this.client = null;
        }
        this.isConnected = false;
    }

    /**
     * 重置连接状态（用于重连前）
     */
    _resetState() {
        this.client = null;
        this.netConnection = null;
        this.isConnected = false;
        this.streamId = null;
        this.publishStream = null;
        this.transactionId = 2;
        this.audioSent = false;
        this.videoSent = false;
        this.lastAudioTimestamp = 0;
        this.lastVideoTimestamp = 0;
        this.stopRandomStreaming();
    }

    /**
     * 尝试重连
     */
    async _tryReconnect() {
        if (!this.reconnectEnabled || !this.shouldReconnect) {
            log.info('重连已禁用');
            return;
        }

        if (this.isReconnecting) {
            log.info('已经在重连中，跳过');
            return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.error(`已达到最大重连次数 (${this.maxReconnectAttempts})，停止重连`);
            this.emit('reconnectFailed', { attempts: this.reconnectAttempts });
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;
        
        log.info(`\n========================================`);
        log.info(`开始第 ${this.reconnectAttempts}/${this.maxReconnectAttempts} 次重连...`);
        log.info(`等待 ${this.reconnectInterval / 1000} 秒后重连...`);
        log.info(`========================================\n`);

        this.emit('reconnecting', { 
            attempt: this.reconnectAttempts, 
            maxAttempts: this.maxReconnectAttempts,
            interval: this.reconnectInterval
        });

        // 等待重连间隔
        await new Promise(resolve => setTimeout(resolve, this.reconnectInterval));

        if (!this.shouldReconnect) {
            log.info('重连已被取消');
            this.isReconnecting = false;
            return;
        }

        try {
            // 重置状态
            this._resetState();

            // 重新连接
            log.info('正在重新连接...');
            await this.connect(this._rtmpUrl, this._connectOptions);
            
            // 连接成功，等待 publishStart 事件后再恢复推流
            // publishStart 事件会在 sendPublish 的回调中触发
            log.info('重连成功！等待推流就绪...');
            
        } catch (error) {
            log.error('重连失败:', error.message);
            this.isReconnecting = false;
            
            // 继续尝试重连
            if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                this._tryReconnect();
            } else {
                this.emit('reconnectFailed', { attempts: this.reconnectAttempts, error });
            }
        }
    }

    /**
     * 重连成功后恢复推流
     */
    _onReconnectSuccess() {
        log.info('重连成功！');
        this.isReconnecting = false;
        this.reconnectAttempts = 0; // 重置重连计数

        this.emit('reconnected', { attempts: this.reconnectAttempts });

        // 恢复推流
        if (this._streamingMode === 'random') {
            log.info('恢复随机数据推流...');
            this.startRandomStreaming();
        } else if (this._streamingMode === 'custom' && this._customStreamingCallback) {
            log.info('恢复自定义推流...');
            this._customStreamingCallback();
        }
    }

    /**
     * 设置推流模式（用于重连后恢复）
     * @param {string} mode - 'random' 或 'custom'
     * @param {Function} callback - 自定义推流回调（仅当 mode 为 'custom' 时使用）
     */
    setStreamingMode(mode, callback = null) {
        this._streamingMode = mode;
        this._customStreamingCallback = callback;
    }

    /**
     * 停止重连
     */
    stopReconnect() {
        this.shouldReconnect = false;
        this.isReconnecting = false;
        log.info('重连已停止');
    }
}

module.exports = RTMPPublisher;

