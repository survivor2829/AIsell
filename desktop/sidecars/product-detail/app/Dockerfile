# 显式 pin bookworm：trixie 于 2025 年转稳后 `python:3.11-slim` 自动切 trixie,
# 引发 libicu72→libicu76 + t64 过渡（libasound2→libasound2t64 等 15+ 包改名）
FROM python:3.11-slim-bookworm

# 腾讯云 apt 镜像：Bookworm DEB822 格式 + 旧格式双路径替换（容错）
RUN sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list 2>/dev/null; true

# 显式列出 Chromium 运行时依赖，不依赖 `playwright install --with-deps` 自动检测
# （Bookworm DEB822 下自动检测会漏包，腾讯云部署已失败过 3 次）
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget curl ca-certificates \
    fonts-wqy-zenhei fonts-wqy-microhei fonts-noto-cjk fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    libgdk-pixbuf-2.0-0 \
    libgtk-3-0 \
    libharfbuzz0b \
    libicu72 \
    libjpeg62-turbo \
    libpng16-16 \
    libwebp7 \
    libwoff1 \
    libxml2 \
    libxslt1.1 \
    libfontconfig1 \
    libfreetype6 \
    libenchant-2-2 \
    libsecret-1-0 \
    libhyphen0 \
    libmanette-0.2-0 \
    libflite1 \
    libgles2 \
    libegl1 \
    libgudev-1.0-0 \
    libgstreamer1.0-0 \
    libgstreamer-plugins-base1.0-0 \
    libgstreamer-plugins-bad1.0-0 \
    libgstreamer-gl1.0-0 \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    libevdev2 \
    libopus0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip config set global.index-url https://mirrors.cloud.tencent.com/pypi/simple/ && \
    pip config set global.trusted-host mirrors.cloud.tencent.com

# playwright 1.58+ 改用 Chrome for Testing 分发, chromium 150M 二进制默认走
# playwright.azureedge.net, 中国大陆首次 TLS 握手 + 超长 backoff 能卡到 40 分钟
# (腾讯云实测). 改走阿里 npmmirror 镜像, <1 分钟下完.
#
# 两套 URL 结构在 npmmirror 是不同前缀, 一个 DOWNLOAD_HOST 覆盖不了两个:
#   1) Chrome/headless-shell (CfT):  HOST/{chrome_version}/linux64/chrome-linux64.zip
#      → npmmirror 在 /binaries/chrome-for-testing/
#   2) FFmpeg (playwright CDN 老路径): HOST/builds/ffmpeg/{rev}/ffmpeg-linux.zip
#      → npmmirror 在 /binaries/playwright/builds/ffmpeg/
# 所以必须分两次调 playwright install, 每次换 HOST.
# 顺序 + marker 机制见下方第二段注释 (ffmpeg 先装 chromium 后装, 反了会 fail).

# 系统依赖已在上一步装好，这里只拉浏览器二进制 — 两阶段顺序关键:
# 先装 ffmpeg (2M, 快), 写入 marker; 再装 chromium 时 playwright 看到 ffmpeg 已完成,
# 只会拉 chrome + chrome-headless-shell, 不会重复拉 ffmpeg.
# 反过来则失败: chromium 先装触发 ffmpeg 404 → 整个命令 fail → chrome+shell 的
# INSTALLATION_COMPLETE 不落盘 → 第二阶段再重下 chrome+shell 仍 404 (HOST 换过了).
RUN pip install --no-cache-dir playwright==1.58.0 && \
    PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
      playwright install ffmpeg
RUN PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/chrome-for-testing \
      playwright install chromium

# requirements.txt 单独 COPY：只有它变化才重装 Python 依赖（利用 Docker 层缓存）
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 预下载 rembg 模型（ghfast.top 镜像）：避免运行时首次抠图超时；失败则运行时兜底
RUN mkdir -p /root/.u2net && \
    wget -q --timeout=30 --tries=2 \
      -O /root/.u2net/isnet-general-use.onnx \
      "https://ghfast.top/https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx" \
    || echo "[WARN] rembg 模型下载失败，运行时首次抠图会自动下载"

COPY . .

# -rf 而非 -f:本地 instance/ 会被 COPY . . 带进镜像(可能是目录也可能是软链),rm -f 只能删文件会挂
RUN rm -rf instance && mkdir -p static/uploads static/outputs output instance

ENV FLASK_ENV=production
ENV PYTHONUNBUFFERED=1

EXPOSE 5000

# gunicorn 生产启动，全部走环境变量:
# - worker-class gthread: WS 长连接 + ThreadPoolExecutor + Playwright subprocess + rembg CPU,
#   这个组合和 gevent monkey-patch 交互是坑,用真 OS 线程最稳
# - WEB_WORKERS × WEB_THREADS = 总并发容量 (默认 2×25=50, 单机 4C8G 可调到 4×25=100)
# - WEB_TIMEOUT=180: Playwright 截图 + 大 zip 单请求可能 60s+, 180 留足安全余量
CMD gunicorn \
    --bind 0.0.0.0:${WEB_PORT:-5000} \
    --workers ${WEB_WORKERS:-2} \
    --worker-class gthread \
    --threads ${WEB_THREADS:-25} \
    --timeout ${WEB_TIMEOUT:-180} \
    --graceful-timeout 30 \
    --access-logfile - \
    app:app
