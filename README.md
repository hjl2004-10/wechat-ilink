# WeChat iLink

<p align="center">
  <strong>将微信接入 SillyTavern，通过 iLink Bot 协议实现微信与 AI 角色的双向消息互通。</strong>
</p>

---

## 功能特性

- **扫码登录** — 通过微信 iLink 协议扫码连接，无需额外部署
- **消息接收** — 微信文字消息自动填入 SillyTavern 输入框并触发 AI 生成
- **回复回推** — AI 回复自动发送回微信，仅对微信触发的对话生效
- **格式清理** — 自动去除 Markdown 格式（粗体、代码块、标题等），适配微信阅读
- **自定义替换** — 支持正则表达式替换规则，灵活定制发送内容
- **前后缀** — 为发送到微信的内容添加自定义前缀/后缀
- **定时发送** — 按设定间隔重复发送 AI 回复或自定义内容
- **手动发送** — 一键将最后一条 AI 回复发送到微信

## 安装

### 前置要求

- SillyTavern 1.12+
- 在 `config.yaml` 中启用 CORS 代理：

```yaml
enableCorsProxy: true
```

### 安装步骤

1. 将 `wechat-ilink` 文件夹复制到 SillyTavern 第三方扩展目录：

```
<SillyTavern>/public/scripts/extensions/third-party/wechat-ilink/
```

2. 确认 `config.yaml` 中 `enableCorsProxy` 已设为 `true`
3. 重启 SillyTavern

## 使用方法

1. 在 SillyTavern 中打开**扩展面板**，找到 **WeChat iLink**
2. 点击 **「获取二维码」**
3. 用微信扫描二维码并在手机上确认登录
4. 在 SillyTavern 中选择一个角色
5. 从微信发送文字消息，SillyTavern 会自动接收并触发 AI 回复
6. AI 生成的回复会自动发送回微信

## 配置项

| 设置 | 默认值 | 说明 |
|------|--------|------|
| iLink API 地址 | `https://ilinkai.weixin.qq.com` | iLink Bot API 基础地址 |
| X-WECHAT-UIN | 随机生成 | 请求标识，一般无需修改 |
| 消息轮询间隔 | 3 秒 | 拉取微信新消息的频率 |
| 填入微信消息到输入框 | 开启 | 收到微信消息时填入输入框 |
| 自动发送输入（触发AI） | 开启 | 填入后自动触发 AI 生成 |
| 自动回推 AI 回复到微信 | 开启 | AI 回复后自动发回微信 |
| 发送前清理 Markdown | 开启 | 去除 Markdown 格式符号 |
| 发送前缀 / 后缀 | 空 | 自定义消息包装文本 |
| 自定义替换规则 | 空 | 每行一条，格式：`匹配=>替换`，支持正则 |

## 项目结构

```
wechat-ilink/
├── manifest.json      # SillyTavern 扩展清单
├── index.js           # 主要逻辑
├── settings.html      # 设置面板 UI
├── style.css          # 样式
├── qrcode.min.js      # QRCode.js（二维码生成）
├── LICENSE            # MIT 许可证
└── README.md
```

## 常见问题

**Q: 扩展面板中没有看到 WeChat iLink？**
A: 检查文件夹是否放在正确的第三方扩展目录下，并确认已重启 SillyTavern。

**Q: 获取二维码失败？**
A: 确认 `config.yaml` 中 `enableCorsProxy` 已设为 `true`，并重启 SillyTavern。

**Q: 微信消息没有触发 AI 回复？**
A: 确认已在 SillyTavern 中选择了一个角色并打开了聊天。

**Q: AI 回复没有发回微信？**
A: 只有通过微信触发的对话才会自动回推。手动在 SillyTavern 中的对话不会自动发送到微信。可以使用「发送最后回复」按钮手动推送。

## 许可证

[MIT](LICENSE)
