# File-Transfer 后端业务文档（供 Java 重写）

> 本文档基于 `server/` 目录下 TypeScript 实现，描述 Express + WebSocket + 分片文件传输系统的完整业务逻辑。Java 版可直接按此接口契约实现。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────┐
│  Client (React/Vite)                                │
│  - 前端 Vite 开发服务器 (middlewareMode)              │
│  - 加密: AES-256-GCM (客户端侧)                      │
└──────────────────┬──────────────────────────────────┘
                   │
  HTTP :4782  (REST) +  WS :4782/ws  (二进制)
                   │
┌──────────────────▼──────────────────────────────────┐
│  Node.js Server  ←→  Java Spring Boot Server (目标) │
│  ├─ Express (REST)                                  │
│  ├─ WebSocketServer (/ws)                           │
│  ├─ 内存状态: peers/transfers/knownDevices          │
│  ├─ 持久化: uploads/transfers.json                   │
│  └─ 文件分片: uploads/chunks/<transferId>/<n>.part │
└─────────────────────────────────────────────────────┘
```

**设计原则**：

| 特性 | 说明 |
|------|------|
| 无数据库 | 状态存内存 + JSON 文件定时持久化（24h TTL 清理） |
| 无鉴权 | ownerToken 作为上传/下载/删除的唯一凭证 |
| 加密客户端完成 | 服务端只存加密后分片，不解密 |
| 心跳超时 | 5s 间隔 ping，12s 未响应视为掉线 |
| 设备身份 | deviceId 客户端提供或服务端生成，displayCode 由 deviceId 派生（SHA-256） |
| 两种传输模式 | 局域网直传（需接收方同意） / 取件码（无需对端在线） |

---

## 2. 数据模型

### 2.1 TransferRecord（传输记录）

```ts
interface TransferRecord {
  id: string;                          // "tr_" + 24 hex (文件) / "tx_" + 24 hex (文本)
  pickupCode: string;                  // 6 位数字，100000-999999
  kind: 'file' | 'text';
  
  ownerToken: string;                  // 24 hex，上传/删除凭证
  
  senderDeviceId?: string;             // 发送方 deviceId
  senderDeviceName?: string;           // 发送方显示名
  targetDeviceId?: string;             // 局域网直传时有值
  
  status: 'pending' | 'uploading' | 'ready';
  
  createdAt: number;                   // Date.now() ms
  expiresAt: number;                   // createdAt + 24h
  downloadCount: number;
  maxDownloads: number | null;         // 下载次数上限，null=无限制
  
  encryption: {
    enabled: boolean;
    algorithm?: 'AES-256-GCM';
    salt?: string;                     // base64
    baseIv?: string;                   // base64
    iv?: string;                       // 文本传输用
  };
  
  // 文件字段
  fileName?: string;                   // sanitize 后，最长 200
  mimeType?: string;
  fileSize?: number;
  chunkSize?: number;                  // 默认 1MB
  totalChunks?: number;
  uploadedChunks?: number[];           // 已上传分片索引（升序）
  fingerprint?: string;                // 用于断点续传校验
  
  // 文本字段
  textContent?: string;
  textByteLength?: number;              // utf-8 字节长度，上限 2MB
}
```

**状态机**：

```
局域网直传:
  pending ──(接收方 accept)──→ uploading ──(全部分片上传)──→ ready ──(ack consume=1)──→ 销毁
  
取件码模式:
  uploading ──(全部分片上传)──→ ready ──(ack consume=1)──→ 销毁
