const RTMPPublisher = require("./rtmp-publisher");
const MP4Reader = require("./mp4-reader");
const path = require("path");
const os = require("os");
const fs = require("fs");
const readline = require("readline");
const { createLogger } = require("./shared/logger");

// 创建日志器
const log = createLogger("推流");

// 全局变量，用于 SIGINT 处理
let globalPublisher = null;

// ========== 网络抖动模拟配置 ==========
const JITTER_CONFIG = {
  enabled: true,              // 是否启用网络抖动模拟
  minDelay: 0,                // 最小延迟（毫秒）
  maxDelay: 100,              // 最大延迟（毫秒）
  burstProbability: 0.1,      // 突发发送的概率（累积多帧后一次性发送）
  burstMaxFrames: 5,          // 突发发送时最多累积的帧数
  pauseProbability: 0.05,     // 暂停的概率（模拟网络卡顿）
  pauseMinDuration: 200,      // 暂停最小时长（毫秒）
  pauseMaxDuration: 800,      // 暂停最大时长（毫秒）
  logJitter: true,            // 是否输出抖动日志
};

// 帧缓冲区（用于突发发送模式）
let videoFrameBuffer = [];
let audioFrameBuffer = [];
let isBurstMode = false;
let isPaused = false;

/**
 * 生成随机延迟
 */
function getRandomDelay() {
  return Math.random() * (JITTER_CONFIG.maxDelay - JITTER_CONFIG.minDelay) + JITTER_CONFIG.minDelay;
}

/**
 * 生成随机暂停时长
 */
function getRandomPauseDuration() {
  return Math.random() * (JITTER_CONFIG.pauseMaxDuration - JITTER_CONFIG.pauseMinDuration) + JITTER_CONFIG.pauseMinDuration;
}

/**
 * 延迟执行
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带抖动的发送视频帧
 */
async function sendVideoFrameWithJitter(publisher, videoTag, isKeyframe, timestamp) {
  if (!JITTER_CONFIG.enabled) {
    publisher.sendFLVVideoFrame(videoTag, isKeyframe, timestamp);
    return;
  }

  // 随机决定是否进入暂停模式
  if (!isPaused && Math.random() < JITTER_CONFIG.pauseProbability) {
    isPaused = true;
    const pauseDuration = getRandomPauseDuration();
    if (JITTER_CONFIG.logJitter) {
      log.warn(`[抖动] 网络卡顿模拟，暂停 ${Math.round(pauseDuration)}ms`);
    }
    await delay(pauseDuration);
    isPaused = false;
  }

  // 随机决定是否进入突发模式（累积帧）
  if (!isBurstMode && Math.random() < JITTER_CONFIG.burstProbability) {
    isBurstMode = true;
    videoFrameBuffer.push({ videoTag, isKeyframe, timestamp });
    
    if (JITTER_CONFIG.logJitter) {
      log.info(`[抖动] 进入突发模式，累积帧...`);
    }
    return;
  }

  // 如果在突发模式中
  if (isBurstMode) {
    videoFrameBuffer.push({ videoTag, isKeyframe, timestamp });
    
    // 达到最大帧数或随机决定释放
    if (videoFrameBuffer.length >= JITTER_CONFIG.burstMaxFrames || Math.random() > 0.7) {
      if (JITTER_CONFIG.logJitter) {
        log.info(`[抖动] 突发发送 ${videoFrameBuffer.length} 个视频帧`);
      }
      
      // 快速发送所有缓冲的帧
      for (const frame of videoFrameBuffer) {
        publisher.sendFLVVideoFrame(frame.videoTag, frame.isKeyframe, frame.timestamp);
      }
      videoFrameBuffer = [];
      isBurstMode = false;
    }
    return;
  }

  // 正常模式：添加随机延迟
  const jitterDelay = getRandomDelay();
  if (jitterDelay > 10 && JITTER_CONFIG.logJitter) {
    log.debug(`[抖动] 视频帧延迟 ${Math.round(jitterDelay)}ms, ts=${timestamp}`);
  }
  await delay(jitterDelay);
  publisher.sendFLVVideoFrame(videoTag, isKeyframe, timestamp);
}

/**
 * 带抖动的发送音频帧
 */
async function sendAudioFrameWithJitter(publisher, header, data, timestamp) {
  if (!JITTER_CONFIG.enabled) {
    publisher.sendAudioFrame(header, data, timestamp);
    return;
  }

  // 如果视频在暂停，音频也暂停
  if (isPaused) {
    audioFrameBuffer.push({ header, data, timestamp });
    return;
  }

  // 发送缓冲的音频帧
  if (audioFrameBuffer.length > 0) {
    if (JITTER_CONFIG.logJitter) {
      log.info(`[抖动] 释放 ${audioFrameBuffer.length} 个缓冲音频帧`);
    }
    for (const frame of audioFrameBuffer) {
      publisher.sendAudioFrame(frame.header, frame.data, frame.timestamp);
    }
    audioFrameBuffer = [];
  }

  // 音频帧添加较小的随机延迟（保持音频相对稳定）
  const jitterDelay = getRandomDelay() * 0.5;
  if (jitterDelay > 5) {
    await delay(jitterDelay);
  }
  publisher.sendAudioFrame(header, data, timestamp);
}

