# 官网微信分享签名服务

官网 `https://www.xilianhui.cn/huoke/` 在微信里打开时，页面向 `/huoke/api/wx-sign` 要签名，用来设置分享卡片的标题、一句话介绍和图片。没有这个服务或签名失败时，微信按默认方式显示卡片，页面其他功能不受影响。

## 需要的公众号设置（用户在公众号后台操作）
- 设置与开发 → 公众号设置 → 功能设置 → JS 接口安全域名：`www.xilianhui.cn`（需上传公众号给的校验文件到网站根目录）。
- 设置与开发 → 基本配置 → IP 白名单：`111.229.75.5`。
- AppID、AppSecret：只放在服务器的环境变量文件里，不进代码仓库。

## 部署（111.229.75.5，与官网同一 docker 网络）
```
# 服务器上：/home/ubuntu/projects/aihuoke-site/wx-signer/
#   signer.py           本目录同名文件
#   wx-signer.env       WX_APPID=... / WX_SECRET=...（chmod 600）
docker run -d --name aihuoke-wx-signer --restart unless-stopped --network datastream_default \
  --env-file /home/ubuntu/projects/aihuoke-site/wx-signer/wx-signer.env \
  -v /home/ubuntu/projects/aihuoke-site/wx-signer/signer.py:/app/signer.py:ro \
  python:3.12-alpine python /app/signer.py
```
商城 nginx（web_shop03）把 `/huoke/` 去掉前缀转给官网容器，不改它。官网自己的 `nginx.conf`（aihuoke-site）加：
```
location = /api/wx-sign {
    resolver 127.0.0.11 valid=30s ipv6=off;
    set $wx_signer http://aihuoke-wx-signer:8090;
    proxy_pass $wx_signer;
}
```
用变量转发：签名服务不在时只有这个地址报 502，官网照常打开。改配置先备份、原地写入（不用 `sed -i`），然后 `nginx -s reload`。

## 验证
- `python -m pytest test_signer.py`（含微信文档示例签名）。
- 部署后：`curl "https://www.xilianhui.cn/huoke/api/wx-sign?url=https%3A%2F%2Fwww.xilianhui.cn%2Fhuoke%2F"` 返回 appId/timestamp/nonceStr/signature。
- 在微信里打开官网 → 右上角 → 发送给朋友，看卡片标题、介绍和图片。