```

### 2.2 DeviceEntry（设备注册）

```ts
interface DeviceEntry {
  deviceId: string;                    // "dev_" + 12 hex 或客户端自提供
  displayCode: string;                 // 6 位，SHA-256(deviceId) 前 6 字节映射
  createdAt: number;
}
```

### 2.3 PeerClient（在线设备）

```ts
interface PeerClient {
  deviceId: string;
  deviceName: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  ip: string;
  subnet: string;                       // "192.168.31.0/24" 或 IPv6 /64
  connectedAt: number;
  lastSeenAt: number;
  rttMs: number;                        // 最近一次 ping→pong 耗时
  pingSentAt?: number;                  // 当前 ping 发送时间
}
```

### 2.4 服务端内存 Map

| Map | Key | Value | 说明 |
|-----|-----|-------|------|
| `peers` | deviceId | PeerClient | 在线 WebSocket 连接 |
| `knownDevices` | deviceId | DeviceEntry | 所有见过的设备（含离线） |
| `transfers` | transferId | TransferRecord | 所有未过期传输 |
| `codeToId` | pickupCode | transferId | 取件码→ID 反查 |
| `recentOfflineAt` | deviceId | timestamp | 3s 离线信号去重窗口 |

---

## 3. REST API

### 3.1 健康检查

```
GET /api/health
→ 200 {"ok": true, "timestamp": 1795700000000}
```

### 3.2 设备引导

```
GET /api/device/bootstrap?deviceId=<可选>
→ 200 {
    "deviceId": "dev_abc123...",
    "displayCode": "A7K2P9",
    "createdAt": 1795700000000
  }
```

- 服务端优先使用客户端传来的 deviceId（需通过 `isValidId`：`^[a-zA-Z0-9_-]{8,64}$`）
- displayCode = `deriveDisplayCode(deviceId)`：用 `ABCDEFGHJKMNPQRSTUVWXYZ23456789` 字母表，SHA-256 取前 6 字节 % 字母表长度生成

### 3.3 连接测试

```
GET /api/connection-test
→ 200 {
    "ok": true,
    "latencyMs": 12,
    "wsClients": 5,
    "sameSubnetPeers": 3,
    "yourIp": "192.168.31.221",
    "subnet": "192.168.31.0/24"
  }
```

### 3.4 网络扫描

```
GET /api/network/info
→ 200 { "ip": "...", "subnet": "...", "onlineCount": 3 }

GET /api/peers/scan?deviceId=<可选>
→ 200 {
    "yourIp": "...", "subnet": "...", "scannedAt": 1795700000000,
    "peers": [
      {
        "deviceId": "...", "displayCode": "A7K2P9",
        "deviceName": "张三的Mac", "deviceType": "desktop",
        "ip": "192.168.31.15",
        "sameIp": true, "rttMs": 8, "connectedAt": ...
      }
    ]
  }
```

- peers 列表按 `sameIp DESC, deviceName ASC` 排序
- exclude 参数通过 deviceId 排除自己

### 3.5 主动下线

```
POST /api/device/offline
Content-Type: application/json

{ "deviceId": "dev_xxx" }
→ 204
```

### 3.6 初始化文件传输（含断点续传）

```
POST /api/transfers/init
Content-Type: application/json

{
  "fileName": "report.pdf",              // 必填
  "mimeType": "application/pdf",         // 可选
  "fileSize": 1234567,                   // 必填
  "chunkSize": 1048576,                  // 可选，64KB-8MB，默认 1MB
  "fingerprint": "sha256:...",           // 可选
  "encryption": { "enabled": true, "salt": "...", "baseIv": "..." },
  "resumeTransferId": "tr_xxx",          // 续传时提供
  "ownerToken": "hex24...",              // 续传时提供
  "senderDeviceId": "dev_xxx",
  "senderDeviceName": "我的设备",
  "targetDeviceId": "dev_yyy",           // 局域网直传；不填则为取件码模式
  "maxDownloads": null
}
```

**响应** — 新传输：

```json
// 局域网直传：status=pending （等接收方 accept）
// 取件码模式：status=uploading
{
  "resumed": false,
  "transferId": "tr_abc...",
  "pickupCode": "782914",
  "ownerToken": "hex24...",
  "chunkSize": 1048576,
  "totalChunks": 2,
  "uploadedChunks": [],
  "status": "pending",
  "encryption": { "enabled": true, "algorithm": "AES-256-GCM", ... }
}
```

**响应** — 续传命中：

```json
{
  "resumed": true,
  "transferId": "tr_abc...",
  "pickupCode": "782914",
  "uploadedChunks": [0],              // 扫描磁盘后实际存在的分片
  "status": "uploading",
  ...
}
```

**续传匹配条件**：`ownerToken` 匹配 + `fileSize` 相同 + `fingerprint` 匹配（若有）。匹配后扫描 `uploads/chunks/<id>/` 目录，返回磁盘上实际存在的分片列表，发送方据此跳过已上传分片。

**副作用**：
- 若 `targetDeviceId` 存在，通过 WebSocket 向其推送 `transfer:incoming` 消息
- 续传时若 `targetDeviceId` 存在，推送 `transfer:resumed` 消息

### 3.7 上传分片

```
PUT /api/transfers/:id/chunk/:index
Content-Type: application/octet-stream
X-Owner-Token: <ownerToken>