// 获取 home 目录下的 .rtmp_node/mp4 目录
const rtmpNodeDir = path.join(os.homedir(), ".rtmp_node");
const mp4Dir = path.join(rtmpNodeDir, "mp4");

// 确保目录存在
function ensureDirectories() {
  if (!fs.existsSync(rtmpNodeDir)) {
    fs.mkdirSync(rtmpNodeDir, { recursive: true });
    log.info("创建目录:", rtmpNodeDir);
  }
  if (!fs.existsSync(mp4Dir)) {
    fs.mkdirSync(mp4Dir, { recursive: true });
    log.info("创建目录:", mp4Dir);
  }
}

// 命令行输入提示
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// 等待用户按键后退出
async function waitAndExit(code = 1) {
  log.info("按回车键退出...");
  await prompt("");
  process.exit(code);
}

/**
 * RTMP推流示例
 * 循环读取 MP4 文件并推流（包含音频和视频）
 */
async function main() {
  // 确保目录存在
  ensureDirectories();

  // 从命令行输入获取 rtmpUrl 和 mp4 文件名
  const rtmpUrl = await prompt("请输入 RTMP 推流地址: ");
  if (!rtmpUrl) {
    log.error("RTMP 地址不能为空！");
    await waitAndExit(1);
  }

  const mp4FileName = await prompt("请输入 MP4/FLV 文件名: ");
  if (!mp4FileName) {
    log.error("文件名不能为空！");
    await waitAndExit(1);
  }

  const mp4File = path.join(mp4Dir, mp4FileName);

  // 检查文件是否存在
  if (!fs.existsSync(mp4File)) {
    log.error("文件不存在:", mp4File);
    log.info("请将媒体文件放到目录:", mp4Dir);
    await waitAndExit(1);
  }

  // 询问是否启用网络抖动模拟
  const enableJitter = await prompt("是否启用网络抖动模拟？(y/n, 默认n): ");
  JITTER_CONFIG.enabled = enableJitter.toLowerCase() === 'y' || enableJitter.toLowerCase() === 'yes';
  
  if (JITTER_CONFIG.enabled) {
    log.info("网络抖动模拟已启用！");
    log.info("抖动配置:");
    log.info(`  - 延迟范围: ${JITTER_CONFIG.minDelay}ms ~ ${JITTER_CONFIG.maxDelay}ms`);
    log.info(`  - 突发概率: ${(JITTER_CONFIG.burstProbability * 100).toFixed(0)}%`);
    log.info(`  - 暂停概率: ${(JITTER_CONFIG.pauseProbability * 100).toFixed(0)}%`);
    log.info(`  - 暂停时长: ${JITTER_CONFIG.pauseMinDuration}ms ~ ${JITTER_CONFIG.pauseMaxDuration}ms`);
  } else {
    log.info("网络抖动模拟已禁用，将使用稳定帧间隔推流");
  }

  // 创建 RTMPPublisher，配置重连参数
  const publisher = new RTMPPublisher({
    reconnect: true, // 启用重连
    maxReconnectAttempts: 10, // 最大重连次数
    reconnectInterval: 3000, // 重连间隔（毫秒）
  });
  globalPublisher = publisher; // 保存到全局变量
  const mp4Reader = new MP4Reader(mp4File);

  let videoFrameCount = 0;
  let audioFrameCount = 0;
  let avcConfigSent = false;
  let audioConfigSent = false;

  // 监听 AVC 序列头
  mp4Reader.on("avcSequenceHeader", (avcConfig) => {
    if (publisher.publishStream) {
      log.info("发送 AVC 序列头...");
      publisher.sendAVCConfig(avcConfig);
      avcConfigSent = true;
    }
  });

  // 监听视频帧
  mp4Reader.on("videoFrame", async (frame) => {
    if (!publisher.publishStream) return;

    try {
      // 直接发送 FLV 格式的视频数据
      const videoTag = Buffer.concat([
        Buffer.from([frame.isKeyframe ? 0x17 : 0x27]), // FrameType + CodecID
        Buffer.from([0x01]), // AVC NALU
        Buffer.from([
          (frame.compositionTime >> 16) & 0xff,
          (frame.compositionTime >> 8) & 0xff,
          frame.compositionTime & 0xff,
        ]),
        frame.data,
      ]);

      // 传递时间戳（使用带抖动的发送函数）
      if (!frame.isKeyframe) {
        await sendVideoFrameWithJitter(
          publisher,
          videoTag,
          frame.isKeyframe,
          frame.timestamp
        );
        videoFrameCount++;

        if (videoFrameCount % 100 === 0) {
          log.info(`视频: ${videoFrameCount} 帧, 音频: ${audioFrameCount} 帧, ts: ${frame.timestamp}ms`);
        }
      }
    } catch (error) {
      log.error("发送视频帧失败:", error);
    }
  });

  // 监听音频序列头
  mp4Reader.on("audioSequenceHeader", (audio) => {
    if (publisher.publishStream && !audioConfigSent) {
      log.info("发送 AAC 序列头...");
      publisher.sendAudioSequenceHeader(audio.header, audio.config);
      audioConfigSent = true;
    }
  });

  // 监听音频帧
  mp4Reader.on("audioFrame", async (frame) => {
    if (!publisher.publishStream) return;

    try {
      // 传递时间戳（使用带抖动的发送函数）
      await sendAudioFrameWithJitter(publisher, frame.header, frame.data, frame.timestamp);
      audioFrameCount++;
    } catch (error) {
      log.error("发送音频帧失败:", error);
    }
  });

  mp4Reader.on("error", (error) => {
    log.error("MP4 读取错误:", error);
  });

  mp4Reader.on("end", () => {
    log.info("MP4 播放结束");
  });

  // 监听推流事件
  publisher.on("publishStart", (statusInfo) => {
    log.success("推流成功启动！");
    log.info("状态信息:", statusInfo);

    // 注意：按照 ffmpeg 的行为，不主动发送 WindowAckSize 和 PingPong
    // 服务器会在需要时发送 ping，客户端会自动响应 pong

    // 选择推流模式：随机数据 或 MP4文件
    const useRandomData = false; // 设为 true 使用随机数据，false 使用 MP4 文件

    if (useRandomData) {
      // 推送随机音视频数据（与 Python rtmp_connector.py 相同的逻辑）
      log.info("开始推送随机音视频数据（与 Python 相同的逻辑）...");
      publisher.startRandomStreaming();
    } else {
      // 发送元数据
      log.info("发送元数据...");
      try {
        const metadata = mp4Reader.getMetadata();
        publisher.sendCustomMetaData(metadata);
      } catch (error) {
        log.error("发送元数据失败:", error);
      }

      // 开始读取 MP4 文件并推流
      log.info("开始读取 MP4 文件并推流（包含音频和视频）...");
      log.info("文件:", mp4File);
      mp4Reader.start(true); // true = 循环播放
    }
  });

  publisher.on("status", (statusInfo) => {
    log.info("状态更新:", statusInfo);
  });

  publisher.on("error", (error) => {
    log.error("发生错误:", error);
  });

  publisher.on("close", (err) => {
    log.warn("连接已关闭", err ? err.message : "");
    mp4Reader.stop();
    // 不在这里停止推流，让重连机制处理
    // publisher.stopRandomStreaming();
  });

  // 重连相关事件
  publisher.on("reconnecting", ({ attempt, maxAttempts, interval }) => {
    log.progress(`正在尝试重连... (${attempt}/${maxAttempts}), ${interval / 1000} 秒后重连...`);
  });

  publisher.on("reconnected", () => {
    log.success("重连成功！推流已恢复");
  });

  publisher.on("reconnectFailed", async ({ attempts, error }) => {
    log.fail(`重连失败！已尝试 ${attempts} 次`);
    if (error) {
      log.error("错误:", error.message);
    }
    await waitAndExit(1);
  });

  try {
    log.info("开始 RTMP 推流流程...");
    log.separator();
    log.info("推流地址:", rtmpUrl);
    log.info("MP4 文件:", mp4File);
    log.separator();

    // 连接到服务器并完成推流准备
    await publisher.connect(rtmpUrl, {
      type: "nonprivate",
      flashVer: "FMLE/3.0 (compatible; FMSc/1.0)",
      publishType: "live",
    });

    // 保持程序运行
    log.info("程序保持运行中，按 Ctrl+C 退出...");
    await new Promise(() => {});
  } catch (error) {
    log.error("推流失败:", error);
    mp4Reader.stop();
    await waitAndExit(1);
  }
}

// 处理程序退出
process.on("SIGINT", () => {
  log.info("正在关闭连接...");
  if (globalPublisher) {
    // 停止重连
    globalPublisher.stopReconnect();
    // 关闭连接
    globalPublisher.close();
  }
  process.exit(0);
});

// 全局未捕获异常处理
process.on("uncaughtException", async (error) => {
  log.error("未捕获的异常:", error);
  await waitAndExit(1);
});

// 全局未处理的 Promise 拒绝
process.on("unhandledRejection", async (reason, promise) => {
  log.error("未处理的 Promise 拒绝:", reason);
  await waitAndExit(1);
});

// 运行主程序
if (require.main === module) {
  main().catch(async (error) => {
    log.error("程序错误:", error);
    await waitAndExit(1);
  });
}

module.exports = { main };
