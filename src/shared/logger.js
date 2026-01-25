/**
 * 统一日志工具
 * 所有日志输出带时间戳，格式规范化
 */

// 日志级别
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// 当前日志级别
let currentLevel = LogLevel.INFO;

/**
 * 获取格式化的时间戳
 * @returns {string} 格式化的时间字符串 [YYYY-MM-DD HH:mm:ss.SSS]
 */
function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * 格式化日志消息
 * @param {string} level - 日志级别标签
 * @param {string} tag - 模块标签
 * @param {any[]} args - 日志参数
 * @returns {string} 格式化的日志消息
 */
function formatMessage(level, tag, args) {
  const timestamp = getTimestamp();
  const tagStr = tag ? `[${tag}]` : "";
  const message = args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      if (typeof arg === "object") {
        return JSON.stringify(arg, null, 2);
      }
      return String(arg);
    })
    .join(" ");
  return `[${timestamp}] ${level} ${tagStr} ${message}`;
}

/**
 * 创建日志器实例
 * @param {string} tag - 模块标签
 * @returns {object} 日志器对象
 */
function createLogger(tag = "") {
  return {
    debug(...args) {
      if (currentLevel <= LogLevel.DEBUG) {
        console.log(formatMessage("DEBUG", tag, args));
      }
    },

    info(...args) {
      if (currentLevel <= LogLevel.INFO) {
        console.log(formatMessage("INFO ", tag, args));
      }
    },

    warn(...args) {
      if (currentLevel <= LogLevel.WARN) {
        console.warn(formatMessage("WARN ", tag, args));
      }
    },

    error(...args) {
      if (currentLevel <= LogLevel.ERROR) {
        console.error(formatMessage("ERROR", tag, args));
      }
    },

    // 成功消息（绿色 ✅）
    success(...args) {
      if (currentLevel <= LogLevel.INFO) {
        console.log(formatMessage("INFO ", tag, ["✅", ...args]));
      }
    },

    // 失败消息（红色 ❌）
    fail(...args) {
      if (currentLevel <= LogLevel.ERROR) {
        console.error(formatMessage("ERROR", tag, ["❌", ...args]));
      }
    },

    // 进度消息（🔄）
    progress(...args) {
      if (currentLevel <= LogLevel.INFO) {
        console.log(formatMessage("INFO ", tag, ["🔄", ...args]));
      }
    },

    // 分隔线
    separator(char = "=", length = 80) {
      if (currentLevel <= LogLevel.INFO) {
        console.log(char.repeat(length));
      }
    },
  };
}

/**
 * 设置日志级别
 * @param {number} level - 日志级别
 */
function setLogLevel(level) {
  currentLevel = level;
}

// 默认日志器
const defaultLogger = createLogger();

module.exports = {
  createLogger,
  setLogLevel,
  LogLevel,
  // 导出默认日志器的方法
  debug: defaultLogger.debug,
  info: defaultLogger.info,
  warn: defaultLogger.warn,
  error: defaultLogger.error,
  success: defaultLogger.success,
  fail: defaultLogger.fail,
  progress: defaultLogger.progress,
  separator: defaultLogger.separator,
};
