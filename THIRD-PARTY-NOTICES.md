# 第三方组件与许可声明

本项目自身代码以 MIT 许可发布（见 [LICENSE](./LICENSE)）。本文件说明随项目
或随发布产物一同分发的第三方组件，各自遵循其原有许可，本项目不改变这些许可。

## 一、随发布产物（Release 压缩包）分发的组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| Node.js 运行时 | MIT | 兼容版压缩包内置于 `runtime/`，其许可原文见 `runtime/LICENSE`，请勿删除 |
| express | MIT | npm 依赖 |
| socket.io | MIT | npm 依赖，含前端客户端 |
| ssh2 | MIT | npm 依赖 |
| qrcode | MIT | npm 依赖 |
| @xterm/xterm、@xterm/addon-fit | MIT | npm 依赖，界面终端组件 |
| Microsoft Edge WebView2 SDK | Microsoft 软件许可条款 | 桌面版窗口内核，随应用分发其 DLL，需保留微软许可声明，不得单独再分发该 SDK |

npm 依赖的许可原文见各自包内 `LICENSE` 文件，安装后位于 `node_modules/<包名>/`。

## 二、仅被引用、未随项目分发的组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [3X-UI](https://github.com/MHSanaei/3x-ui) | GNU GPL v3 | 面板本体与官方安装脚本。**本项目不包含其源码或二进制**，仅在运行时由用户的服务器从官方仓库拉取并执行安装脚本 |

由于本项目不含 3X-UI 的代码副本，也不对其做修改分发，因此不构成 GPL v3
意义上的衍生作品，本项目的 MIT 授权与上游 GPL v3 互不影响。

## 三、上游项目

| 项目 | 许可 | 说明 |
| --- | --- | --- |
| [cunzhangcrypto/3XUI](https://github.com/cunzhangcrypto/3XUI) | MIT | 本项目 Web 版原始作者，桌面版在其基础上改造，原版权归村长实验室 (czlab.dev) 所有 |