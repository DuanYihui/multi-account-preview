# 多账号预览工作台

这个工具用来同时预览多套账号的登录状态。每个“环境 + 账号”都有自己的浏览器存储；同一账号里的移动端、后台、收银台共用 Cookie，不同账号之间隔离。

可以把它理解成一个专门放浏览器小窗口的工作台：每个账号是一套餐具，移动端、后台、收银台可以在同一套餐具里共享登录态；不同账号用不同餐具，不会互相串味。

## 快速交给别人使用

把整个目录发给对方：

```text
tools/multi-account-preview
```

推荐启动方式：进入工具目录后直接启动桌面画布，脚本会在第一次运行时安装 Electron 依赖。

```bash
cd tools/multi-account-preview
./preview-accounts.sh desktop
```

如果当前终端已经在 `tools/multi-account-preview` 目录里，直接运行：

```bash
./preview-accounts.sh desktop
```

如果你的 Terminal 会弹出 oh-my-zsh 更新提示，双击 `.command` 可能会被提示拦截。先生成一个不会经过交互 zsh 的 macOS App 启动器：

```bash
./preview-accounts.sh make-app
```

然后双击根目录里生成的 `Multi-Account-Preview.app`。这个 App 包是本机生成产物，不提交到仓库。

不受 oh-my-zsh 影响的机器，也可以直接双击根目录里的 `Multi-Account-Preview.command`。

如果要直接运行 Electron 子项目，也可以这样：

```bash
cd tools/multi-account-preview/desktop-shell
npm start
```

配置文件默认放在：

```text
~/.account-preview-workbench/accounts.tsv
```

这个文件是每个人自己机器上的配置，不要提交，也不要直接复制别人的 Cookie 或本地状态目录。仓库里的 `.gitignore` 已忽略常见本地配置和浏览器状态路径，包括 `accounts.tsv`、`.account-preview-workbench/`、`electron-shell/`、`Local Storage/`、`Cookies` 等。

## 配置怎么换成自己的

先生成一份通用配置：

```bash
./preview-accounts.sh init
```

也可以参考仓库里的模板：

```text
accounts.example.tsv
```

配置格式：

```text
# enabled	env	account	page	url	x	y	width	height	profileKey	userAgent	deviceScaleFactor	mobileEmulation
yes	测试环境	默认账号	移动端	https://m.example.com	40	80	375	812	测试环境:默认账号			yes
yes	测试环境	默认账号	后台	https://admin.example.com	500	80	1440	820	测试环境:默认账号			no
no	测试环境	默认账号	收银台	https://cashier.example.com	1980	80	1440	820	测试环境:默认账号			no
```

字段说明：

- `enabled`：`yes` 会显示，`no` 会隐藏。
- `env`：环境名，比如生产示例、测试示例、本地示例。
- `account`：账号显示名，可以在界面里双击改名。
- `page`：窗口名，比如移动端、后台、收银台。
- `url`：要打开的页面地址。
- `x/y/width/height`：画布里的初始位置和尺寸。移动端常用 `375x812`，也可以在左侧窗口卡片里直接改宽高。
- `profileKey`：Cookie 隔离钥匙。想保留登录态就不要随便改它。
- `userAgent`：保留字段，普通使用留空即可。
- `deviceScaleFactor`：保留字段，当前界面不再暴露 DPR 设置。
- `mobileEmulation`：是否按移动端窗口处理。`yes` 会在左侧卡片显示宽高设置；`no` 按普通后台窗口处理。

## 让 Codex 自动替换配置

把这段话发给 Codex，通常就够了：

```text
请读取我的项目启动端口、登录路径和页面入口，把 tools/multi-account-preview/accounts.example.tsv 改成适合我项目的 accounts.tsv 配置。
要求：
1. 不要复制别人的 Cookie、token、账号密码。
2. 不要输出 Cookie 明文。
3. 每个环境默认 1 个账号，profileKey 保持为“环境名:账号名”。
4. 移动端用 375x812，mobileEmulation 设为 yes；后台/收银台用 1440 宽，mobileEmulation 设为 no。
5. 请同步设置 ACCOUNT_PREVIEW_SHARED_HOST_SUFFIXES 和 ACCOUNT_PREVIEW_AUTH_COOKIES。
```

重点让 Codex 换这几样：