<二进制数据>
```

- index 范围：`0 ≤ index < totalChunks`
- 分片写入 `uploads/chunks/<transferId>/<index>.part`
- 服务端将 index 追加到 `uploadedChunks[]`（Set 去重后排序）
- 每次上传后，若有 targetDeviceId，通过 WS 推送 `transfer:progress`

```
→ 200 {
    "ok": true,
    "chunkIndex": 5,
    "uploadedChunksCount": 6,
    "totalChunks": 12
  }
```

### 3.8 标记上传完成

```
POST /api/transfers/:id/complete
Content-Type: application/json
X-Owner-Token: <ownerToken>
{}
```

服务端校验磁盘上所有 0..totalChunks-1 分片都存在，否则返回 409 + missingChunks。

```
→ 200 { "ok": true, "transfer": <TransferSummary> }
→ 409 { "error": "仍有分片未上传完成", "missingChunks": [3, 7, 8] }
```

副作用：向 targetDeviceId 推送 `transfer:ready`。

### 3.9 文本传输

```
POST /api/transfers/text
Content-Type: application/json

{
  "textContent": "hello world",    // utf-8，≤ 2MB
  "encryption": { ... },
  "senderDeviceId": "...",
  "senderDeviceName": "...",
  "targetDeviceId": "...",
  "maxDownloads": null
}
→ 201 { "ok": true, "ownerToken": "...", "transfer": <TransferSummary> }
```

创建后直接 status=ready。

### 3.10 按取件码查询

```
GET /api/transfers/code/:code
→ 200 { "transfer": <TransferSummary> }
→ 404 { "error": "取件码无效或已过期" }
```

code 正则：`/^[A-Z0-9]{6}$/i`。过期/不存在时会调用 `removeTransferData` 删除对应文件。

### 3.11 查询传输状态

```
GET /api/transfers/:id/status
→ 200 { "transfer": <TransferSummary>, "uploadedChunks": [0, 1, 2] }
```

### 3.12 下载单个分片

```
GET /api/transfers/:id/chunk/:index
→ 200 binary/octet-stream
Content-Type: application/octet-stream
X-Content-Type-Options: nosniff
```

下载最后一片（index = totalChunks - 1）时递增 downloadCount。

### 3.13 全文件下载（非加密文件）

```
GET /api/transfers/:id/download
→ 200 streaming
Content-Type: <record.mimeType || application/octet-stream>
Content-Disposition: attachment; filename="download"; filename*=UTF-8''<url编码文件名>
Content-Length: <totalSize>
```

逐片 stream 拼接。加密文件返回 400。

### 3.14 接收确认 / 取件码消费

```
POST /api/transfers/:id/ack?consume=1
→ 200 { "ok": true, "consumed": true }     // consume=1
→ 200 { "ok": true, "downloadCount": 1 }  // 非 consume
```

- consume=1：删除 transfer + 删除分片目录 + 取件码失效 + 通过 WS 向 senderDeviceId 推送 `transfer:downloaded`
- 不取件码：仅累加 downloadCount + 持久化

### 3.15 删除传输

```
DELETE /api/transfers/:id
X-Owner-Token: <ownerToken>
→ 200 { "ok": true }
```

---

## 4. WebSocket 协议

连接：`ws://host:4782/ws`，HTTP upgrade path `/ws`。

