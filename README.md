# QB→TR 自动转移做种（DIAN115 插件）

自动将 qBittorrent 中已完成的任务转移到 Transmission 继续做种。

## 功能

- 扫描 qBittorrent 中已完成（做种中）的任务
- 通过磁力链接添加到 Transmission，使用相同的保存路径（TR 会校验已有文件）
- 可选：转移成功后从 qB 删除原任务（不删除文件）
- 支持手动立即转移，也支持配置定时 job 自动执行

## 构建

```bash
# 1. 编译 WASM
cd runtime
$env:GOOS="wasip1"; $env:GOARCH="wasm"
go build -o plugin.wasm .
node ../scripts/strip-start.mjs plugin.wasm

# 2. 构建前端
cd ../frontend
npm install
npm run build

# 3. 打包签名（生成 dist/qb2tr-transfer.d115p）
cd ..
npm install
node scripts/package.mjs

# 4. 验证
node scripts/verify.mjs
```

## 安装

在 DIAN115 插件中心 →「仓库与开发」→ 本地导入，选择 `dist/qb2tr-transfer.d115p`。

## 配置说明

### qBittorrent 认证（二选一）

DIAN115 会删除 HTTP 响应的 Set-Cookie 头，因此插件无法自动登录 qB。

**方案 A（推荐）：白名单**
在 qB WebUI → Options → Web UI → Authentication 中勾选「Bypass authentication for clients in whitelisted IP subnets」，填入 DIAN115 容器所在网段（如 `172.17.0.0/16` 或具体容器 IP）。插件中 SID 留空。

**方案 B：手动 SID**
浏览器登录 qB WebUI 后，F12 → Application → Cookies → 复制 `SID` 的值，填入插件的 qB SID 字段。

### Transmission 认证

如果 TR 开启了用户名密码认证，填入即可（使用 HTTP Basic Auth）。无认证则留空。

### 地址

默认使用 Docker 服务名 `qb` 和 `tr`。如果你的容器名不同或用 IP/端口，请修改为实际地址。

## 文件结构

```
manifest.json              插件清单（符合官方 schema）
runtime/main.go            WASM 运行时源码（Go）
runtime/go.mod
runtime/plugin.wasm        编译产物（已去掉 _start，reactor 模式）
frontend/src/AppPage.vue   Vue 3 页面（Naive UI + bridge API）
frontend/package.json
frontend/vite.config.ts    Module Federation 配置
frontend/dist/             构建产物
scripts/package.mjs        打包签名脚本（Ed25519 + RFC8785 JCS）
scripts/strip-start.mjs    去掉 wasm 的 _start 导出
scripts/verify.mjs         包验证脚本
plugin-market/index.json   插件市场索引
dist/qb2tr-transfer.d115p  最终安装包
```

## 注意

- 配置保存在 WASM 运行时内存中，插件 worker 重启后需重新保存
- 首次使用建议先取消「转移后从 QB 删除」，确认 TR 做种正常后再开启
- TR 添加磁力后会自动校验已有文件，不需要重新下载
