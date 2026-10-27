# dsh-fakeip-fetch

![Version](https://img.shields.io/badge/version-0.5.2-4D6BFE)
![Node.js](https://img.shields.io/badge/Node.js-24.9%2B-339933?logo=node.js&logoColor=white)
[![License](https://img.shields.io/badge/license-MIT-555)](LICENSE)

DSH 插件：让本机 HTTP 抓取在 TUN Fake-IP 代理环境下正常工作。

## 为什么要用 dsh-fakeip-fetch？

| | DeepSeek 官方 Fetch API | 本地 fetch + 本插件 | 本地 fetch（无插件） |
| --- | --- | --- | --- |
| 抓取位置 | DeepSeek 服务端 | 本机 | 本机 |
| 网络出口 | 服务端网络 | 本机网络和代理 | 本机网络和代理 |
| TUN Fake-IP | 不受本机 Fake-IP 影响 | 支持配置的 Fake-IP 网段 | 在已验证的 DSH 版本中，Fake-IP 地址会被当作非公网地址拒绝 |
| 网页访问 | 取决于服务端网络 | 取决于本机网络和代理 | 取决于本机网络和代理；Fake-IP 模式下可能被拦截 |

## 安装和快速上手

### 从 npm 安装

在 DSH Desktop 的「插件」页面点击「添加插件」，输入 `dsh-fakeip-fetch` 并安装。

![DSH 插件页面的添加插件对话框](docs/images/install.jpg)

也可以使用 CLI 安装到指定 profile：

```bash
dsh plugin --profile <profile> add dsh-fakeip-fetch --ignore-scripts --config.auto-install-peers=false
```

### 从本地文件安装

在项目目录运行 `npm pack`，然后在 DSH 的「添加插件」窗口中输入生成的文件路径，例如：

```text
file:/absolute/path/to/dsh-fakeip-fetch-0.5.2.tgz
```

也可以通过 CLI 安装：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-fakeip-fetch-0.5.2.tgz \
  --ignore-scripts --config.auto-install-peers=false --store-dir <store>
```

### 配置和自检

1. 打开插件设置，确认 Fake-IP 网段与代理的实际配置一致；默认值为 `198.18.0.0/16`。
2. 使用「探测本机 DNS」查看当前解析结果，必要时修改网段并保存。
3. 查看「自检」结果；遇到问题时可以点击「重跑自检」。

![插件设置页面，显示 Fake-IP 网段和自检结果](docs/images/settings.jpg)

设置页还提供超时、响应大小、重定向次数和 User-Agent 等传输设置。卸载插件后，内置的 HTTP provider 会恢复。

### 从 dsh-local-fetch 升级

先在插件页卸载旧包 `dsh-local-fetch`，再安装 `dsh-fakeip-fetch`。两个包使用同一个 provider ID，不能同时安装。

首次启动时，插件会读取旧配置并迁移网段和传输设置。旧的 `local-fetch` 配置行会保留在 profile patch 中，但不会被加载。

## 工作原理与兼容性

插件使用本机 HTTP 抓取，经过本机网络和代理。内置 provider 因地址限制拒绝请求时，插件会重新解析域名；只有解析结果全部属于配置的 Fake-IP 网段，才会重试。直接使用 IP 地址的 URL 不走 Fake-IP 重试，重定向时也会重新检查地址。

插件沿用 DSH 的 HTTP 传输实现，包括 TLS、同源重定向、超时和响应大小限制。它依赖的地址解析器参数不是公开的插件 API：目前已在 DSH Desktop `0.2.1-rc.3`、build `be72761ee1a6736ebcdf4f3739363b083ae53c98` 上测试，其他 DSH 版本或构建尚未验证。如果宿主不支持该参数，插件会退回普通 HTTP 抓取，Fake-IP 重试不可用。

插件针对 TUN Fake-IP 模式；使用 `redir-host` 模式时通常不需要它。跨源重定向沿用 DSH 的限制，需要直接请求目标 URL。

## 安全与网络行为

只填写代理实际使用的 Fake-IP 网段，不要填写私网、回环地址或 `0.0.0.0/0`、`::/0` 等宽泛网段：插件无法验证代理最终连接的地址。

首次启动或插件与宿主版本发生变化时，自检会查询 `en.wikipedia.org` 的 DNS，并尝试抓取 `https://example.com`；结果保存在 DSH 的本机存储中。设置页可手动触发 DNS 探测和重新自检。

## 常见问题

**提示 `cannot register the "http" fetch provider`**

当前 profile 中有另一个插件注册了 `http` provider。检查是否仍安装着 `dsh-local-fetch`，卸载后重启。

**提示地址不在配置的 Fake-IP 网段中**

检查代理的 Fake-IP 网段是否与插件设置一致。可以使用设置页的「探测本机 DNS」查看解析结果。

**自检显示 `resolver=unsupported`**

当前 DSH 构建不支持插件使用的地址解析器参数。插件会使用普通 HTTP 抓取，但无法处理 Fake-IP 地址。

## 开发

```bash
node --test test/policy.test.js
node test/client-bundle-check.mjs
```

集成测试使用 `test/driver.patch.yml` 和 `test/migration-check.patch.yml`；运行前需要将其中的路径替换为本机测试文件的绝对路径，并使用隔离的 DSH profile 和 `DSH_HOME`。

## 许可证

本项目由社区维护，与 DeepSeek 官方无关。

[MIT](LICENSE)
