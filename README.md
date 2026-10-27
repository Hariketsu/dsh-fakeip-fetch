# dsh-fakeip-fetch

![Version](https://img.shields.io/badge/version-0.5.2-4D6BFE)
![Node.js](https://img.shields.io/badge/Node.js-24.9%2B-339933?logo=node.js&logoColor=white)
[![License](https://img.shields.io/badge/license-MIT-555)](LICENSE)

绕过 DSH 内置 WebFetch 对 Fake-IP 地址的 SSRF 限制，让本机抓取在 TUN Fake-IP 代理下正常工作。

| | DeepSeek 官方 Fetch API | 本地 fetch + 本插件 | 本地 fetch（无插件） |
| --- | --- | --- | --- |
| 抓取位置 | DeepSeek 服务端 | 本机 | 本机 |
| 网络出口 | 服务端网络 | 本机网络和代理 | 本机网络和代理 |
| TUN Fake-IP | 不受本机 Fake-IP 影响 | 支持配置的 Fake-IP 网段 | 在已验证的 DSH 版本中，Fake-IP 地址会被当作非公网地址拒绝 |
| 网页访问 | 取决于服务端网络 | 取决于本机网络和代理 | 取决于本机网络和代理；Fake-IP 模式下可能被拦截 |

插件会替换 DSH 的 HTTP 抓取 provider。默认 Fake-IP 网段是 `198.18.0.0/16`；如果你的代理使用其他网段，可以在插件设置中修改。

## 官方 Fetch API 的访问情况

以下是原有测试中 `POST /v1/tools/fetch` 的结果，反映的是当时的服务端出口。

| 目标 | 测试结果 |
| --- | --- |
| `ipinfo.io`、`ifconfig.co` | 返回中国大陆的华为云出口 IP |
| `wikimediafoundation.org`、`dbpedia.org` | 可以抓取 |
| Wikipedia、Google、X、YouTube、Reddit、BBC、NYT 等 | 返回 404 |
| `raw.githubusercontent.com`、Hugging Face、`archive.org` 等 | 返回 404 |
| Stack Overflow、npmjs、Reuters、AP 等 | 等待约 13–30 秒后返回 404 或 504 |

本地 fetch 的结果取决于本机的网络和代理。使用本插件的测试中，Wikipedia 抓取返回 200。

## 安装

发布到 npm 后，可以通过 CLI 安装到指定 profile：

```bash
dsh plugin --profile <profile> add dsh-fakeip-fetch --ignore-scripts --config.auto-install-peers=false
```

也可以安装本地打包文件。在项目目录运行 `npm pack` 后，在 DSH 插件页填写：

```text
file:/absolute/path/to/dsh-fakeip-fetch-0.5.2.tgz
```

也可以通过 CLI 安装到指定 profile：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-fakeip-fetch-0.5.2.tgz \
  --ignore-scripts --config.auto-install-peers=false --store-dir <store>
```

卸载插件后，内置的 HTTP provider 会恢复。

### 从 dsh-local-fetch 升级

先在插件页卸载旧包 `dsh-local-fetch`，再安装 `dsh-fakeip-fetch`。两个包使用同一个 provider ID，不能同时安装。

首次启动时，插件会读取旧配置并迁移网段和传输设置。旧的 `local-fetch` 配置行会保留在 profile patch 中，但不会被加载。

## 使用

安装后即可使用。打开插件设置，可以查看状态和自检结果、修改 Fake-IP 网段，或用「探测本机 DNS」查看当前解析结果。网段修改保存后，下一次请求就会使用新配置。

设置页还提供超时、响应大小、重定向次数和 User-Agent 等传输设置。遇到问题时，可以在「诊断与自检」中重跑自检。

只填写代理实际使用的 Fake-IP 网段。不要填写私网、回环地址或 `0.0.0.0/0`、`::/0` 等宽泛网段：插件无法验证代理最终连接的地址。

## 工作原理

DSH 的远端 Fetch API 由服务端抓取网页，能否访问取决于服务端的网络环境。本插件改用本机 HTTP 抓取，让请求经过本机网络和代理。

在 Fake-IP 模式下，本机 DNS 会把域名解析到代理使用的虚拟地址。DSH 的 HTTP provider 会将这些地址视为非公网地址并拒绝请求。插件在遇到这种拒绝时重新解析域名；只有 DNS 返回的地址全部属于配置的 Fake-IP 网段，才会重新尝试抓取。重定向时也会重新检查地址。

插件使用 DSH 的 HTTP 传输实现，保留 TLS、同源重定向、超时和响应大小等限制。直接使用 IP 地址的 URL 不走 Fake-IP 重试。

## 兼容性

插件依赖 DSH HTTP 传输实现中的地址解析器参数，该参数不是公开的插件 API。已在 Desktop `0.2.1-rc.3`、build `be72761ee1a6736ebcdf4f3739363b083ae53c98` 上测试；其他构建可能不同。

启动时插件会检查当前构建是否支持该参数。如果不支持，抓取会退回内置 HTTP provider 的行为，Fake-IP 重试不可用。可以在设置页查看检查结果。

本插件针对 TUN Fake-IP 模式；使用 `redir-host` 模式时通常不需要它。跨源重定向沿用 DSH 的限制，需要直接请求目标 URL。

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

[MIT](LICENSE)