### 4.1 客户端 → 服务端

| type | 字段 | 说明 |
|------|------|------|
| `device:register` | `deviceId`, `deviceName`, `deviceType` | 注册/上线，首次消息必发 |
| `device:unregister` | — | 页面离开，立即移除 peer |
| `scan:request` | — | Ping 同网段设备刷新 RTT |
| `ping` | — | 通用 ping |
| `transfer:accept` | `transferId` | 接收方同意接收 pending 传输 |
| `transfer:decline` | `transferId` | 接收方拒绝 |
| `transfer:close` | `transferId` | 接收方关闭面板 |
| `transfer:downloaded` | `transferId` | 接收方已点击下载 |

### 4.2 服务端 → 客户端

| type | 字段 | 触发时机 |
|------|------|----------|
| `device:registered` | `deviceId`, `yourIp`, `subnet`, `peers[]` | register 响应 |
| `peers:update` | `yourIp`, `subnet`, `peers[]` | 任何 peer 上线/下线/扫描 |
| `transfer:incoming` | `transfer` | 发送方 init 且指定了 targetDeviceId |
| `transfer:resumed` | `transfer` | 续传恢复后，或设备重上线时仍有 uploading 传输 |
| `transfer:progress` | `transferId`, `uploadedChunksCount`, `totalChunks`, `progress` | 每次分片上传后 |
| `transfer:ready` | `transfer` | complete 完成 / text 创建 |
| `transfer:accepted` | `transferId` | 接收方 accept |
| `transfer:declined` | `transferId`, `pickupCode` | 接收方 decline |
| `transfer:closed` | `transferId` | 接收方 close |
| `transfer:downloaded` | `transferId`, `fileName?` | ack consume=1 或客户端主动发 transfer:downloaded |
| `transfer:target-offline` | `transferId` | 接收方离线（服务端判定） |
| `transfer:sender-offline` | `transferId` | 发送方离线（服务端判定） |
| `scan:results` | `yourIp`, `subnet`, `peers[]` | scan:request 响应（延迟 180ms） |
| `pong` | `ts` | ping 响应 |

### 4.3 心跳机制

```
服务端每 5s 对 peers 中所有 WebSocket.OPEN 的连接发 ping()
客户端通过 pong 事件更新 lastSeenAt 和 rttMs
若 12s 内 lastSeenAt 无更新 → 标记掉线 (hard=true)
```

掉线 hard=true 时：
- 移除 peer 记录
- 通知所有相关传输的对端（target-offline / sender-offline）
- 若对端没有其他进行中传输 → 主动 terminate 对端连接

### 4.4 离线信号去重

同一设备短时间内可能收到多个离线信号（sendBeacon、unregister、socket close、心跳超时）。服务端维护 `recentOfflineAt: Map<deviceId, timestamp>`，3 秒内重复信号直接忽略。超过 512 条时清理过期条目。

### 4.5 同一设备重连

同一 deviceId 重新 register 时：
1. 创建新 PeerClient 覆盖 `peers[deviceId]`
2. 旧连接 ws.terminate()（但它的 close 事件因为 `peers[deviceId].ws !== oldWs` 所以不会误删新连接）
3. 3 秒离线去重窗口内若刚处理过离线 + 新连接 connectedAt < 3s → `removePeerImmediately` 跳过，避免删了刚上线的设备

---

## 5. 关键业务流程

### 5.1 局域网直传完整流程