- 页面 URL：正式、测试、本地、预览环境分别是什么地址。
- 共享域名后缀：例如 `example.com`，用于判断哪些新开页面还留在工作台里。
- 登录 Cookie 名：例如 `sessionid`、`sid`、`token`，用于新开页面需要补登录态时桥接。

## 启动方式

打开独立桌面画布：

```bash
./preview-accounts.sh desktop
```

打开旧版本地面板：

```bash
./preview-accounts.sh app
```

打开纯说明页面：

```bash
./preview-accounts.sh dashboard
```

生成可双击的 `.command` 启动器：

```bash
./preview-accounts.sh make-launchers
```

生成可双击的 macOS App 启动器：

```bash
./preview-accounts.sh make-app
```

查看账号列表：

```bash
./preview-accounts.sh list
```

清掉某个环境账号的登录态：

```bash
./preview-accounts.sh reset "测试环境/默认账号"
```

## 通用示例模板

可以写入一套不含真实业务地址的示例配置：

```bash
./preview-accounts.sh preset-sample
```

它会写入：

- 生产示例
- 测试示例
- 本地示例

执行前会备份原配置。实际项目应复制 `accounts.example.tsv`，再替换成自己的环境地址。

## 可配置项

这些环境变量可以在启动前设置：

```bash
export ACCOUNT_PREVIEW_HOME="$HOME/.account-preview-workbench"
export ACCOUNT_PREVIEW_CONFIG="$HOME/.account-preview-workbench/accounts.tsv"
export ACCOUNT_PREVIEW_SHARED_HOST_SUFFIXES="example.com,example.test"
export ACCOUNT_PREVIEW_AUTH_COOKIES="*"
```

含义：

- `ACCOUNT_PREVIEW_HOME`：本地状态目录，Cookie、界面状态、Electron 数据都放这里。
- `ACCOUNT_PREVIEW_CONFIG`：账号窗口配置文件。
- `ACCOUNT_PREVIEW_SHARED_HOST_SUFFIXES`：同一套系统的域名后缀。新开页面和 Cookie 桥接会用它判断是不是自家页面。
- `ACCOUNT_PREVIEW_AUTH_COOKIES`：允许在同账号窗口之间同步的 Cookie 名。默认 `*` 表示同步所有可见 Cookie；也可以改成 `sessionid,sid,token` 这类白名单。

默认值：

```text
ACCOUNT_PREVIEW_SHARED_HOST_SUFFIXES=example.com
ACCOUNT_PREVIEW_AUTH_COOKIES=*
```

## 目前检查到的硬编码

已经改成可配置：

- 新开页面留在工作台里的域名后缀：通过 `ACCOUNT_PREVIEW_SHARED_HOST_SUFFIXES` 改。
- 新开页面登录态桥接的 Cookie 名：通过 `ACCOUNT_PREVIEW_AUTH_COOKIES` 改。
- 同一个环境账号内的移动端、后台、收银台会自动同步同组域名 Cookie；`m.example.com` 和 `admin.example.com` 会按 `example.com` 自动识别为同组。
- 首次启动默认配置：已改成 `example.com` 通用示例。

仍然需要注意：

- Redis 验证码辅助默认读 `~/.redis-code-menubar.json`，兜底端口是 `127.0.0.1:6381`，这是本地开发辅助能力。
- Electron 内部 API 名为 `accountPreviewShell`，这是 preload 暴露给渲染层的对象名。

## 注意

- 第一次打开每个环境账号时，需要分别登录一次。
- 默认生成的 `example.com` 页面只是占位模板；如果看到 `ERR_CONNECTION_CLOSED` 或页面加载失败，先把 `~/.account-preview-workbench/accounts.tsv` 里的 URL 改成自己的系统地址。
- 后面再次启动时，会继续使用各自 profile 里的 Cookie。
- 这个工具的 Chrome 脚本模式默认使用独立 `user-data-dir`，不会改你当前 Chrome 主 profile。
- 桌面画布壳子使用 Electron Chromium 视图，不是 iframe；首次使用需要在壳子里重新登录一次，之后 Cookie 保存在 `~/.account-preview-workbench/electron-shell`。
- 如果目标网站限制多端登录，同一账号多窗口可能仍会被服务端踢下线；不同账号一般不受这个问题影响。
- 不要把 `~/.account-preview-workbench`、Cookie、token、账号密码发给别人。
- 如果在仓库目录里临时放了个人配置或浏览器状态，确认它们仍被 `.gitignore` 忽略后再提交。
