# dsh-remote-access

用手机或另一台电脑，通过**一个固定的本地端口**打开同一份官方 dsh Web 界面：二维码配对、密文登录、移动端适配，并在左侧栏提供一个管理面板。

它是给「局域网 + 自己的内网穿透」这种用法设计的：本机在固定端口上提供页面，你把穿透指向这个端口，然后把公网域名告诉插件（trust），手机端扫码配对、输一次密文就能用。

## 为什么需要它

dsh 的 Web 服务只信任 loopback 授权（`Host` 必须是 `127.0.0.1:<port>`），并且前端 index 需要一次性 process token 换来的 cookie。所以直接用 `http://192.168.x.x:7743` 或你的公网域名访问，拿到的是 **403**（`Host` 围栏）或 **401**（缺 cookie）。

本插件不复用那个端口，而是自己开一个监听端口做**反向代理**：把每个请求的 `Host` 改写成 `127.0.0.1:<dsh端口>`，并附上插件自己去换来的 inner-auth cookie。上游看到的始终是一次合法的本机请求，所以**不会出现 403**；而外部访问者看到的只是一张需要密文的登录页。

```
手机 / 公网浏览器
    │  http(s)://<你的域名或局域网IP>:8788
    ▼
dsh-remote-access 网关（固定端口 8788）
    │  改写 Host → 127.0.0.1:7743、附加 dsh-auth-* cookie、剥离 sec-* / x-forwarded-*
    ▼
官方 dsh Web 服务（127.0.0.1:7743）
```

## 安装

这是一个 dsh **bundle**（不是独立程序），需要装进某个 profile 才会出现。要求 dsh 已安装并能正常启动 Web 界面。

**方式一：让 dsh 的 Agent 装（最省事）**

把仓库下载到本地，然后在 dsh 里说：

> 把 `E:\path\to\dsh-remote-access` 这个 bundle 装进当前 profile

Agent 会用 `plugin_manager` 的 `install_bundle` 完成安装并启用。

**方式二：命令行**

```bash
git clone https://github.com/XJGonFree/dsh-remote-access.git
dsh plugin --profile <你的profile> add file:$PWD/dsh-remote-access
```

装完后该 bundle 还需要在 profile 的 patch 层里**启用**一次（`plugin_manager` 的 `set_plugin`，或让 Agent 帮你启用），重启/刷新 Web 界面即可在左侧栏看到 **远程访问** 图标。

**方式三：直接放进 profile**

把整个目录拷到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-remote-access`，并在该 profile 的 patch 层插入：

```yaml
- insert:
    - id: dsh-remote-access
      name: dsh-remote-access
```

插件没有任何运行时依赖（二维码编码器 `qr.js` 是自带的），所以不需要 `npm install`，也不需要联网。

## 快速开始

1. 打开左侧栏的 **远程访问** 面板。
2. **设置密文**（6–128 位）。密文只保存 `sha256(salt:密文)`，明文不落盘、不回传。
3. 点 **生成配对码**，用手机扫码（或复制链接在另一台电脑打开）。
4. 手机端会落到登录页，输入密文即可进入官方界面；配对过的设备会记在面板里，可随时单独撤销。

默认监听 `0.0.0.0:8788`，面板里会直接列出本机可用的局域网地址，例如 `http://192.168.1.105:8788`。

### 用你自己的内网穿透

穿透软件（frp / nps / Cloudflare Tunnel / 路由器端口映射都行）把公网域名指到本机的 `8788` 即可，然后在面板的 **公网地址** 里填你的公网基址，例如 `https://dsh.example.com`：

- 之后生成的二维码/链接会直接用这个公网地址，扫码即可从外网打开；
- 终端到网关这一段可以是 http，浏览器到公网域名的那一段由你的穿透提供 https；
- 插件不假设任何具体的穿透厂商，也不需要它的 SDK。

### Host trust

面板里的 **Host 白名单** 开关默认**关闭**，此时任何 `Host` 都放行——这就是「不会 403」的默认行为。

如果你希望只允许特定域名（例如只允许你的公网域名、拒绝别人用 IP 直连），打开开关后：

- `127.0.0.1` / `localhost` / `::1` 和本机所有局域网地址**自动信任**，不用手工加；
- 其余需要在白名单里显式列出，支持 `*.example.com` 这类通配；
- 不在白名单的请求返回 403，并会在页面上说明当前白名单内容，方便自查。

## 移动端适配

开启后（默认开），网关只对 `text/html` 响做两件事，**不改官方视觉**：

- 注入 `viewport`（`width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`）；
- 注入一段仅在 `max-width: 820px` 生效的样式：媒体不溢出、`pre`/表格横向滚动、输入框 `16px` 字号（避免 iOS 聚焦缩放）、对话框不超出屏幕、刘海屏安全区。

## 安全模型

- **控制面只对 loopback 开放**：面板用的 `/api/dsh-remote-access/*` 要求 `x-dsh-remote-access: 1` + 本机 socket + 同源，远程客户端无法改配置、无法关闭插件。
- **内层凭据不外泄**：上游返回的 `dsh-auth-*` cookie 在响应里被过滤掉；其它 cookie 正常透传。
- **转发头不外泄**：`sec-*`、`x-forwarded-*`、`cf-*`、`forwarded` 等全部剥离，上游无法据此判断真实来源。
- **配对令牌一次性**：默认 5 分钟有效，用过即失效（重放返回 410）。
- **设备 cookie 可撤销**：面板内可单个撤销或全部撤销。
- 密文错误有速率限制（5 分钟内最多 8 次失败）。

## 配置存放

`<DSH_HOME>/dsh-remote-access/config.json`（默认 `~/.dsh/...`），含端口、绑定地址、公网地址、白名单、密文哈希、已配对设备。删除该文件即可恢复默认（需要重载插件）。

## 端口与失败提示

- 默认固定端口 `8788`，可在面板修改（1024–65535），改完即时生效；
- 端口被占用会提示「端口 X 已被其它程序占用。」；
- 填成 dsh 自己的端口会被拒绝，避免自我代理成环。

## 平台

Windows / macOS / Linux 通用（只用 Node 内置模块）。二维码编码器是本仓库自带的 `qr.js`，零依赖、纯离线生成，不需要联网也不需要额外安装包。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | host 半程：配置与持久化、密文校验、inner-auth、反向代理（HTTP + WebSocket）、移动端注入、网关鉴权、面板 API |
| `client.js` | 浏览器半程：左侧栏入口 + 面板页面（开关、端口、公网地址、密文、白名单、配对二维码、设备列表） |
| `qr.js` | 零依赖 QR 编码器（byte 模式，纠错等级 M，版本 1–12），输出 SVG |
| `cordis.patch.yml` | 插入 bundle 的 patch |
| `locale/{zh,en}.json` | 插件标题与描述 |
| `icon.svg` | 侧边栏图标 |