```
发送方A                              服务端                             接收方B
  │   POST init {targetDeviceId:B}   │                                  │
  │ ──────────────────────────────► │                                  │
  │                                  │──transfer:incoming──────────────►│
  │◄──────── 201 {status:pending}   │                                  │
  │                                  │                                  │
  │                                  │◄─────transfer:accept (WS)─────    │
  │◄── transfer:accepted (WS)─────── │                                  │
  │                                  │  record.status = 'uploading'     │
  │                                  │                                  │
  │   PUT chunk/0                    │                                  │
  │ ──────────────────────────────► │──transfer:progress──────────────►│
  │   PUT chunk/1 ...                │                                  │
  │                                  │                                  │
  │   POST complete                  │                                  │
  │ ──────────────────────────────► │──transfer:ready─────────────────►│
  │◄──────── 200 ready              │                                  │
  │                                  │                                  │
  │                                  │◄──── GET chunk/:n (循环下载)      │
  │                                  │◄──── POST ack?consume=1          │
  │◄── transfer:downloaded (WS)───── │                                  │
  │                                  │  删除文件 + 记录                  │
```

### 5.2 取件码模式

```
发送方A                              服务端                             接收方B
  │   POST init (无targetDeviceId)   │                                  │
  │ ──────────────────────────────► │                                  │
  │◄── 201 {pickupCode:"782914",     │                                  │
  │         status:"uploading"}      │                                  │
  │   PUT chunk/0...complete         │                                  │
  │ ──────────────────────────────► │                                  │
  │                                  │                                  │
  │                                  │ GET /api/transfers/code/782914    │
  │                                  │ ────────────────────────────────►│
  │                                  │◄──────── 200 ready              │
  │                                  │                                  │
  │                                  │ GET /api/transfers/:id/chunk/0..n │
  │                                  │ ────────────────────────────────►│
  │                                  │                                  │
  │                                  │ POST /api/transfers/:id/ack?consume=1 │
  │                                  │ ────────────────────────────────►│
  │◄── transfer:downloaded (WS)──── │                                  │
  │                                  │  删除文件 + 记录 + codeToId      │
```

### 5.3 断点续传

```
发送方A（重连）                       服务端
  │  POST init {resumeTransferId, ownerToken, fileSize, fingerprint}
  │ ────────────────────────────────────────────────────────►
  │                                                          扫描 uploads/chunks/<id>/ 目录
  │◄── 200 resumed:true, uploadedChunks:[0,1,5,6]          返回实际存在的分片索引
  │
  │  PUT chunk/2... (跳过 0,1,5,6)
  │ ────────────────────────────────────────────────────────►
```

### 5.4 持久化与清理

- 每次 transfers 有变更 → `scheduleSaveIndex()` 200ms debounce → 写 `uploads/transfers.json`
- 服务启动时 `loadTransfersIndex()`：读 JSON 过滤 `expiresAt > now`
- 每 1h `cleanupExpiredTransfers()`：调 `removeTransferData` 删除过期记录和分片目录
- `removeTransferData`：`transfers.delete` + `codeToId.delete` + `fs.rmSync(uploadDir)`

### 5.5 IP / 子网处理

| 函数 | 逻辑 |
|------|------|
| `normalizeIp` | split(',')[0].trim(); `::ffff:` 前缀剥离; `::1` → `127.0.0.1` |
| `getSubnetKey` | IPv4 → `a.b.c.0/24`; IPv6 → 前 4 段 + `::/64` |
| `maskIpForDisplay` | 原样返回（代码中没有实际掩码） |
| `getRequestIp` | 优先 `x-forwarded-for` → `x-real-ip` → `socket.remoteAddress` |

---

## 6. 边界条件与错误处理

| 场景 | 处理 |
|------|------|
| 端口被占用 (EADDRINUSE) | 进程 exit(1)，错误日志 |
| WebSocket 单连接 error | 只 warn，不终止进程 |
| uncaughtException | 日志后继续运行 |
| 分片写入路径穿越 | `resolveConfinedPath` 白名单 baseDir 校验，非法抛错 |
| 取件码冲突 | 生成重试最多 50 次，仍冲突则返回随机（极罕见） |
| transfer init 大小超限 | fileSize < 0 / 非数字 → 400 |
| textContent 空 / 超 2MB | 400 |
| 分片索引越界 | 400 |
| ownerToken 不匹配 | 403 |
| transfer 过期 | 404 + 自动删除 |
| Vite dev middleware | 非 production 时挂 middlewareMode=true；production 用 express.static dist/ |
| `tsx watch` 热重启 | 监听 `server/` 目录，变更时 kill+重启 |

