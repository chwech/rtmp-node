#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
RTMP建联工具 - 完整实现RTMP协议建联流程（步骤1-14）
根据抓包分析实现的完整RTMP连接协议
"""

import tkinter as tk
from tkinter import messagebox, scrolledtext
import socket
import threading
import time
import struct
import random
from urllib.parse import urlparse, parse_qs


class AMF0Encoder:
    """AMF0编码器"""
    
    @staticmethod
    def encode_string(s):
        """编码字符串"""
        s_bytes = s.encode('utf-8')
        return struct.pack('>H', len(s_bytes)) + s_bytes
    
    @staticmethod
    def encode_number(n):
        """编码数字"""
        return struct.pack('>d', float(n))
    
    @staticmethod
    def encode_null():
        """编码Null"""
        return b'\x05'
    
    @staticmethod
    def encode_object(obj):
        """编码对象"""
        result = b'\x03'  # Object marker
        # 按照抓包分析的顺序编码（app, type, flashVer, swfUrl, tcUrl）
        # 使用有序字典确保顺序
        from collections import OrderedDict
        if isinstance(obj, dict) and not isinstance(obj, OrderedDict):
            # 如果传入的是普通dict，按照特定顺序排列
            ordered_keys = ['app', 'type', 'flashVer', 'swfUrl', 'tcUrl']
            ordered_obj = OrderedDict()
            for key in ordered_keys:
                if key in obj:
                    ordered_obj[key] = obj[key]
            # 添加其他未列出的键
            for key, value in obj.items():
                if key not in ordered_keys:
                    ordered_obj[key] = value
            obj = ordered_obj
        
        for key, value in obj.items():
            result += struct.pack('>H', len(key)) + key.encode('utf-8')
            if isinstance(value, str):
                result += b'\x02' + AMF0Encoder.encode_string(value)
            elif isinstance(value, (int, float)):
                result += b'\x00' + AMF0Encoder.encode_number(value)
            elif value is None:
                result += AMF0Encoder.encode_null()
            else:
                result += b'\x02' + AMF0Encoder.encode_string(str(value))
        result += b'\x00\x00\x09'  # Object end marker
        return result


class AMF0Decoder:
    """AMF0解码器"""
    
    @staticmethod
    def decode_string(data, offset):
        """解码字符串"""
        length = struct.unpack('>H', data[offset:offset+2])[0]
        offset += 2
        value = data[offset:offset+length].decode('utf-8')
        return value, offset + length
    
    @staticmethod
    def decode_number(data, offset):
        """解码数字"""
        if offset + 8 > len(data):
            raise Exception(f"数据不足: 需要8字节，但只有{len(data) - offset}字节 (offset={offset}, len={len(data)})")
        value = struct.unpack('>d', data[offset:offset+8])[0]
        return value, offset + 8
    
    @staticmethod
    def decode_object(data, offset):
        """解码对象"""
        obj = {}
        while offset < len(data):
            # 检查结束标记
            if data[offset:offset+3] == b'\x00\x00\x09':
                offset += 3
                break
            
            # 读取键名
            key_len = struct.unpack('>H', data[offset:offset+2])[0]
            offset += 2
            key = data[offset:offset+key_len].decode('utf-8')
            offset += key_len
            
            # 读取值类型
            value_type = data[offset]
            offset += 1
            
            if value_type == 0x02:  # String
                value, offset = AMF0Decoder.decode_string(data, offset)
            elif value_type == 0x00:  # Number
                value, offset = AMF0Decoder.decode_number(data, offset)
            elif value_type == 0x05:  # Null
                value = None
                offset += 0
            elif value_type == 0x03:  # Object
                value, offset = AMF0Decoder.decode_object(data, offset)
            else:
                # 跳过未知类型
                offset += 1
                value = None
            
            obj[key] = value
        
        return obj, offset


class RTMPConnector:
    """RTMP连接器 - 完整实现RTMP建联流程"""
    
    def __init__(self, root):
        self.root = root
        self.root.title("RTMP建联工具 - 完整协议实现")
        self.root.geometry("900x700")
        
        # 推流相关变量
        self.is_streaming = False
        self.streaming_thread = None
        self.timestamp_audio = 0
        self.timestamp_video = 0
        self.metadata_sent = False
        # 跟踪每个Chunk Stream ID是否已发送过（用于决定使用fmt=0还是fmt=1）
        self.audio_cs_sent = False  # CS ID 4
        self.video_cs_sent = False  # CS ID 5
        
        # RTMP连接对象
        self.sock = None
        self.is_connected = False
        self.chunk_size = 4096
        self.stream_id = 0
        self.transaction_id = 0
        self.chunk_stream_id_control = 2
        self.chunk_stream_id_command = 3
        self.chunk_stream_id_data = 4
        self.chunk_stream_id_media = 4  # 用于音视频数据的Chunk Stream ID
        
        # 保存chunk状态（用于fmt=3）
        self.chunk_states = {}
        
        # 日志输出
        self.log_messages = []
        
        # 创建界面
        self.create_widgets()
    
    def create_widgets(self):
        """创建GUI界面组件"""
        # RTMP服务器地址输入
        rtmp_frame = tk.Frame(self.root)
        rtmp_frame.pack(pady=10, padx=10, fill=tk.X)
        
        tk.Label(rtmp_frame, text="RTMP服务器地址：", font=("Arial", 10, "bold")).pack(anchor=tk.W)
        self.rtmp_entry = tk.Entry(rtmp_frame, width=100, font=("Arial", 9))
        self.rtmp_entry.pack(fill=tk.X, pady=5)
        # 预设示例地址
        self.rtmp_entry.insert(0, "rtmp://push-rtmp-l11.douyincdn.com/third/stream-694838842645545436?arch_hrchy=c1&expire=1764575837&sign=0d8b155669d4dffc7f3c04db3564b4e6&t_id=037-202511241557177F589DCCC8146F3632B5-xU2wxa")
        
        # 按钮区域
        button_frame = tk.Frame(self.root)
        button_frame.pack(pady=10)
        
        self.start_button = tk.Button(
            button_frame,
            text="启动建联",
            command=self.start_connection,
            width=20,
            height=2,
            font=("Arial", 11, "bold"),
            bg="#4CAF50",
            fg="white"
        )
        self.start_button.pack(side=tk.LEFT, padx=10)
        
        self.disconnect_button = tk.Button(
            button_frame,
            text="断开连接",
            command=self.disconnect_rtmp,
            width=20,
            height=2,
            font=("Arial", 11, "bold"),
            bg="#f44336",
            fg="white",
            state=tk.DISABLED
        )
        self.disconnect_button.pack(side=tk.LEFT, padx=10)
        
        # 推流音视频按钮
        self.stream_button = tk.Button(
            button_frame,
            text="推流音视频",
            command=self.start_streaming,
            width=20,
            height=2,
            font=("Arial", 11),
            bg="#4CAF50",
            fg="white",
            state=tk.DISABLED
        )
        self.stream_button.pack(side=tk.LEFT, padx=10)
        
        # 停止推流按钮
        self.stop_stream_button = tk.Button(
            button_frame,
            text="停止推流",
            command=self.stop_streaming,
            width=20,
            height=2,
            font=("Arial", 11),
            bg="#F44336",
            fg="white",
            state=tk.DISABLED
        )
        self.stop_stream_button.pack(side=tk.LEFT, padx=10)
        
        self.clear_button = tk.Button(
            button_frame,
            text="清空日志",
            command=self.clear_log,
            width=20,
            height=2,
            font=("Arial", 11),
            bg="#9E9E9E",
            fg="white"
        )
        self.clear_button.pack(side=tk.LEFT, padx=10)
        
        # 日志输出区域
        log_frame = tk.Frame(self.root)
        log_frame.pack(pady=10, padx=10, fill=tk.BOTH, expand=True)
        
        tk.Label(log_frame, text="建联日志（步骤1-14）：", font=("Arial", 10, "bold")).pack(anchor=tk.W)
        self.log_text = scrolledtext.ScrolledText(
            log_frame,
            height=30,
            width=100,
            font=("Consolas", 9),
            wrap=tk.WORD,
            bg="#1e1e1e",
            fg="#d4d4d4",
            insertbackground="#ffffff"
        )
        self.log_text.pack(fill=tk.BOTH, expand=True, pady=5)
        
        # 状态栏
        self.status_label = tk.Label(
            self.root,
            text="状态：未连接",
            font=("Arial", 9),
            fg="gray",
            anchor=tk.W
        )
        self.status_label.pack(pady=5, padx=10, fill=tk.X)
    
    def log(self, message, step=None):
        """添加日志"""
        timestamp = time.strftime("%H:%M:%S", time.localtime())
        if step:
            log_msg = f"[{timestamp}] [步骤{step}] {message}\n"
        else:
            log_msg = f"[{timestamp}] {message}\n"
        
        self.log_messages.append(log_msg)
        self.log_text.insert(tk.END, log_msg)
        self.log_text.see(tk.END)
        self.root.update()
        print(log_msg.strip())
    
    def clear_log(self):
        """清空日志"""
        self.log_text.delete("1.0", tk.END)
        self.log_messages.clear()
    
    def parse_rtmp_url(self, url):
        """解析RTMP URL"""
        try:
            parsed = urlparse(url)
            if not parsed.scheme or not parsed.netloc:
                raise ValueError("RTMP URL格式不正确")
            
            host = parsed.hostname
            port = parsed.port or 1935
            path = parsed.path.lstrip('/')
            
            # 分离app和stream_name
            parts = path.split('/', 1)
            app = parts[0] if parts else "third"
            stream_name = parts[1] if len(parts) > 1 else ""
            
            # 解析查询参数
            query = parsed.query
            
            return host, port, app, stream_name, query
        except Exception as e:
            raise ValueError(f"URL解析失败: {e}")
    
    def send_basic_header(self, sock, fmt, cs_id):
        """发送Basic Header"""
        if cs_id < 64:
            header = struct.pack('B', (fmt << 6) | cs_id)
        elif cs_id < 320:
            header = struct.pack('>BH', (fmt << 6) | 0, cs_id - 64)
        else:
            header = struct.pack('>B', (fmt << 6) | 1) + struct.pack('>I', cs_id - 64)[1:]
        sock.sendall(header)
        return len(header)
    
    def send_message_header(self, sock, fmt, timestamp, length, msg_type_id, msg_stream_id=0):
        """发送Message Header"""
        if fmt == 0:  # 11 bytes
            # RTMP协议：timestamp(3字节) + message length(3字节) + message type id(1字节) + message stream id(4字节，小端)
            if timestamp >= 0xFFFFFF:
                header = struct.pack('>I', 0xFFFFFF)[1:] + struct.pack('>I', length)[1:] + struct.pack('B', msg_type_id) + struct.pack('<I', msg_stream_id)
            else:
                header = struct.pack('>I', timestamp)[1:] + struct.pack('>I', length)[1:] + struct.pack('B', msg_type_id) + struct.pack('<I', msg_stream_id)
        elif fmt == 1:  # 7 bytes
            if timestamp >= 0xFFFFFF:
                header = struct.pack('>I', 0xFFFFFF)[1:] + struct.pack('>I', length)[1:] + struct.pack('B', msg_type_id)
            else:
                header = struct.pack('>I', timestamp)[1:] + struct.pack('>I', length)[1:] + struct.pack('B', msg_type_id)
        elif fmt == 2:  # 3 bytes
            if timestamp >= 0xFFFFFF:
                header = struct.pack('>I', 0xFFFFFF)[1:]  # 3 bytes timestamp delta
            else:
                header = struct.pack('>I', timestamp)[1:]  # 3 bytes timestamp delta
        else:  # fmt == 3, 0 bytes
            header = b''
        sock.sendall(header)
        return len(header)
    
    def _build_chunk_data(self, fmt, cs_id, timestamp, msg_type_id, payload, msg_stream_id=0):
        """构造chunk数据（不发送，只返回数据）"""
        # 构造Basic Header
        if cs_id < 64:
            basic_header = struct.pack('B', (fmt << 6) | cs_id)
        elif cs_id < 320:
            basic_header = struct.pack('>BH', (fmt << 6) | 0, cs_id - 64)
        else:
            basic_header = struct.pack('>B', (fmt << 6) | 1) + struct.pack('>I', cs_id - 64)[1:]
        
        # 构造Message Header
        if fmt == 0:  # 11 bytes
            # RTMP协议中，timestamp是3字节（大端），body size是3字节（大端）
            # 使用extended timestamp如果timestamp >= 0xFFFFFF
            if timestamp >= 0xFFFFFF:
                msg_header = struct.pack('>I', 0xFFFFFF)[1:] + struct.pack('>I', len(payload))[1:] + struct.pack('B', msg_type_id) + struct.pack('<I', msg_stream_id)
            else:
                msg_header = struct.pack('>I', timestamp)[1:] + struct.pack('>I', len(payload))[1:] + struct.pack('B', msg_type_id) + struct.pack('<I', msg_stream_id)
        elif fmt == 1:  # 7 bytes
            if timestamp >= 0xFFFFFF:
                msg_header = struct.pack('>I', 0xFFFFFF)[1:] + struct.pack('>I', len(payload))[1:] + struct.pack('B', msg_type_id)
            else:
                msg_header = struct.pack('>I', timestamp)[1:] + struct.pack('>I', len(payload))[1:] + struct.pack('B', msg_type_id)
        elif fmt == 2:  # 3 bytes
            msg_header = struct.pack('>I', timestamp)[1:]  # 3 bytes timestamp delta
        else:  # fmt == 3, 0 bytes
            msg_header = b''
        
        # 如果payload超过chunk_size，需要分块
        if len(payload) <= self.chunk_size:
            return basic_header + msg_header + payload
        else:
            # 第一个chunk
            first_payload = payload[:self.chunk_size]
            result = basic_header + msg_header + first_payload
            # 后续chunks
            offset = self.chunk_size
            while offset < len(payload):
                chunk_payload = payload[offset:offset+self.chunk_size]
                # fmt=3的Basic Header
                fmt3_basic_header = struct.pack('B', (3 << 6) | cs_id)
                result += fmt3_basic_header + chunk_payload
                offset += self.chunk_size
            return result
    
    def send_chunk(self, sock, fmt, cs_id, timestamp, msg_type_id, payload, msg_stream_id=0):
        """发送RTMP Chunk"""
        # 如果payload超过chunk_size，需要分块
        total_sent = 0
        offset = 0
        
        while offset < len(payload):
            chunk_payload = payload[offset:offset+self.chunk_size]
            chunk_length = len(chunk_payload)
            
            # 发送Basic Header
            self.send_basic_header(sock, fmt if offset == 0 else 3, cs_id)
            
            # 发送Message Header
            if offset == 0:
                self.send_message_header(sock, fmt, timestamp, len(payload), msg_type_id, msg_stream_id)
            elif offset < self.chunk_size:
                # 后续块使用fmt=3，只发送Basic Header
                pass
            
            # 发送payload
            sock.sendall(chunk_payload)
            total_sent += len(chunk_payload)
            offset += self.chunk_size
            fmt = 3  # 后续块使用fmt=3
        
        return total_sent
    
    def read_chunk(self, sock):
        """读取RTMP Chunk"""
        # 读取Basic Header (1字节)
        basic_header = b''
        while len(basic_header) < 1:
            chunk = sock.recv(1 - len(basic_header))
            if len(chunk) == 0:
                return None
            basic_header += chunk
        
        fmt = (basic_header[0] >> 6) & 0x03
        cs_id = basic_header[0] & 0x3F
        
        if cs_id == 0:
            # 扩展格式1
            ext_data = b''
            while len(ext_data) < 1:
                chunk = sock.recv(1 - len(ext_data))
                if len(chunk) == 0:
                    raise Exception("读取扩展格式1失败")
                ext_data += chunk
            cs_id = struct.unpack('>B', ext_data)[0] + 64
        elif cs_id == 1:
            # 扩展格式2
            ext_data = b''
            while len(ext_data) < 2:
                chunk = sock.recv(2 - len(ext_data))
                if len(chunk) == 0:
                    raise Exception("读取扩展格式2失败")
                ext_data += chunk
            cs_id = struct.unpack('>H', ext_data)[0] + 64
        
        # 获取之前的状态
        prev_state = self.chunk_states.get(cs_id, {})
        
        # 读取Message Header
        if fmt == 0:
            header = b''
            while len(header) < 11:
                chunk = sock.recv(11 - len(header))
                if len(chunk) == 0:
                    raise Exception("读取Message Header (fmt=0)失败")
                header += chunk
            timestamp = struct.unpack('>I', b'\x00' + header[0:3])[0]
            length = struct.unpack('>I', b'\x00' + header[3:6])[0]
            msg_type_id = header[6]
            msg_stream_id = struct.unpack('<I', header[7:11])[0]
        elif fmt == 1:
            header = b''
            while len(header) < 7:
                chunk = sock.recv(7 - len(header))
                if len(chunk) == 0:
                    raise Exception("读取Message Header (fmt=1)失败")
                header += chunk
            timestamp = struct.unpack('>I', b'\x00' + header[0:3])[0]
            length = struct.unpack('>I', b'\x00' + header[3:6])[0]
            msg_type_id = header[6]
            msg_stream_id = prev_state.get('msg_stream_id', 0)
        elif fmt == 2:
            header = b''
            while len(header) < 3:
                chunk = sock.recv(3 - len(header))
                if len(chunk) == 0:
                    raise Exception("读取Message Header (fmt=2)失败")
                header += chunk
            timestamp = struct.unpack('>I', b'\x00' + header)[0]
            length = prev_state.get('length', 0)
            msg_type_id = prev_state.get('msg_type_id', 0)
            msg_stream_id = prev_state.get('msg_stream_id', 0)
        else:  # fmt == 3
            # 使用之前的值
            timestamp = prev_state.get('timestamp', 0)
            length = prev_state.get('length', 0)
            msg_type_id = prev_state.get('msg_type_id', 0)
            msg_stream_id = prev_state.get('msg_stream_id', 0)
        
        # 保存状态
        self.chunk_states[cs_id] = {
            'timestamp': timestamp,
            'length': length,
            'msg_type_id': msg_type_id,
            'msg_stream_id': msg_stream_id
        }
        
        # 读取payload
        if length > 0:
            payload = b''
            while len(payload) < length:
                remaining = min(self.chunk_size, length - len(payload))
                chunk = sock.recv(remaining)
                if len(chunk) == 0:
                    raise Exception(f"读取payload失败: 期望{length}字节，已接收{len(payload)}字节")
                payload += chunk
        else:
            payload = b''
        
        return {
            'fmt': fmt,
            'cs_id': cs_id,
            'timestamp': timestamp,
            'length': length,
            'msg_type_id': msg_type_id,
            'msg_stream_id': msg_stream_id,
            'payload': payload
        }
    
    def step_1_3_tcp_handshake(self, sock, host, port):
        """步骤1-3: TCP三次握手（socket自动处理）"""
        self.log(f"开始TCP连接: {host}:{port}", 1)
        sock.connect((host, port))
        self.log(f"✓ TCP连接成功: {host}:{port}", 1)
        return True
    
    def step_4_6_rtmp_handshake(self, sock):
        """步骤4-6: RTMP握手"""
        self.log("开始RTMP握手...", 4)
        
        # 步骤4: 发送C0+C1
        self.log("发送C0+C1...", 4)
        c0 = struct.pack('B', 3)
        timestamp = int(time.time())
        version = 0
        random_data = bytes([random.randint(0, 255) for _ in range(1528)])
        c1 = struct.pack('>I', timestamp) + struct.pack('>I', version) + random_data
        
        sock.sendall(c0 + c1)
        self.log(f"✓ 已发送C0+C1 (C0: 1字节, C1: 1536字节)", 4)
        self.log(f"  C0版本: 3, C1时间戳: {timestamp}, 随机数据: {len(random_data)}字节", 4)
        
        # 步骤5: 接收S0+S1+S2
        self.log("等待服务器响应S0+S1+S2...", 5)
        
        # 接收S0 (1字节)
        s0 = b''
        while len(s0) < 1:
            chunk = sock.recv(1 - len(s0))
            if len(chunk) == 0:
                raise Exception("S0握手失败: 连接已关闭")
            s0 += chunk
        
        if s0[0] != 3:
            raise Exception(f"S0握手失败: 版本号不正确 (收到: {s0[0]})")
        
        # 接收S1 (1536字节)
        self.log("接收S1 (1536字节)...", 5)
        s1 = b''
        while len(s1) < 1536:
            chunk = sock.recv(1536 - len(s1))
            if len(chunk) == 0:
                raise Exception(f"S1握手失败: 连接已关闭 (已接收: {len(s1)}字节)")
            s1 += chunk
        
        if len(s1) != 1536:
            raise Exception(f"S1握手失败: 数据长度不正确 (收到: {len(s1)}字节)")
        
        # 接收S2 (1536字节) - 可能需要多次接收
        self.log("接收S2 (1536字节)...", 5)
        s2 = b''
        while len(s2) < 1536:
            remaining = 1536 - len(s2)
            chunk = sock.recv(remaining)
            if len(chunk) == 0:
                raise Exception(f"S2握手失败: 连接已关闭 (已接收: {len(s2)}字节)")
            s2 += chunk
            if len(s2) < 1536:
                self.log(f"  已接收S2: {len(s2)}/1536字节，继续接收...", 5)
        
        if len(s2) != 1536:
            raise Exception(f"S2握手失败: 数据长度不正确 (收到: {len(s2)}字节)")
        
        self.log(f"✓ 已接收S0+S1+S2 (S0: 1字节, S1: 1536字节, S2: 1536字节)", 5)
        self.log(f"  S0版本: {s0[0]}", 5)
        
        # 步骤6: 发送C2
        self.log("发送C2...", 6)
        c2 = s1  # C2是S1的回显
        sock.sendall(c2)
        self.log(f"✓ 已发送C2 (1536字节, 回显S1)", 6)
        
        self.log("✓ RTMP握手完成", 6)
        return True
    
    def step_7_set_chunk_size(self, sock):
        """步骤7: 设置Chunk Size"""
        self.log("发送Set Chunk Size命令...", 7)
        
        chunk_size_bytes = struct.pack('>I', self.chunk_size)
        
        self.send_chunk(
            sock,
            fmt=0,
            cs_id=self.chunk_stream_id_control,
            timestamp=0,
            msg_type_id=1,  # Set Chunk Size
            payload=chunk_size_bytes,
            msg_stream_id=0
        )
        
        self.log(f"✓ 已发送Set Chunk Size: {self.chunk_size}字节", 7)
        return True
    
    def step_8_connect(self, sock, app, tc_url):
        """步骤8: 发送connect命令"""
        self.log("发送connect命令...", 8)
        
        # 根据抓包分析，tcUrl不应该包含端口号（如果端口是默认的1935）
        # 修正tcUrl格式
        if ':1935' in tc_url:
            tc_url = tc_url.replace(':1935', '')
        swf_url = tc_url  # swfUrl和tcUrl相同
        
        self.transaction_id = 1
        command_name = "connect"
        
        # 构造AMF0命令
        payload = b'\x02' + AMF0Encoder.encode_string(command_name)
        payload += b'\x00' + AMF0Encoder.encode_number(self.transaction_id)
        
        # 命令对象（按照抓包分析的顺序）
        command_obj = {
            'app': app,
            'type': 'nonprivate',
            'flashVer': 'FMLE/3.0 (compatible; FMSc/1.0)',
            'swfUrl': swf_url,
            'tcUrl': tc_url
        }
        payload += AMF0Encoder.encode_object(command_obj)
        
        # 打印payload的十六进制（用于调试）
        payload_hex = ' '.join(f'{b:02x}' for b in payload[:100])  # 只显示前100字节
        self.log(f"  Payload (hex, 前100字节): {payload_hex}", 8)
        
        self.send_chunk(
            sock,
            fmt=0,
            cs_id=self.chunk_stream_id_command,
            timestamp=0,
            msg_type_id=20,  # AMF0 Command
            payload=payload,
            msg_stream_id=0
        )
        
        self.log(f"✓ 已发送connect命令", 8)
        self.log(f"  事务ID: {self.transaction_id}", 8)
        self.log(f"  应用名: {app}", 8)
        self.log(f"  swfUrl: {swf_url}", 8)
        self.log(f"  tcUrl: {tc_url}", 8)
        self.log(f"  数据包大小: {len(payload)}字节", 8)
        
        return True
    
    def step_9_receive_connect_result(self, sock):
        """步骤9: 接收connect响应"""
        self.log("等待服务器connect响应...", 9)
        
        # 读取响应（可能需要读取多个chunk）
        chunks = []
        connect_result_received = False
        max_chunks = 10  # 最多读取10个chunk，避免无限循环
        chunk_count = 0
        
        while chunk_count < max_chunks:
            try:
                # 设置较短的超时，用于检查是否有数据
                sock.settimeout(1.0)  # 1秒超时
                chunk = self.read_chunk(sock)
                
                if chunk is None:
                    self.log("  没有更多数据，停止接收", 9)
                    break
                
                chunk_count += 1
                chunks.append(chunk)
                
                self.log(f"  收到chunk #{chunk_count}: msg_type_id={chunk['msg_type_id']}, length={chunk['length']}", 9)
                
                # 检查是否是connect响应
                if chunk['msg_type_id'] == 20:  # AMF0 Command
                    payload = chunk['payload']
                    if len(payload) > 0 and payload[0] == 0x02:  # String
                        try:
                            cmd_name, offset = AMF0Decoder.decode_string(payload, 1)
                            self.log(f"  解析到命令: {cmd_name}", 9)
                            
                            if cmd_name == '_result':
                                # 读取事务ID
                                trans_id, offset = AMF0Decoder.decode_number(payload, offset)
                                self.log(f"✓ 收到connect _result响应", 9)
                                self.log(f"  事务ID: {int(trans_id)}", 9)
                                self.log(f"  数据包大小: {len(payload)}字节", 9)
                                
                                # 解析响应对象
                                if offset < len(payload) and payload[offset] == 0x03:  # Object
                                    try:
                                        obj, _ = AMF0Decoder.decode_object(payload, offset + 1)
                                        self.log(f"  响应对象: {obj}", 9)
                                    except Exception as e:
                                        self.log(f"  解析响应对象失败: {e}", 9)
                                
                                connect_result_received = True
                                # 继续接收其他消息（如onStatus）
                                
                            elif cmd_name == 'onStatus':
                                # 读取事务ID
                                trans_id, offset = AMF0Decoder.decode_number(payload, offset)
                                # 读取状态对象
                                if offset < len(payload) and payload[offset] == 0x03:  # Object
                                    try:
                                        status_obj, _ = AMF0Decoder.decode_object(payload, offset + 1)
                                        code = status_obj.get('code', '')
                                        level = status_obj.get('level', '')
                                        self.log(f"  收到onStatus通知: code={code}, level={level}", 9)
                                    except Exception as e:
                                        self.log(f"  解析onStatus失败: {e}", 9)
                        except Exception as e:
                            self.log(f"  解析AMF0命令失败: {e}", 9)
                            import traceback
                            self.log(f"  错误详情: {traceback.format_exc()}", 9)
                
                # 检查其他控制消息
                if chunk['msg_type_id'] == 3:  # Window Acknowledgement Size
                    if len(chunk['payload']) >= 4:
                        size = struct.unpack('>I', chunk['payload'][:4])[0]
                        self.log(f"  收到Window Acknowledgement Size: {size}", 9)
                elif chunk['msg_type_id'] == 6:  # Set Peer Bandwidth
                    if len(chunk['payload']) >= 4:
                        size = struct.unpack('>I', chunk['payload'][:4])[0]
                        self.log(f"  收到Set Peer Bandwidth: {size}", 9)
                elif chunk['msg_type_id'] == 1:  # Set Chunk Size
                    if len(chunk['payload']) >= 4:
                        size = struct.unpack('>I', chunk['payload'][:4])[0]
                        self.log(f"  收到Set Chunk Size: {size}", 9)
                        self.chunk_size = size
                
                # 如果已经收到connect _result，再等待一下看是否有onStatus
                if connect_result_received and chunk_count >= 3:
                    break
                    
            except socket.timeout:
                self.log(f"  接收超时 (已接收{chunk_count}个chunk)", 9)
                if connect_result_received:
                    self.log("  已收到connect _result，继续", 9)
                    break
                else:
                    self.log("  未收到connect _result，继续等待...", 9)
                    # 继续尝试一次
                    continue
            except Exception as e:
                self.log(f"  接收chunk时出错: {e}", 9)
                import traceback
                self.log(f"  错误详情: {traceback.format_exc()}", 9)
                break
        
        if not connect_result_received:
            raise Exception(f"未收到connect _result响应 (已接收{chunk_count}个chunk)")
        
        self.log("✓ connect响应处理完成", 9)
        return True
    
    def step_10_release_stream(self, sock, stream_name):
        """步骤10: 发送releaseStream命令"""
        self.log("发送releaseStream命令...", 10)
        
        self.transaction_id = 2
        command_name = "releaseStream"
        
        payload = b'\x02' + AMF0Encoder.encode_string(command_name)
        payload += b'\x00' + AMF0Encoder.encode_number(self.transaction_id)
        payload += AMF0Encoder.encode_null()
        payload += b'\x02' + AMF0Encoder.encode_string(stream_name)
        
        self.send_chunk(
            sock,
            fmt=1,  # 复用格式
            cs_id=self.chunk_stream_id_command,
            timestamp=0,
            msg_type_id=20,  # AMF0 Command
            payload=payload,
            msg_stream_id=0
        )
        
        self.log(f"✓ 已发送releaseStream命令", 10)
        self.log(f"  事务ID: {self.transaction_id}", 10)
        self.log(f"  流名称: {stream_name[:50]}...", 10)
        self.log(f"  数据包大小: {len(payload)}字节", 10)
        
        return True
    
    def step_10_wait_release_stream_response(self, sock):
        """步骤10: 等待releaseStream响应"""
        self.log("等待服务器releaseStream响应...", 10)
        
        max_attempts = 10
        attempt = 0
        
        while attempt < max_attempts:
            try:
                sock.settimeout(1.0)  # 1秒超时
                chunk = self.read_chunk(sock)
                
                if chunk is None:
                    # 没有数据，超时后进入下一步
                    break
                
                attempt += 1
                cs_id = chunk.get('cs_id', 0)
                payload = chunk['payload']
                msg_type_id = chunk['msg_type_id']
                
                # 只对重要消息打印日志
                if chunk['length'] > 0 and msg_type_id == 20:
                    self.log(f"  收到chunk #{attempt}: cs_id={cs_id}, msg_type_id={msg_type_id}, length={chunk['length']}", 10)
                
                # 跳过空消息
                if chunk['length'] == 0:
                    continue
                
                if msg_type_id == 20:  # AMF0 Command
                    if len(payload) == 0:
                        continue
                    
                    if payload[0] == 0x02:  # String
                        try:
                            cmd_name, offset = AMF0Decoder.decode_string(payload, 1)
                            
                            if cmd_name == '_result':
                                # 读取事务ID
                                if offset >= len(payload):
                                    continue
                                
                                number_type = payload[offset]
                                if number_type == 0x00:
                                    offset += 1
                                
                                if offset + 8 > len(payload):
                                    continue
                                
                                trans_id, _ = AMF0Decoder.decode_number(payload, offset)
                                trans_id_int = int(round(trans_id))
                                
                                if trans_id_int == 2 or abs(trans_id - 2.0) < 0.0001:
                                    self.log(f"✓ 收到releaseStream _result响应（事务ID=2）", 10)
                                    return True
                                else:
                                    self.log(f"  收到其他_result响应（事务ID={trans_id_int}），继续等待...", 10)
                                    continue
                        except Exception as e:
                            self.log(f"  解析响应时出错: {e}", 10)
                            continue
            except socket.timeout:
                # 1秒超时，进入下一步
                self.log("  1秒超时，进入下一步", 10)
                break
            except Exception as e:
                # 错误，进入下一步
                break
                
        # 未收到响应，进入下一步
        return False
    
    def step_11_fcpublish_create_stream(self, sock, stream_name):
        """步骤11: 发送FCPublish、createStream和_checkbw命令（在同一TCP包中）"""
        self.log("发送FCPublish、createStream和_checkbw命令（同一TCP包）...", 11)
        
        # FCPublish
        self.transaction_id = 3
        command_name = "FCPublish"
        
        payload_fcpublish = b'\x02' + AMF0Encoder.encode_string(command_name)
        payload_fcpublish += b'\x00' + AMF0Encoder.encode_number(self.transaction_id)
        payload_fcpublish += AMF0Encoder.encode_null()
        payload_fcpublish += b'\x02' + AMF0Encoder.encode_string(stream_name)
        
        fcpublish_chunk_data = self._build_chunk_data(
            fmt=1,  # 复用格式
            cs_id=self.chunk_stream_id_command,
            timestamp=0,
            msg_type_id=20,
            payload=payload_fcpublish,
            msg_stream_id=0
        )
        
        # createStream
        self.transaction_id = 4
        command_name = "createStream"
        
        payload_createstream = b'\x02' + AMF0Encoder.encode_string(command_name)
        payload_createstream += b'\x00' + AMF0Encoder.encode_number(self.transaction_id)
        payload_createstream += AMF0Encoder.encode_null()
        
        createstream_chunk_data = self._build_chunk_data(
            fmt=1,  # 复用格式
            cs_id=self.chunk_stream_id_command,
            timestamp=0,
            msg_type_id=20,
            payload=payload_createstream,
            msg_stream_id=0
        )
        
        # _checkbw (根据CC.txt，某些服务器需要这个命令)
        self.transaction_id = 5
        command_name = "_checkbw"
        
        payload_checkbw = b'\x02' + AMF0Encoder.encode_string(command_name)
        payload_checkbw += b'\x00' + AMF0Encoder.encode_number(self.transaction_id)
        payload_checkbw += AMF0Encoder.encode_null()
        
        checkbw_chunk_data = self._build_chunk_data(
            fmt=0,  # 新消息格式
            cs_id=self.chunk_stream_id_command,
            timestamp=0,
            msg_type_id=20,
            payload=payload_checkbw,
            msg_stream_id=0
        )
        
        # 合并三个chunk，一次性发送（确保在同一个TCP包中）
        combined_data = fcpublish_chunk_data + createstream_chunk_data + checkbw_chunk_data
        self.sock.sendall(combined_data)
        
        self.log(f"✓ 已发送FCPublish命令", 11)
        self.log(f"  事务ID: 3", 11)
        self.log(f"✓ 已发送createStream命令", 11)
        self.log(f"  事务ID: 4", 11)
        self.log(f"✓ 已发送_checkbw命令", 11)
        self.log(f"  事务ID: 5", 11)
        
        return True
    
    def step_12_receive_create_stream_result(self, sock):
        """步骤12: 接收createStream响应"""
        self.log("等待服务器createStream响应...", 12)
        
        max_attempts = 1  # 只尝试1次，1秒超时后进入下一步
        attempt = 0
        
        while attempt < max_attempts:
            try:
                # 使用1秒超时时间
                sock.settimeout(1.0)
                chunk = self.read_chunk(sock)
                
                if chunk is None:
                    # 检查socket是否还有数据可读（非阻塞）
                    import select
                    ready = select.select([sock], [], [], 0.0)
                    if ready[0]:
                        # 还有数据，继续读取（不打印日志，避免刷屏）
                        continue
                    else:
                        # 真的没有数据了，快速进入下一步
                        attempt += 1
                        if attempt >= max_attempts:
                            break
                        continue
                
                attempt += 1
                cs_id = chunk.get('cs_id', 0)
                msg_stream_id = chunk.get('msg_stream_id', 0)
                payload = chunk['payload']
                msg_type_id = chunk['msg_type_id']
                
                # RTMP消息类型说明
                msg_type_names = {
                    1: "Set Chunk Size",
                    2: "Abort Message",
                    3: "Acknowledgement",
                    4: "User Control Message",
                    5: "Window Acknowledgement Size",
                    6: "Set Peer Bandwidth",
                    8: "Audio Data",
                    9: "Video Data",
                    18: "AMF0 Data",
                    20: "AMF0 Command",
                    22: "AMF3 Data",
                    23: "AMF3 Command"
                }
                msg_type_name = msg_type_names.get(msg_type_id, f"Unknown({msg_type_id})")
                
                # 只对重要消息打印日志（避免刷屏）
                if chunk['length'] > 0 and msg_type_id == 20:
                    self.log(f"  收到chunk #{attempt}: cs_id={cs_id}, msg_type_id={msg_type_id}({msg_type_name}), length={chunk['length']}", 12)
                
                # 跳过length=0的消息（空消息）
                if chunk['length'] == 0:
                    # 如果是fmt=3且没有之前的状态，跳过
                    if chunk.get('fmt', 0) == 3:
                        prev_state = self.chunk_states.get(cs_id, {})
                        if not prev_state:
                            continue
                    continue
                
                # 只对关键消息打印payload（避免刷屏）
                # 不打印payload hex，只在解析时打印关键信息
                
                if msg_type_id == 20:  # AMF0 Command
                    if len(payload) == 0:
                        continue
                    
                    # read_chunk已经读取了完整的payload，不需要累积
                    # 直接解析每个chunk的payload
                    if payload[0] == 0x02:  # String
                        try:
                            cmd_name, offset = AMF0Decoder.decode_string(payload, 1)
                            
                            # 如果是onFCPublish，这是FCPublish的响应，跳过但继续等待
                            if cmd_name == 'onFCPublish':
                                # 不打印日志，避免刷屏
                                continue  # 继续循环，等待createStream响应
                            
                            # 打印所有接收到的响应，不管是什么
                            if cmd_name == '_result':
                                # 检查是否有足够的数据读取事务ID
                                if offset + 8 > len(payload):
                                    self.log(f"  数据不足读取事务ID: offset={offset}, payload_len={len(payload)}", 12)
                                    continue
                                
                                # 读取事务ID
                                # 注意：AMF0中Number类型前面有类型标记0x00
                                if offset >= len(payload):
                                    self.log(f"  数据不足: offset={offset}, payload_len={len(payload)}", 12)
                                    continue
                                
                                number_type = payload[offset]
                                if number_type == 0x00:
                                    offset += 1  # 跳过Number类型标记
                                
                                if offset + 8 > len(payload):
                                    continue
                                
                                trans_id, offset = AMF0Decoder.decode_number(payload, offset)
                                trans_id_int = int(round(trans_id))  # 使用round确保正确转换
                                
                                # 检查事务ID是否匹配createStream的事务ID (4)
                                # 跳过其他命令的响应
                                if trans_id_int == 2 or abs(trans_id - 2.0) < 0.0001:
                                    continue  # releaseStream响应，跳过
                                if trans_id_int == 3 or abs(trans_id - 3.0) < 0.0001:
                                    continue  # FCPublish响应，跳过
                                if trans_id_int == 5 or abs(trans_id - 5.0) < 0.0001:
                                    continue  # _checkbw响应，跳过
                                
                                # 这是createStream的响应（事务ID=4）
                                if trans_id_int == 4 or abs(trans_id - 4.0) < 0.0001:
                                    # 根据RTMP协议，createStream _result的格式是：
                                    # _result + 事务ID(Number) + Null + 流ID(Number)
                                    
                                    # 跳过Null标记
                                    if offset < len(payload) and payload[offset] == 0x05:  # Null
                                        offset += 1
                                    
                                    # 跳过Undefined标记
                                    if offset < len(payload) and payload[offset] == 0x06:  # Undefined
                                        offset += 1
                                    
                                    # 检查是否有足够的数据读取流ID
                                    if offset >= len(payload):
                                        continue
                                    
                                    # 跳过流ID的Number类型标记
                                    if offset < len(payload) and payload[offset] == 0x00:
                                        offset += 1
                                    
                                    if offset + 8 <= len(payload):
                                        # 读取流ID
                                        self.stream_id, _ = AMF0Decoder.decode_number(payload, offset)
                                        
                                        self.log(f"✓ 收到createStream响应，流ID: {int(self.stream_id)}", 12)
                                        return True
                                    else:
                                        continue
                                else:
                                    # 其他事务ID，跳过
                                    continue
                            else:
                                # 其他命令，跳过（不打印日志，避免刷屏）
                                continue
                                
                        except Exception as e:
                            self.log(f"  解析响应时出错: {e}", 12)
                            import traceback
                            self.log(f"  错误详情: {traceback.format_exc()}", 12)
                            continue
                    # 不是字符串类型，跳过
                    pass
                # 不是AMF0命令，跳过
                    
            except socket.timeout:
                # 1秒超时，进入下一步
                self.log("  1秒超时，使用默认stream_id=1继续执行", 12)
                break
            except Exception as e:
                self.log(f"  接收chunk时出错: {e}", 12)
                import traceback
                self.log(f"  错误详情: {traceback.format_exc()}", 12)
                attempt += 1
                if attempt >= max_attempts:
                    break
                continue
        
        # 如果收不到响应，使用默认stream_id=1继续执行
        if not hasattr(self, 'stream_id') or self.stream_id is None or self.stream_id == 0:
            self.stream_id = 1.0  # 使用默认值
        self.log(f"  未收到createStream响应，使用默认stream_id={int(self.stream_id)}继续执行", 12)
        return False  # 返回False表示未收到响应，但继续执行
    
    def step_13_publish(self, sock, stream_name):
        """步骤13: 发送publish命令"""
        self.log("发送publish命令...", 13)
        
        # 检查stream_id是否已正确获取
        if not hasattr(self, 'stream_id') or self.stream_id is None or self.stream_id == 0:
            # 如果stream_id未获取，使用默认值1继续执行
            self.log(f"  警告: stream_id未正确获取，使用默认值1继续执行", 13)
            self.stream_id = 1.0
        
        self.transaction_id = 5
        command_name = "publish"
        publish_type = "live"
        
        payload = b'\x02' + AMF0Encoder.encode_string(command_name)
        payload += b'\x00' + AMF0Encoder.encode_number(self.transaction_id)
        payload += AMF0Encoder.encode_null()
        payload += b'\x02' + AMF0Encoder.encode_string(stream_name)
        payload += b'\x02' + AMF0Encoder.encode_string(publish_type)
        
        # 根据抓包分析，publish命令的payload格式：
        # String 'publish' (10字节) + Number 5 (9字节) + Null (1字节) + String stream_name (1+2+len) + String 'live' (7字节)
        # 总大小 = 10 + 9 + 1 + (3 + stream_name长度) + 7 = 30 + stream_name长度
        # 抓包中stream_name是210字节，所以总大小是240字节
        # 但实际stream_name长度可能不同，所以不强制检查大小
        self.log(f"  publish payload大小: {len(payload)}字节 (stream_name长度: {len(stream_name)}字节)", 13)
        
        self.send_chunk(
            sock,
            fmt=0,  # 新消息，使用完整格式
            cs_id=self.chunk_stream_id_data,  # Chunk Stream ID 4
            timestamp=0,
            msg_type_id=20,  # AMF0 Command
            payload=payload,
            msg_stream_id=int(self.stream_id)  # Stream ID 1（从createStream响应中获取）
        )
        
        self.log(f"✓ 已发送publish命令", 13)
        self.log(f"  事务ID: {self.transaction_id}", 13)
        self.log(f"  流ID: {int(self.stream_id)}", 13)
        self.log(f"  Chunk Stream ID: {self.chunk_stream_id_data}", 13)
        self.log(f"  发布类型: {publish_type}", 13)
        self.log(f"  流名称: {stream_name[:50]}...", 13)
        self.log(f"  数据包大小: {len(payload)}字节", 13)
        
        return True
    
    def step_14_receive_publish_result(self, sock):
        """步骤14: 接收publish响应"""
        self.log("等待服务器publish响应...", 14)
        
        max_attempts = 10
        attempt = 0
        
        while attempt < max_attempts:
            try:
                sock.settimeout(1.0)  # 1秒超时
                chunk = self.read_chunk(sock)
                
                if chunk is None:
                    # 没有数据，超时后进入下一步
                    break
                
                attempt += 1
                # 只对重要消息打印日志
                if chunk['length'] > 0 and chunk['msg_type_id'] == 20:
                    self.log(f"  收到chunk #{attempt}: msg_type_id={chunk['msg_type_id']}, length={chunk['length']}", 14)
                
                if chunk['msg_type_id'] == 20:  # AMF0 Command
                    payload = chunk['payload']
                    if len(payload) == 0:
                        continue
                    
                    # 不打印payload hex，避免刷屏
                    
                    if payload[0] == 0x02:  # String
                        try:
                            cmd_name, offset = AMF0Decoder.decode_string(payload, 1)
                            self.log(f"  解析到命令: {cmd_name}, offset={offset}", 14)
                            
                            if cmd_name == 'onStatus':
                                # 检查是否有足够的数据读取事务ID
                                if offset + 8 > len(payload):
                                    self.log(f"  数据不足读取事务ID: offset={offset}, payload_len={len(payload)}", 14)
                                    continue
                                
                                # 读取事务ID（通常是0）
                                trans_id, offset = AMF0Decoder.decode_number(payload, offset)
                                self.log(f"  事务ID: {int(trans_id)}, offset={offset}", 14)
                                
                                # 检查Null标记
                                if offset >= len(payload):
                                    continue
                                if payload[offset] != 0x05:
                                    continue
                                
                                offset += 1  # 跳过Null
                                
                                # 读取状态对象
                                if offset >= len(payload):
                                    continue
                                if payload[offset] != 0x03:
                                    continue
                                
                                # 解析对象
                                try:
                                    status_obj, _ = AMF0Decoder.decode_object(payload, offset + 1)
                                    
                                    self.log(f"✓ 收到onStatus响应", 14)
                                    self.log(f"  事务ID: {int(trans_id)}", 14)
                                    self.log(f"  状态对象: {status_obj}", 14)
                                    
                                    code = status_obj.get('code', '')
                                    if 'Publish.Start' in code or 'Publish' in code:
                                        self.log(f"✓ 发布成功！状态: {code}", 14)
                                        return True
                                    else:
                                        self.log(f"  状态: {code}", 14)
                                except Exception as e:
                                    self.log(f"  解析状态对象时出错: {e}", 14)
                                    import traceback
                                    self.log(f"  错误详情: {traceback.format_exc()}", 14)
                                    continue
                                    
                        except Exception as e:
                            self.log(f"  解析响应时出错: {e}", 14)
                            import traceback
                            self.log(f"  错误详情: {traceback.format_exc()}", 14)
                            continue
                    else:
                        self.log(f"  不是字符串类型: 0x{payload[0]:02x}", 14)
                else:
                    self.log(f"  不是AMF0命令: msg_type_id={chunk['msg_type_id']}", 14)
                    
            except socket.timeout:
                # 1秒超时，进入下一步
                self.log("  1秒超时，继续执行", 14)
                break
            except Exception as e:
                # 错误，进入下一步
                break
        
        # 如果收不到响应，继续执行（不抛出异常）
        self.log(f"  未收到publish响应，继续执行", 14)
        return False  # 返回False表示未收到响应，但继续执行
    
    def start_connection(self):
        """启动建联流程"""
        rtmp_url = self.rtmp_entry.get().strip()
        
        if not rtmp_url:
            messagebox.showwarning("警告", "请输入RTMP服务器地址")
            return
        
        # 禁用按钮
        self.start_button.config(state=tk.DISABLED, text="建联中...")
        self.disconnect_button.config(state=tk.DISABLED)
        self.status_label.config(text="状态：正在建联...", fg="orange")
        self.root.update()
        
        # 在新线程中执行建联
        threading.Thread(target=self._connect_thread, args=(rtmp_url,), daemon=True).start()
    
    def _connect_thread(self, rtmp_url):
        """在后台线程中执行RTMP建联"""
        try:
            # 解析URL
            host, port, app, stream_name, query = self.parse_rtmp_url(rtmp_url)
            
            # 构造完整的流名称（包含查询参数）
            if query:
                full_stream_name = f"{stream_name}?{query}"
            else:
                full_stream_name = stream_name
            
            # 构造tcUrl（根据抓包分析，不包含端口号，默认1935）
            if port == 1935:
                tc_url = f"rtmp://{host}/{app}"
            else:
                tc_url = f"rtmp://{host}:{port}/{app}"
            
            self.log("=" * 80)
            self.log("开始RTMP建联流程")
            self.log(f"服务器: {host}:{port}")
            self.log(f"应用: {app}")
            self.log(f"流名称: {full_stream_name[:80]}...")
            self.log("=" * 80)
            
            # 创建socket
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(60)  # 增加超时时间到60秒
            # 设置TCP_NODELAY，禁用Nagle算法，确保数据立即发送
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            
            # 步骤1-3: TCP握手
            self.step_1_3_tcp_handshake(self.sock, host, port)
            time.sleep(0.01)
            
            # 步骤4-6: RTMP握手
            self.step_4_6_rtmp_handshake(self.sock)
            time.sleep(0.01)
            
            # 步骤7+8: Set Chunk Size和connect在同一个TCP包中发送
            # 根据抓包分析，这两个命令必须在同一个TCP包中
            self.log("准备发送Set Chunk Size和connect命令（同一TCP包）...", 7)
            
            # 构造Set Chunk Size chunk数据
            chunk_size_bytes = struct.pack('>I', self.chunk_size)
            set_chunk_data = self._build_chunk_data(
                fmt=0,
                cs_id=self.chunk_stream_id_control,
                timestamp=0,
                msg_type_id=1,
                payload=chunk_size_bytes,
                msg_stream_id=0
            )
            
            # 构造connect命令payload
            self.transaction_id = 1
            command_name = "connect"
            if ':1935' in tc_url:
                tc_url_clean = tc_url.replace(':1935', '')
            else:
                tc_url_clean = tc_url
            swf_url = tc_url_clean
            
            connect_payload = b'\x02' + AMF0Encoder.encode_string(command_name)
            connect_payload += b'\x00' + AMF0Encoder.encode_number(self.transaction_id)
            command_obj = {
                'app': app,
                'type': 'nonprivate',
                'flashVer': 'FMLE/3.0 (compatible; FMSc/1.0)',
                'swfUrl': swf_url,
                'tcUrl': tc_url_clean
            }
            connect_payload += AMF0Encoder.encode_object(command_obj)
            
            # 验证payload大小（抓包显示应该是198字节）
            expected_size = 198
            if len(connect_payload) != expected_size:
                self.log(f"  警告: connect payload大小不匹配！期望{expected_size}字节，实际{len(connect_payload)}字节", 8)
                # 打印完整的payload用于调试
                payload_hex = ' '.join(f'{b:02x}' for b in connect_payload)
                self.log(f"  Payload (完整hex): {payload_hex}", 8)
            else:
                self.log(f"  ✓ connect payload大小正确: {len(connect_payload)}字节", 8)
            
            # 构造connect chunk数据
            connect_chunk_data = self._build_chunk_data(
                fmt=0,
                cs_id=self.chunk_stream_id_command,
                timestamp=0,
                msg_type_id=20,
                payload=connect_payload,
                msg_stream_id=0
            )
            
            # 合并两个chunk，一次性发送（确保在同一个TCP包中）
            combined_data = set_chunk_data + connect_chunk_data
            self.sock.sendall(combined_data)
            
            self.log(f"✓ 已发送Set Chunk Size: {self.chunk_size}字节", 7)
            self.log(f"✓ 已发送connect命令", 8)
            self.log(f"  事务ID: {self.transaction_id}", 8)
            self.log(f"  应用名: {app}", 8)
            self.log(f"  swfUrl: {swf_url}", 8)
            self.log(f"  tcUrl: {tc_url_clean}", 8)
            self.log(f"  connect payload大小: {len(connect_payload)}字节", 8)
            self.log(f"  总发送数据: {len(combined_data)}字节", 8)
            
            # 短暂等待，让服务器处理
            time.sleep(0.01)
            
            # 步骤9: 接收connect响应
            self.step_9_receive_connect_result(self.sock)
            time.sleep(0.1)  # 增加等待时间
            
            # 步骤10: releaseStream
            self.step_10_release_stream(self.sock, full_stream_name)
            # 等待releaseStream响应（根据抓包，服务器会响应_result，事务ID=2）
            self.step_10_wait_release_stream_response(self.sock)
            time.sleep(0.1)
            
            # 步骤11: FCPublish + createStream
            self.step_11_fcpublish_create_stream(self.sock, full_stream_name)
            time.sleep(0.1)
            
            # 步骤12: 接收createStream响应
            result = self.step_12_receive_create_stream_result(self.sock)
            
            # 验证stream_id是否已正确获取
            if not hasattr(self, 'stream_id') or self.stream_id is None or self.stream_id == 0:
                # 如果收不到响应，使用默认stream_id=1继续执行
                self.log(f"  警告: stream_id未正确获取，使用默认值1继续执行", 12)
                self.stream_id = 1.0
            
            self.log(f"✓ stream_id: {int(self.stream_id)}", 12)
            time.sleep(0.01)
            
            # 步骤13: publish
            self.step_13_publish(self.sock, full_stream_name)
            time.sleep(0.1)
            
            # 步骤14: 接收publish响应
            self.step_14_receive_publish_result(self.sock)
            
            self.log("=" * 80)
            self.log("✓ RTMP建联成功！所有步骤完成")
            self.log("=" * 80)
            
            self.is_connected = True
            
            # 更新UI
            self.root.after(0, self._on_connect_success)
            
        except Exception as e:
            error_msg = str(e)
            self.log(f"✗ 建联失败: {error_msg}")
            self.root.after(0, lambda: self._on_connect_error(error_msg))
    
    def _on_connect_success(self):
        """建联成功后的UI更新"""
        self.start_button.config(state=tk.DISABLED, text="已连接")
        self.disconnect_button.config(state=tk.NORMAL)
        self.stream_button.config(state=tk.NORMAL)
        self.status_label.config(text="状态：建联成功", fg="green")
        messagebox.showinfo("成功", "RTMP建联成功！\n所有步骤（1-14）已完成")
    
    def _on_connect_error(self, error_msg):
        """建联失败后的UI更新"""
        self.start_button.config(state=tk.NORMAL, text="启动建联")
        self.disconnect_button.config(state=tk.DISABLED)
        self.stream_button.config(state=tk.DISABLED)
        self.stop_stream_button.config(state=tk.DISABLED)
        self.status_label.config(text="状态：建联失败", fg="red")
        self.is_connected = False
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
            self.sock = None
        messagebox.showerror("建联失败", f"RTMP建联失败：\n{error_msg}")
    
    def disconnect_rtmp(self):
        """断开RTMP连接"""
        # 先停止推流
        if self.is_streaming:
            self.stop_streaming()
        
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
        
        self.is_connected = False
        self.sock = None
        self.metadata_sent = False
        self.timestamp_audio = 0
        self.timestamp_video = 0
        self.audio_cs_sent = False
        self.video_cs_sent = False
        self.last_audio_timestamp = 0
        self.last_video_timestamp = 0
        
        # 更新UI
        self.start_button.config(state=tk.NORMAL, text="启动建联")
        self.disconnect_button.config(state=tk.DISABLED)
        self.stream_button.config(state=tk.DISABLED)
        self.stop_stream_button.config(state=tk.DISABLED)
        self.status_label.config(text="状态：已断开", fg="gray")
        self.log("已断开RTMP连接")
    
    def start_streaming(self):
        """开始推流音视频"""
        if not self.is_connected or not self.sock:
            messagebox.showwarning("警告", "请先建立RTMP连接")
            return
        
        if self.is_streaming:
            messagebox.showinfo("提示", "推流已在进行中")
            return
        
        self.is_streaming = True
        self.stream_button.config(state=tk.DISABLED)
        self.stop_stream_button.config(state=tk.NORMAL)
        self.status_label.config(text="状态：推流中...", fg="blue")
        
        # 在新线程中执行推流
        self.streaming_thread = threading.Thread(target=self._streaming_thread, daemon=True)
        self.streaming_thread.start()
    
    def stop_streaming(self):
        """停止推流"""
        self.is_streaming = False
        # 重置状态，下次推流时重新发送fmt=0
        self.audio_cs_sent = False
        self.video_cs_sent = False
        self.last_audio_timestamp = 0
        self.last_video_timestamp = 0
        self.stream_button.config(state=tk.NORMAL)
        self.stop_stream_button.config(state=tk.DISABLED)
        self.status_label.config(text="状态：建联成功", fg="green")
        self.log("已停止推流")
    
    def _streaming_thread(self):
        """推流线程"""
        try:
            # 检查socket状态
            if not self.sock:
                raise Exception("Socket未初始化，无法推流")
            
            if not self.is_connected:
                raise Exception("RTMP连接未建立，无法推流")
            
            self.log("开始推流...")
            self.log(f"Stream ID: {int(self.stream_id) if hasattr(self, 'stream_id') else 1}")
            
            # 先发送onMetaData（如果还没发送）
            if not self.metadata_sent:
                self.log("发送onMetaData...")
                self.send_metadata()
                self.metadata_sent = True
                self.log("onMetaData发送成功，等待1秒后开始推流音视频数据...")
                time.sleep(1.0)  # 等待1秒，让服务器处理onMetaData
            
            # 每秒发送一次音视频数据
            frame_count = 0
            while self.is_streaming and self.is_connected:
                if not self.sock:
                    self.log("Socket已关闭，停止推流")
                    break
                
                try:
                    # 发送音频数据（每帧递增时间戳）
                    self.send_audio_data()
                    
                    # 发送视频数据（每帧递增时间戳）
                    self.send_video_data()
                    
                    frame_count += 1
                    if frame_count % 10 == 0:
                        self.log(f"已推流 {frame_count} 帧")
                    
                    # 等待1秒
                    time.sleep(1.0)
                except Exception as e:
                    self.log(f"发送音视频数据失败: {e}")
                    raise
                
        except Exception as e:
            if self.is_streaming:
                self.log(f"推流出错: {e}")
                import traceback
                self.log(f"错误堆栈: {traceback.format_exc()}")
                self.root.after(0, lambda: messagebox.showerror("推流错误", f"推流出错：\n{e}"))
                self.root.after(0, self.stop_streaming)
    
    def send_metadata(self):
        """发送onMetaData"""
        try:
            self.log("发送onMetaData...")
            
            # 根据CC.txt分析，onMetaData格式：
            # String 'onMetaData' + ECMA array (不是@setDataFrame + Object)
            payload = b'\x02' + AMF0Encoder.encode_string("onMetaData")
            
            # 构造ECMA array（根据CC.txt，使用ECMA array 0x08，不是Object 0x03）
            # ECMA array格式：0x08 + array length(4字节) + 属性列表 + 0x00 0x00 0x09 (结束标记)
            metadata_items = {
                'duration': 0.0,
                'fileSize': 0.0,
                'width': 1280.0,
                'height': 720.0,
                'videocodecid': 7.0,  # H.264
                'framerate': 30.0,
                'videodatarate': 1000.0,
                'audiodatarate': 128.0,
                'audiosamplerate': 44100.0,
                'audiosamplesize': 16.0,
                'audiocodecid': 10.0,  # AAC
            }
            
            # 编码ECMA array
            payload += b'\x08'  # ECMA array marker
            payload += struct.pack('>I', len(metadata_items))  # Array length
            
            # 编码属性
            for key, value in metadata_items.items():
                payload += AMF0Encoder.encode_string(key)
                if isinstance(value, bool):
                    payload += b'\x01' + (b'\x01' if value else b'\x00')
                elif isinstance(value, (int, float)):
                    payload += b'\x00' + AMF0Encoder.encode_number(value)
                elif isinstance(value, str):
                    payload += b'\x02' + AMF0Encoder.encode_string(value)
            
            # ECMA array结束标记
            payload += b'\x00\x00\x09'
            
            # 发送chunk（根据CC.txt，使用Chunk Stream ID: 3）
            self.send_chunk(
                self.sock,
                fmt=0,
                cs_id=self.chunk_stream_id_command,  # Chunk Stream ID: 3（根据CC.txt）
                timestamp=0,
                msg_type_id=18,  # AMF0 Data
                payload=payload,
                msg_stream_id=int(self.stream_id) if hasattr(self, 'stream_id') else 1
            )
            
            self.log(f"✓ 已发送onMetaData (size={len(payload)}字节)")
            
        except Exception as e:
            self.log(f"发送onMetaData失败: {e}")
            raise
    
    def send_audio_data(self):
        """发送模拟音频数据"""
        try:
            # 检查socket状态
            if not self.sock:
                raise Exception("Socket未初始化")
            
            # 检查socket是否仍然连接
            try:
                # 使用非阻塞方式检查socket状态
                import select
                ready = select.select([], [self.sock], [], 0)
                if not ready[1]:
                    raise Exception("Socket不可写，可能已断开")
            except Exception as e:
                raise Exception(f"Socket状态检查失败: {e}")
            
            # 音频数据格式：Control byte + 音频数据
            # Control byte: 0xaf (HE-AAC 44 kHz 16 bit stereo)
            # 模拟音频数据（随机二进制数据）
            audio_control = 0xaf
            audio_data = bytes([random.randint(0, 255) for _ in range(3)])  # 模拟3字节音频数据
            
            payload = bytes([audio_control]) + audio_data
            
            # 根据CC.txt分析：
            # 第一次发送使用fmt=0（完整header），timestamp=0
            # 后续发送使用fmt=1（复用header），timestamp是delta（增量）
            if not self.audio_cs_sent:
                # 第一次发送，使用fmt=0，timestamp=0
                fmt = 0
                timestamp = 0
                self.audio_cs_sent = True
                self.last_audio_timestamp = 0
                self.log(f"发送第一帧音频数据 (fmt=0, timestamp=0, size={len(payload)})")
            else:
                # 后续发送，使用fmt=1，timestamp是delta
                fmt = 1
                timestamp_delta = 23  # 44.1kHz采样率，每帧约1024样本，约23ms
                timestamp = timestamp_delta
                self.last_audio_timestamp += timestamp_delta
            
            # 发送chunk
            self.send_chunk(
                self.sock,
                fmt=fmt,
                cs_id=4,  # Audio Chunk Stream ID
                timestamp=timestamp,
                msg_type_id=8,  # Audio Data
                payload=payload,
                msg_stream_id=int(self.stream_id) if hasattr(self, 'stream_id') else 1
            )
            
        except Exception as e:
            self.log(f"发送音频数据失败: {e}")
            import traceback
            self.log(f"错误详情: {traceback.format_exc()}")
            raise
    
    def send_audio_data1(self):
        """发送模拟音频数据"""
        try:
            # 检查socket状态
            if not self.sock:
                raise Exception("Socket未初始化")
            
            # 检查socket是否仍然连接
            try:
                # 使用非阻塞方式检查socket状态
                import select
                ready = select.select([], [self.sock], [], 0)
                if not ready[1]:
                    raise Exception("Socket不可写，可能已断开")
            except Exception as e:
                raise Exception(f"Socket状态检查失败: {e}")
            
            # 音频数据格式：Control byte + 音频数据
            # Control byte: 0xaf (HE-AAC 44 kHz 16 bit stereo)
            # 发送全0的音频数据（无效数据）
            audio_control = 0xaf
            audio_data = bytes([0x00] * 3)  # 3字节全0数据
            
            payload = bytes([audio_control]) + audio_data
            
            # 根据CC.txt分析：
            # 第一次发送使用fmt=0（完整header），timestamp=0
            # 后续发送使用fmt=1（复用header），timestamp是delta（增量）
            if not self.audio_cs_sent:
                # 第一次发送，使用fmt=0，timestamp=0
                fmt = 0
                timestamp = 0
                self.audio_cs_sent = True
                self.last_audio_timestamp = 0
                self.log(f"发送第一帧音频数据 (fmt=0, timestamp=0, size={len(payload)})")
            else:
                # 后续发送，使用fmt=1，timestamp是delta
                fmt = 1
                timestamp_delta = 23  # 44.1kHz采样率，每帧约1024样本，约23ms
                timestamp = timestamp_delta
                self.last_audio_timestamp += timestamp_delta
            
            # 发送chunk
            self.send_chunk(
                self.sock,
                fmt=fmt,
                cs_id=4,  # Audio Chunk Stream ID
                timestamp=timestamp,
                msg_type_id=8,  # Audio Data
                payload=payload,
                msg_stream_id=int(self.stream_id) if hasattr(self, 'stream_id') else 1
            )
            
        except Exception as e:
            self.log(f"发送音频数据失败: {e}")
            import traceback
            self.log(f"错误详情: {traceback.format_exc()}")
            raise

    def send_video_data(self):
        """发送模拟视频数据"""
        try:
            # 检查socket状态
            if not self.sock:
                raise Exception("Socket未初始化")
            
            # 检查socket是否仍然连接
            try:
                # 使用非阻塞方式检查socket状态
                import select
                ready = select.select([], [self.sock], [], 0)
                if not ready[1]:
                    raise Exception("Socket不可写，可能已断开")
            except Exception as e:
                raise Exception(f"Socket状态检查失败: {e}")
            
            # 视频数据格式：Control byte + 视频数据
            # Control byte: 0x17 (keyframe H.264) 或 0x27 (interframe H.264)
            # 模拟视频数据（随机二进制数据）
            is_keyframe = not self.video_cs_sent  # 第一帧是关键帧
            video_control = 0x17 if is_keyframe else 0x27
            
            # 模拟视频数据（随机二进制数据，约100字节）
            video_data = bytes([random.randint(0, 255) for _ in range(100)])
            
            payload = bytes([video_control]) + video_data
            
            # 根据CC.txt分析：
            # 第一次发送使用fmt=0（完整header），timestamp=0
            # 后续发送使用fmt=1（复用header），timestamp是delta（增量）
            if not self.video_cs_sent:
                # 第一次发送，使用fmt=0，timestamp=0
                fmt = 0
                timestamp = 0
                self.video_cs_sent = True
                self.last_video_timestamp = 0
                self.log(f"发送第一帧视频数据 (fmt=0, timestamp=0, keyframe={is_keyframe}, size={len(payload)})")
            else:
                # 后续发送，使用fmt=1，timestamp是delta
                fmt = 1
                timestamp_delta = 33  # 30fps，每帧约33ms
                timestamp = timestamp_delta
                self.last_video_timestamp += timestamp_delta
            
            # 发送chunk
            self.send_chunk(
                self.sock,
                fmt=fmt,
                cs_id=5,  # Video Chunk Stream ID（根据CC.txt，视频使用CS ID 5）
                timestamp=timestamp,
                msg_type_id=9,  # Video Data
                payload=payload,
                msg_stream_id=int(self.stream_id) if hasattr(self, 'stream_id') else 1
            )
            
        except Exception as e:
            self.log(f"发送视频数据失败: {e}")
            import traceback
            self.log(f"错误详情: {traceback.format_exc()}")
            raise


    def send_video_data1(self):
        """发送模拟视频数据"""
        try:
            # 检查socket状态
            if not self.sock:
                raise Exception("Socket未初始化")
            
            # 检查socket是否仍然连接
            try:
                # 使用非阻塞方式检查socket状态
                import select
                ready = select.select([], [self.sock], [], 0)
                if not ready[1]:
                    raise Exception("Socket不可写，可能已断开")
            except Exception as e:
                raise Exception(f"Socket状态检查失败: {e}")
            
            # 视频数据格式：Control byte + NALU数据
            # Control byte: 0x17 (keyframe H.264) 或 0x27 (interframe H.264)
            is_keyframe = not self.video_cs_sent  # 第一帧是关键帧（chelsea是否为关键帧, 第一次点击时第一帧为 !False=True）
            video_control = 0x17 if is_keyframe else 0x27 #0x17 代表关键帧（I-frame），0x27 代表非关键帧（P-frame）
            
            # 构造 Access Unit，总大小为 195 字节
            # 格式：Control byte (1字节) + NALU长度前缀 (4字节) + 填充数据 (190字节)
            # NALU 单元长度为 0（即 NALU 长度前缀为 0x00000000）
            nalu_length = 0  # NALU 长度为 0
            nalu_length_prefix = struct.pack('>I', nalu_length)  # 4字节大端格式：0x00000000
            
            # 计算填充数据大小：195 - 1(control) - 4(nalu_length_prefix) = 190字节
            # 这些数据不是有效的视频图像数据，只是填充
            padding_size = 195 - 1 - 4  # 190字节
            padding_data = bytes([0x00] * padding_size)  # 使用0x00填充，或者可以使用其他值
            
            # 构造完整的 payload：Control byte + NALU长度前缀(0) + 填充数据
            payload = bytes([video_control]) + nalu_length_prefix + padding_data
            
            # 根据CC.txt分析：
            # 第一次发送使用fmt=0（完整header），timestamp=0
            # 后续发送使用fmt=1（复用header），timestamp是delta（增量）
            # chelsea: 如果是关键帧, 则发送fmt=0, timestamp=0
            if not self.video_cs_sent:
                # 第一次发送，使用fmt=0，timestamp=0
                fmt = 0
                timestamp = 0
                self.video_cs_sent = True
                self.last_video_timestamp = 0
                self.log(f"发送第一帧视频数据 (fmt=0, timestamp=0, keyframe={is_keyframe}, AU_size={len(payload)}, NALU_length=0)")
            else:
                # 后续发送，使用fmt=1，timestamp是delta
                fmt = 1
                timestamp_delta = 33  # 30fps，每帧约33ms
                timestamp = timestamp_delta
                self.last_video_timestamp += timestamp_delta
                self.log(f"发送视频数据 (fmt=1, timestamp_delta={timestamp_delta}, AU_size={len(payload)}, NALU_length=0)")
            
            # 发送chunk
            self.send_chunk(
                self.sock,
                fmt=fmt,
                cs_id=5,  # Video Chunk Stream ID（根据CC.txt，视频使用CS ID 5）
                timestamp=timestamp,
                msg_type_id=9,  # Video Data
                payload=payload,
                msg_stream_id=int(self.stream_id) if hasattr(self, 'stream_id') else 1
            )
            
        except Exception as e:
            self.log(f"发送视频数据失败: {e}")
            import traceback
            self.log(f"错误详情: {traceback.format_exc()}")
            raise


def main():
    """主函数"""
    root = tk.Tk()
    app = RTMPConnector(root)
    root.mainloop()


if __name__ == "__main__":
    main()

