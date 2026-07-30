# 项目说明
这是小玺AI产品详情页自动生成器，专注于**设备类**（商用清洁机器人）单一模板。

## 环境
- Windows 系统，Shell 命令使用 bash 语法（非 PowerShell）
- Python 3.x，在 PATH 中
- Playwright + Chromium 已安装（用于导出 PNG）
- 代理：Clash 端口 7890

### 环境变量 AI_BG_MODE (AI 背景图生成开关)

控制 `/api/generate-ai-detail-html` 端点（v2 HTML 合成管线）生成背景图的模式：

- **`AI_BG_MODE=cache`** (默认，开发/内部测试用)：
  按 `(theme_id, screen_type, product_category)` hash 缓存 24h。
  同主题 + 同品类重复点 → 读磁盘缓存，**不重复烧 Seedream API**。
  首次生成仍需调 API（冷缓存），之后命中直接复用。

- **`AI_BG_MODE=realtime`** (生产/面向客户用)：
  每次都实时调 Seedream 生成全新背景，**忽略缓存文件**。
  用于给终端用户演示"每次都不一样"的差异化视觉。

失败降级：API 未配置 / 调用超时 / 下载失败 → 该屏 `bg_url=""` → 模板走 CSS 渐变兜底（不阻塞长图生成）。

缓存目录：`static/cache/ai_bg/<hash>.png` — 可直接删文件清缓存，无需重启。

在 `.env` 里加：
```
AI_BG_MODE=cache
```
切换到 realtime 时把值改成 `realtime` 即可，无需重启进程之外的任何操作。

## 项目结构
```
app.py                          主后端（Flask）
templates/
  build_form.html               产品填表页
  设备类/
    assembled.html              预览页（积木拼装）
    build_config.json           产品默认配置（blocks_hardcoded, fixed_selling_images）
  blocks/
    block_a_hero_robot_cover.html   英雄屏（场景图+产品图+卖点）
    block_b2_icon_grid.html         六大优势图标网格
    block_b3_clean_story.html       清洁故事屏
    block_e_glass_dimension.html    产品参数表（磨砂玻璃卡片）
    block_f_showcase_vs.html        1台顶8人 VS 对比屏
static/
  uploads/                      用户上传的图片
  outputs/                      Playwright 截图输出
  设备类/                        设备类固定卖点图片
```

## 工作流
1. 访问 `/build/设备类`，填写产品信息
2. 上传产品图、场景图（可选）
3. 粘贴产品文案，点"AI识别"自动填表
4. 点"生成预览"，跳转到预览页
5. 点"导出高清PNG"，Playwright 截图下载

## 启动

### P3 砍刀流: 平台 API Key 要求

app.py 启动时检查必填的 platform key（P3 砍刀流后用户不再自配）：
- `DEEPSEEK_API_KEY` (文案 AI 解析)
- `REFINE_API_KEY` (精修 API)
- `REFINE_API_BASE_URL` (精修 endpoint)

**开发环境选项：**
1. **推荐**: 在 `.env` 里配置真实的 key（参考 `.env.example`）
2. **备选**: 设置 `FLASK_ENV=development` 绕过校验（开发时使用 conftest.py fake key）
3. **测试**: pytest 通过 `conftest.py` 自动注入 fake key

```bash
# 选项 2: 开发模式（跳过 key 校验）
FLASK_ENV=development python app.py

# 或直接导入（测试用）
FLASK_ENV=development python -c "import app"
```

### 启动应用
```bash
python app.py
```
访问 http://localhost:5000

## 关键 API
- `POST /api/upload` — 上传图片，返回 URL
- `POST /api/build/设备类/parse-text` — AI 解析文案，返回表单字段 JSON
- `POST /build/设备类` — 提交表单，渲染预览页
- `POST /export/设备类` — Playwright 截图，返回 PNG 文件
- `GET /api/ai-engines` — 列出可用 AI 引擎（通义万相 / 豆包 Seedream）
- `POST /api/generate-ai-detail` — 双引擎无缝长图生成（详见 `ai_image_router.py`）

## Claude Code 配置说明

`.claude/` 目录是项目的 Claude Code 协作配置，已落地的内容如下：

### Agent 自主性约定（档 2 PR 模式）

详见 `.claude/AUTONOMY.md`（2026-05-06 由 master roadmap §6 定义）。

简版规则：
- **自动 OK**：编辑/测试/commit/push feature 分支/开 PR
- **stop and ask**：merge PR、deploy、花钱、动 prod
- **PR 自审 checklist**：全测、smoke、PR description 5 节齐备

### 任务路由（按工作类型选 agent / skill）

| 任务类型 | 用什么 | 入口 |
|---------|--------|------|
| 改 Jinja 模板 / 配色 / 文案 | `block-editor` agent | 自动委派 |
| 改 AI 生图 / Pillow 合成 / 引擎路由 | `ai-image-debugger` agent | 自动委派 |
| 改完代码快速验证（30秒） | `/smoke` skill | 手动 `/smoke` |
| 改完模板看预览 | `/regen-thumbs` skill | 手动 `/regen-thumbs` |
| 推送上线（push + ssh restart） | `/deploy` skill | 手动 `/deploy "msg"` |

### settings.json 关键约束

- **defaultMode: acceptEdits** — 编辑类操作不再每次询问；危险操作走 `ask`/`deny`
- **deny 列表硬阻止**：`rm -rf /`, `rm -rf ~`, `git push --force`, `git reset --hard`, 编辑/读取 `.env` 和 `instance/`
- **PreToolUse Edit hook**：阻止任何路径包含 `.env` / `crypto_utils.py` / `/instance/` 的写入
- **env**：强制 `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`（Windows GBK 终端中文乱码兜底）
- **additionalDirectories**：把 `static/scene_bank/` 加入工作区，e2e 测试可读
- **不做 Stop hook**：跨平台脆弱（Windows/Linux 命令不一致）+ 慢；改用 `/smoke` skill 主动验证（更显式、更可控）

### 个人覆盖

`.claude/settings.local.json`（不进 git）放本机临时白名单。团队规则永远写 `settings.json`。

### 修改 .claude/ 后

```bash
# 验证 JSON 格式
python -c "import json; json.load(open('.claude/settings.json', encoding='utf-8'))"
# 验证 Edit hook（应输出 exit=2）
echo '{"tool_input":{"file_path":".env"}}' | python -c "import sys,json; d=json.load(sys.stdin); p=d.get('tool_input',{}).get('file_path',''); sys.exit(2) if any(b in p for b in ['.env','crypto_utils.py','/instance/']) else sys.exit(0)"; echo "exit=$?"
```
