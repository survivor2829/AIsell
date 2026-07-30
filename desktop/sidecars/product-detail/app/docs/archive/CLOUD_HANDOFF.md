# 小玺AI - 云端部署交接文档

> **用途**：将此文档发给 Claude 网页端，配合截图协作处理云服务器部署和安全问题。
> **更新日期**：2026-04-08

---

## 一、项目概述

**小玺AI产品详情页自动生成器** —— 一个 Flask Web 应用，用于自动生成商用清洁机器人的产品详情页。

核心功能：
- 用户填写产品信息 / 上传图片 / AI 识别文案 -> 自动生成详情页
- Playwright + Chromium 截图导出高清 PNG
- rembg 自动抠图（懒加载，首次调用时才加载模型）
- DeepSeek API 驱动 AI 文案解析

---

## 二、技术栈

| 组件 | 版本/说明 |
|------|----------|
| Python | 3.11 |
| Web 框架 | Flask |
| 截图引擎 | Playwright + Chromium |
| AI 抠图 | rembg + onnxruntime |
| AI 文案 | DeepSeek API (`deepseek-chat`) |
| 容器 | Docker (python:3.11-slim) |
| 部署 | Render.com (免费版) / 腾讯云 |
| 启动方式 | gunicorn, 1 worker, timeout 180s |

---

## 三、当前部署架构

### 3.1 Docker 配置 (Dockerfile)

```dockerfile
FROM python:3.11-slim
# apt/pip 均使用腾讯云镜像加速
# 安装中文字体 + Chromium 系统依赖
# Playwright 从官方 CDN 安装 Chromium
# gunicorn 启动，端口由 $PORT 环境变量控制（默认 5000）
# 单 worker，避免免费版内存超限
```

### 3.2 Render 部署 (render.yaml)

```yaml
services:
  - type: web
    name: clean-ai-assistant
    runtime: docker
    plan: free
    envVars:
      - key: DEEPSEEK_API_KEY  # 需要在 Render 控制台手动设置
      - key: FLASK_ENV
        value: production
```

### 3.3 关键环境变量

| 变量名 | 说明 | 在哪设置 |
|--------|------|----------|
| `DEEPSEEK_API_KEY` | AI 文案接口密钥 | Render/腾讯云控制台 |
| `PORT` | 服务端口（Render 自动注入） | 平台自动设置 |
| `FLASK_ENV` | production | Dockerfile/render.yaml |

### 3.4 注意事项

- **内存限制**：Render 免费版只有 512MB，rembg 已做懒加载处理
- **代理配置**：`app.py` 中硬编码了 `127.0.0.1:7890` 代理，**云端部署需要去掉或改为环境变量控制**，否则 DeepSeek API 调用会失败
- **API Key 暴露**：已修复，改为纯环境变量读取，不再硬编码

---

## 四、已知问题 & 待处理

### 4.1 安全问题（优先级高）

- [x] **DeepSeek API Key 泄露**：已修复，所有硬编码 key 已移除，改为纯环境变量
- [ ] **腾讯云安全漏洞通知**：收到多条通知，需要截图给 Claude 网页端逐一分析处理
- [ ] **代理硬编码**：`app.py:39` 中 `PROXY` 写死了 `127.0.0.1:7890`，云端没有这个代理会导致请求超时

### 4.2 部署问题

- [ ] 腾讯云服务器部署尚未完成配置
- [ ] Render 免费版限制较多（512MB 内存、冷启动慢、每月限时）
- [ ] Playwright Chromium 在云端的兼容性（需要大量系统依赖）

### 4.3 功能正常（已验证）

- [x] Docker 构建通过
- [x] 本地运行正常
- [x] rembg 懒加载（解决启动超时）
- [x] 国内镜像加速（apt/pip/Playwright）

---

## 五、文件清单（部署相关）

```
Dockerfile              Docker 构建文件
render.yaml             Render 部署蓝图
requirements.txt        Python 依赖清单
app.py                  主应用（含 API Key、代理配置）
```

### requirements.txt 内容：

```
flask, jinja2, playwright, pillow, numpy,
pdfplumber, python-docx, openpyxl,
rembg, onnxruntime, requests
```

---

## 六、给 Claude 网页端的协作指引

### 你可以这样用：

1. **安全漏洞截图**：直接截图腾讯云控制台的安全通知，发给 Claude 网页端，问：
   > "这是腾讯云发的安全漏洞通知，请帮我分析严重程度并给出修复步骤"

2. **部署报错截图**：如果部署过程中有报错，截图终端/控制台，问：
   > "这是我在腾讯云部署 Docker 容器时的报错，请帮我解决"

3. **配置确认截图**：截图腾讯云的安全组、端口配置等，问：
   > "请检查我的安全组配置是否正确，需要开放哪些端口"

### 常见问题参考：

| 场景 | 可能的原因 | 解决方向 |
|------|-----------|----------|
| 容器启动后立即退出 | 内存不足 / 端口冲突 | 检查 `docker logs`，确认内存 >= 1GB |
| DeepSeek API 超时 | 代理配置问题 | 云端删除 PROXY 配置或用环境变量控制 |
| Playwright 截图失败 | 缺少系统依赖 | 确认 Dockerfile 中的 apt 依赖完整 |
| 页面中文乱码 | 缺少中文字体 | 已安装 wqy + noto-cjk 字体 |
| rembg 首次慢 | 首次加载下载模型 | 正常现象，约 30s |

---

## 七、腾讯云部署建议步骤

如果要在腾讯云轻量服务器上部署：

```bash
# 1. 安装 Docker
curl -fsSL https://get.docker.com | sh

# 2. 克隆代码
git clone <你的仓库地址> && cd clean-industry-ai-assistant

# 3. 构建镜像
docker build -t clean-ai .

# 4. 运行容器
docker run -d \
  --name clean-ai \
  -p 5000:5000 \
  -e DEEPSEEK_API_KEY="你的key" \
  -e PORT=5000 \
  --restart unless-stopped \
  clean-ai

# 5. 检查运行状态
docker logs -f clean-ai
```

安全组需开放：**5000 端口**（或用 Nginx 反代到 80/443）

---

## 八、需要在 app.py 中修复的安全问题

修改 `app.py` 中的以下两处：

```python
# 第36行 - API Key 改为纯环境变量（去掉默认值）
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")

# 第39行 - 代理改为环境变量控制
_proxy_url = os.environ.get("HTTP_PROXY", "")
PROXY = {"http": _proxy_url, "https": _proxy_url} if _proxy_url else {}
```

然后在 DeepSeek API 调用处，传入 `proxies=PROXY or None`。

---

*文档由 Claude Code 生成，配合 Claude 网页端 + 截图使用*