---

## 7. TransferSummary（对外字段）

所有 REST / WS 中传输对象都用此精简版，不含内部状态字段：

```ts
{
  id, pickupCode, kind, status,
  createdAt, expiresAt,
  downloadCount, maxDownloads,
  senderDeviceName,
  encryption: { enabled, algorithm, salt, baseIv, iv },
  fileName, mimeType, fileSize, chunkSize, totalChunks,
  uploadedChunksCount,       // ← 用 count 而非数组（避免大 payload）
  textContent?, textByteLength?
}
```

---

## 8. Java 实现建议

### 8.1 技术栈匹配

| Node/TS 能力 | Java 对应 |
|-------------|-----------|
| Express | Spring Boot + Spring Web (RouterFunction 或 @Controller) |
| ws (WebSocket) | Spring WebSocket (STOMP 或原生 TextWebSocketHandler) |
| `crypto.randomBytes` / `sha256` | `java.security.SecureRandom` / `MessageDigest` |
| 内存 Map | `ConcurrentHashMap` (peers/transfers) |
| JSON 持久化 | Jackson + `@Scheduled` 定时 flush |
| 文件分片读写 | `Files.write` / `Files.newInputStream` + `java.nio.file.Path` |
| `resolveConfinedPath` | `Path.normalize().startsWith(basePath)` 校验 |
| `trust proxy` / `x-forwarded-for` | Spring `ForwardedHeaderFilter` 或手动取 header |
| heartbeat 定时器 | `ScheduledExecutorService` 或 `@Scheduled(fixedDelay)` |

### 8.2 关键注意点

1. **TransferRecord 持久化**：启动时从 JSON/DB 加载，`expiresAt > now` 才恢复。`saveTimer` 的 200ms debounce 语义用 `CompletableFuture.delayedExecutor` 或 `ScheduledExecutorService.schedule`。

2. **WebSocket 离线去重**：`recentOfflineAt` 3 秒窗口用 `ConcurrentHashMap<String, Long>` + `putIfAbsent` 原子性校验。Java 的 `ConcurrentHashMap` 不保证 put 原子，建议用 `computeIfAbsent` 或显式锁。

3. **同一 deviceId 重连**：Spring WebSocket 的 session 替换逻辑要先 `peers.put(deviceId, newPeer)` 再 `oldSession.close()`，旧 session 的 close handler 里要检查 `peers.get(deviceId).session != thisSession` 才真正移除。

4. **分片完整性校验**：complete 端点遍历 `0..totalChunks-1` 检查磁盘文件存在性，Node 版用同步 `fs.existsSync`，Java 版用 `Files.exists(Path)`。

5. **transfer:resumed 推送时机**：两种场景 — (a) init 命中续传时推给 targetDeviceId；(b) device:register 时遍历 transfers 找 `targetDeviceId === devId && status === uploading && uploadedChunks.length > 0 && senderDeviceId 在线`。

6. **peers:update 广播**：每次拓扑变更（新上线 / 离线 / 扫描完成）向同网段所有活跃连接推送。Java 用 `CopyOnWriteArrayList<Session>` 维护，遍历时过滤 `session.isOpen()`。

7. **CORS / 代理信任**：如果 Java 版后面挂 Nginx，记得配置 `server.forward-headers-strategy=native`。

8. **生产端口与开发端口**：Spring Boot 用 `application.properties` 切换 `server.port` 即可，不需要 Vite middleware —— 前端单独 build 后让 Spring Boot 从 `classpath:/static` 或指定目录 serve 静态文件。

9. **`download` 流式拼接**：Java 版用 `StreamingResponseBody` + `Files.newInputStream` 逐片 copy 到 `OutputStream`，注意用 `try-with-resources` 及时释放文件句柄。

10. **分片路径安全**：所有文件路径构造用 `Paths.get(baseDir, transferId, index + ".part").normalize()`，然后断言 `startsWith(baseDir.normalize())`，否则抛异常返回 400。
