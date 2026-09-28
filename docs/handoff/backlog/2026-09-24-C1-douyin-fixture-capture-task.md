# C1 抖音关键词获客：开发版脱敏采集（fixtures），只观察、不发送

分支：`codex/douyin-fixture-capture`
- **在 T2 合并后开始**：两张卡都改 `desktop/scripts/run-self-checks.cjs`，而且 T2 负责把 `keyword-acquisition.self_check.cjs` 注册进 `check:self`（目前没有注册）。
- 与其他卡重叠的文件，按追加方式合并，后合并的一方负责 rebase：
  - `desktop/scripts/customer-edition.self_check.cjs`：B0 也可能改；
  - `desktop/src/main/main.cjs`、`desktop/scripts/run-self-checks.cjs`：B4b 也改。B4b 改的是数字人和产品视频两个服务的构造参数（`ffmpegPath` 在 `main.cjs:651-653,682-684`），和本卡的 :641-645 相邻。
- 与 T1、T3、T4、T5、T8 没有文件重叠。
- C2 依赖本卡的产出：用户按本卡脚本采集后，Claude 分析 fixtures，再出 C2 卡。C3（真实发送验证）排在 C2 之后。

## 背景

C2 要按真实页面重写抖音适配器，但仓库里还没有任何真实页面的样本。

**现有自检**：只用假适配器和手写 JSON（`desktop/src/main/keyword-acquisition.self_check.cjs:13-21, 28-31`）。

**适配器现状**（`desktop/src/main/douyin-browser-adapter.cjs`）：
- 已挂上 CDP 并开启 Network 域（:113），但只被动读取 `/user/profile/self` 和 `/comment/list/` 两个接口（:118）。
- 搜索结果靠 DOM 里的 `a[href*="/video/"]`（:41-44）。调研显示搜索卡片里不一定有这种链接；页面实际请求的 `/aweme/v1/web/search/item/` 和 `/aweme/v1/web/general/search/single/` 从未被观察过。
- 私信判断依赖以下选择器，任何开源项目里都没出现过：
  - `[data-e2e="chat-conversation"][data-peer-id]`、`data-message-id`、`data-sender-id`、`data-send-status`（:59-65）；
  - 文字恰为"发送"的按钮（:68）。
- 在真实页面上，`inspectConversation` 返回 `supported:false`，`send` 在 :245 直接报 `DOUYIN_SEND_UNVERIFIED`，不会点发送。真正有副作用的只有 `openConversation`（:218-233）：它会点"私信"，在会话列表里生成一条"刚刚"的会话。
- 验证码按文字判断（:40），读不到 iframe 里的验证码。
- 线索只存 `sec_uid`（:26-27）。

**打包和开关的现状**（决定开关必须怎么写）：
- `desktop/scripts/build-portable-release.cjs:61-87`：以 `.dev.cjs` 结尾、又不在白名单里的文件，测试包和交付包都不打入。文件名含 `self_check` 的也不打入（:58）。
- **内部测试包（`release:internal`，异机正在用）里 `developmentEdition` 同样为 true**：
  - 测试包的渲染层标记为 `development`（`build-renderer.cjs:7`）；
  - 测试包带有 `preload.dev.cjs`（`build-portable-release.cjs:83-85`）；
  - `edition.cjs:22-24` 按这两点判定 `developmentEdition`。

  所以只判断 `developmentEdition` 不够，必须同时要求 `!app.isPackaged`。
- 开发版数据目录：
  - `main.cjs:211-212` 把 userData 设为 `%APPDATA%\xiaoxi-active-touch-test`；
  - `runtime-data.cjs:8` 的 rootDir 是 userData 下的 `data`；
  - 关键词获客目录在 `main.cjs:643` 设定。
- 诊断包只收集指定文件（`diagnostics-ipc.cjs:299-303`），不包含关键词获客目录。

**启动开发版有副作用**（所以 Codex 不启动它，见"禁止"）：
- `启动内部开发版.cmd:24-25` 会强制结束本仓库已在运行的开发版进程；
- 启动时 `main.cjs:829` 会初始化朋友圈每日自动化（`moments-campaign-ipc.cjs:1138-1150`）。如果开发版数据里开着这个功能，就会排期真实的微信操作。

**本卡只做一件事**：在开发版里加一个"采集模式"。用户用测试号手动操作现有的抖音窗口，程序把页面结构和页面自己请求到的响应，脱敏后保存到本地。

## 要做

1. **新增 `desktop/src/main/douyin-fixture-capture.dev.cjs`**
   - 导出 `createDouyinFixtureCapture({ outputRoot, now, randomBytes, log = console.log })`。创建时用 `log` 打印一次输出根目录。
   - 另外导出以下纯函数，供自检直接调用：URL 脱敏、JSON 脱敏、DOM 树脱敏与序列化、泄漏闸门加写盘、按键判断。

2. **开关（三道）**
   - `main.cjs:641-645`：只有 `!app.isPackaged && developmentEdition && process.env.XIAOXI_DOUYIN_FIXTURE_CAPTURE === "1"` 同时成立时，才 `require("./douyin-fixture-capture.dev.cjs")`。
     - 输出根目录为 `path.join(runtime.rootDir, "keyword_acquisition", "dev-capture")`。
     - 其他情况一律传 `null`，也不执行 require。
   - `keyword-acquisition-ipc.cjs`：`registerKeywordAcquisitionIpc` 接收 `devCapture`（:4），透传给 `createDouyinBrowserAdapter`（:9-10）。
   - 不把该文件加入 `.dev.cjs` 白名单。
   - 新增仓库根目录 `启动抖音采集模式.cmd`：
     - 前三行照抄 `desktop/scripts/启动精准触达诊断.cmd:1-3`（`@echo off`、`setlocal`、`chcp 65001 >nul`），文件用 UTF-8 编码、CRLF 换行；
     - 然后 `set "XIAOXI_DOUYIN_FIXTURE_CAPTURE=1"`，再 `call "%~dp0启动内部开发版.cmd"`；
     - 不做其他事。

3. **适配器注入点**（`douyin-browser-adapter.cjs`）
   - 新增参数 `devCapture`，默认 `null`。为 `null` 时，行为必须与现在完全一致。
   - `Network.enable` 成功后（:113-114）调用 `devCapture.attach({ window, webContents })`；窗口 `closed` 时（:112）调用 `devCapture.detach()`。`attach` 抛错只打印到控制台，窗口照常打开。
   - 采集模式下，`discover`、`openConversation`、`send` 在函数第一行拒绝：
     - 错误码 `DOUYIN_CAPTURE_MODE`，提示"采集模式只观察页面，不自动搜索、打开私信或发送"；
     - 拒绝必须发生在任何窗口或页面操作之前。`send` 被拒绝时控制器记为 `not_attempted`（`keyword-acquisition.cjs:188`），不会产生 `outcome_unknown`。
   - `open`、`refreshAccount`、`openSource`、`readConversation` 保持不变。
   - 不改 `parsePageResponse`、`inspectPage`、`inspectConversation`、`capabilities`，也不改现有的 CDP 监听。

4. **被动观察网络**
   采集模块在同一个 `webContents.debugger` 上另挂一个 `message` 监听，不开启新的 CDP 域。
   - **保存响应体**
     - 条件：域名为 `*.douyin.com`、HTTP 200、JSON 能解析、不超过 4MB。
     - 只保存以下 4 个接口：
       - `/aweme/v1/web/search/item/`
       - `/aweme/v1/web/general/search/single/`
       - `/aweme/v1/web/comment/list/`（不含 `/reply/`）
       - `/aweme/v1/web/user/profile/self/`
     - 只在收到 `Network.loadingFinished` 之后调用 `Network.getResponseBody`。这是唯一允许的 `sendCommand`。
   - **网络索引 `network-index.jsonl`**
     - 记录范围：`*.douyin.com` 下路径含 `search`、`comment` 或 `profile` 的请求，以及 hostname 以 `imapi` 开头的请求。
     - 每条只记：时间、method、host、path、query 的**键名**、HTTP 状态码。
     - path 中像 ID 的段（≥6 位数字，或 ≥16 位 base64url）替换为 `:id`。
     - query 的值只保留以下白名单：`keyword`、`search_channel`、`type`、`offset`、`count`、`cursor`、`sort_type`、`publish_time`。
     - imapi 请求不保留任何 query 值，也不读取请求体或响应体。
   - 不读取请求头、响应头、`postData` 或 cookie；不处理任何 `Network.webSocket*` 事件。

5. **DOM 快照（用户按 F8 触发）**
   - **按键**：在抖音窗口的 `before-input-event` 里处理。
     - F8 触发一次快照。
     - **Enter 和 NumpadEnter 一律 `preventDefault`，带任何修饰键都一样**，防止在私信框或评论框里误发。
   - **窗口标题**：拦截 `page-title-updated`，标题固定为"关键词获客 · 抖音【采集模式：F8 保存页面，回车已屏蔽，已保存 N 份】"。
   - **页面函数**
     - 只在 `allowedUrl(webContents.getURL())` 为真时，经 `executeJavaScript` 执行。
     - 只读：返回一棵元素树（标签、白名单属性、文本），不修改真实页面，不滚动。
     - 不读取表单控件的 `value`，不读 `document.cookie` 和各类 Storage。
     - 节点上限 30000，单段文本上限 500 字；超出时标记 `truncated`。
   - **可见性和位置**
     - 所有不可见元素（`getClientRects().length === 0`）在输出中加上 `data-capture-hidden="1"`。这一步在 Node 侧序列化时加，不改真实页面。
     - 以下元素额外记录矩形：
       - `button`、`[role=button]`、`[contenteditable]`、`iframe`；
       - `a[href*="/video/"]`、`a[href*="/user/"]`；
       - `[data-e2e]`、`#captcha_container`；
       - class 含 `RightPanel`、`isFromMe`、`MessageBox`、`conversation`、`captcha` 的元素。

       这些选择器字符串来自调研报告对页面的观察，这里只用于统计。
   - **页面类型**按 URL 判定：`home`、`search`、`video`、`user_self`、`user_other`、`chat`、`other`。
   - **输出文件**
     - `dom/<序号>-<页面类型>.html`：可以离线加载的静态 HTML，不含 script、style、link、meta，也没有外链资源。C2 会把它加载进 Electron 的隐藏窗口，再运行页面函数。
     - 同名的 `.json`，内容包括：
       - 脱敏后的 URL 和页面标题；
       - 视口尺寸；
       - 上述每个选择器的元素总数和可见数；
       - `data-e2e` 各取值的出现次数；
       - 每个 iframe 的 host+path；
       - 文字恰为"私信""发私信"或"发送"的按钮数；
       - URL 是否含 `modal_id`。

6. **脱敏规则**
   全部在 Node 侧的纯函数里完成，页面函数不做脱敏。
   - **会话**：一次应用启动算一个会话。`createDouyinFixtureCapture` 时随机生成 32 字节 HMAC 密钥，首次写入时才建会话目录。同一次启动内多次打开、关闭抖音窗口，都写入同一会话，假名保持一致。
   - **内容 ID 原样保留**，也不做数字遮盖。这些值记入"已知内容 ID"：
     - 键名为 `aweme_id`、`cid`、`group_id`、`item_id`、`reply_id`、`reply_to_reply_id`、`logid`、`search_id` 的值；
     - URL 中 `/video/<id>`、`/note/<id>` 路径段和 `modal_id` 参数。
   - **用户 ID**
     - 识别：
       - 键名为 `uid`、`sec_uid`、`short_id`、`unique_id`、`user_id`、`sec_user_id`、`uid_str` 的值；
       - 键名以 `_uid`、`_user_id` 或 `userid` 结尾的值；
       - URL 中 `/user/<id>` 路径段（`/user/self` 除外）；
       - 任何位置出现的 sec_uid 形态字符串（以 `MS4wLjABAAAA` 开头）。
     - 处理：用 HMAC-SHA256 替换，**保持原格式**。数字类型的值按字符串处理。
       - 纯数字 → 等长数字，首位不为 0；
       - 其他 → `fx_` 加 base64url，长度与原值相同且不少于 8，仍能通过适配器的 `validPeer`（:7）。
     - 同一个原值在 JSON、DOM、URL 里必须映射成同一个值。原值记入"已知用户 ID"。
   - **昵称**
     - 识别：
       - 键名含 `nickname` 或 `remark_name` 的值，以及 `music.author`；
       - DOM 里 `a[href*="/user/"]` 内的文字；
       - class 含 `RightPanelHeadertitle` 或 `ConversationItemtitle` 的元素文字；
       - `/user/` 页面的 `h1`。
     - 依次替换成假名 `昵称01`、`昵称02`……（不用"用户…"，免得和抖音默认昵称"用户+数字"混淆）。
     - `profile/self` 返回的昵称固定映射为 `本账号`。
   - **全局替换**：字段规则处理完后，先序列化，再把"已知用户 ID"和 3 个字及以上的原始昵称（按长度从长到短）在全文中换成映射值。原因是视频描述、音乐标题、会话列表里也常出现昵称，只靠字段规则会漏。
   - **直接删除的键**（不区分大小写，键名含以下任一片段即删）：`cookie`、`token`、`ticket`、`session`、`passport`、`csrf`、`secret`、`bogus`、`verify`、`device`、`install`、`iid`、`webid`、`uifid`、`signature`（即个人简介）、`ip_label`、`ip_location`、`phone`、`mobile`、`email`、`birthday`、`school`、`province`、`city`、`district`、`address`、`location`。
   - **URL**
     - `*.douyin.com` 的 URL：保留 path，其中 `/user/<id>` 按用户 ID 处理；query 只保留 `modal_id`、`type`、`isPopup` 和第 4 步的白名单参数。
     - 其他域名（CDN 头像、视频地址、分享链接）的 URL 一律换成 `https://redacted.invalid/`；`url_list` 只留 1 个占位。
   - **DOM 属性**
     - 只保留白名单属性：`id`、`class`、`role`、`href`、`type`、`name`、`title`、`alt`、`placeholder`、`contenteditable`、`disabled`、`tabindex`、`aria-*`、`data-*`，以及 `iframe` 的 `src`（只留 host+path）。
     - `img`、`video`、`source` 的 `src`、`srcset`、`poster` 一律不保留。
     - `data-*` 的值按以下规则处理：
       - 等于已知用户 ID → 映射值；
       - 等于已知内容 ID → 原样保留；
       - 其他像 ID 的值（≥6 位数字，或 ≥16 位 base64url）→ 按用户 ID 的方式替换，但不记入"已知用户 ID"，并在 `manifest.json` 里按属性名计数；
       - 其余截到 80 字。
   - **文本**
     - 适用范围：
       - DOM 文本节点；
       - `title`、`alt`、`aria-label`、`placeholder` 属性；
       - JSON 中键名**不是** ID 类的字符串值。ID 类指 `id`、以 `_id`/`_ids`/`_id_str` 结尾的键、`cid`、`cursor`。
     - 遮盖以下内容：手机号、邮箱、微信号写法（"微信""vx""wx""v信"后面跟号码）、`@提及`、7 位及以上的连续数字。
     - 已知内容 ID 不遮盖。
   - **体积**：数组只保留前 20 项；字符串截到 2000 字；嵌套深度超过 16 的部分截断。
   - **写盘前的泄漏闸门**
     - 所有写盘都经过同一个函数：序列化后再扫描一遍，`network-index.jsonl` 按行判断。
     - 命中以下任一项，就不写这个文件（或这一行），只把 `manifest.json` 里该类别的拒写计数加 1：
       - 任何"已知用户 ID"的原值，或 3 个字及以上的原始昵称；
       - sec_uid 形态字符串；
       - 手机号格式的字符串；
       - **带值的**密钥：`sessionid`、`msToken`、`a_bogus`、`X-Bogus`、`ttwid`、`odin_tt`、`passport_csrf_token`、`s_v_web_id` 后面紧跟 `=` 或 `":"`，而且值非空。`network-index.jsonl` 只记键名，不算命中。

7. **输出布局**
   全部放在开发版数据目录下，不写进仓库。
   ```
   <runtime.rootDir>/keyword_acquisition/dev-capture/<YYYYMMDD-HHmmss>-<4位随机>/
     fixtures/              脱敏后的内容，交给 Claude 审阅
       manifest.json        会话信息、脱敏规则版本号、文件清单、拒写计数、未归类 ID 属性计数
       summary.json         字段存在性汇总（见下）
       network-index.jsonl
       responses/<序号>-<search_item|general_search|comment_list|profile_self>.json
       dom/<序号>-<页面类型>.html 和同名 .json
     local-only/            不提交、不外发、不进诊断包
       id-map.json          HMAC 密钥、哈希值到原值、假名到原昵称
       README.txt           写明上述限制
   ```
   `summary.json` 汇总以下内容：
   - 每条评论是否带 `cid`、`aweme_id`、`user.sec_uid`、`user.uid`；
   - 搜索结果里是否有 `data[].aweme_info.aweme_id`；
   - imapi 各 path 去重后的出现次数；
   - 每份 DOM 快照的选择器统计。

   控制台只打印输出目录和各类计数，不打印 URL 值、ID、昵称或正文。

8. **自检**
   - 新增 `desktop/src/main/douyin-fixture-capture.self_check.cjs`（验收第 1–6 条和第 8 条中的启动脚本检查），注册到 `run-self-checks.cjs`，放在 T2 注册的 `keyword-acquisition.self_check.cjs` 旁边。
   - 在 `customer-edition.self_check.cjs` 里追加打包排除和开关的断言（见验收第 7 条）。

## 允许改动

- 新增 `desktop/src/main/douyin-fixture-capture.dev.cjs`、`desktop/src/main/douyin-fixture-capture.self_check.cjs`
- `desktop/src/main/douyin-browser-adapter.cjs`：只加 `devCapture` 注入点和采集模式下的拒绝
- `desktop/src/main/keyword-acquisition-ipc.cjs`：只透传 `devCapture`
- `desktop/src/main/main.cjs`：只改 :641-645 附近的开关
- `desktop/scripts/run-self-checks.cjs`：只注册新自检
- `desktop/scripts/customer-edition.self_check.cjs`：只追加断言
- 新增仓库根目录 `启动抖音采集模式.cmd`

## 禁止

**法律红线**
- 不自己生成 a_bogus 或 X-Bogus 签名；不重放任何接口，包括拿观察到的 URL 重新发请求。
- 不调用 imapi 的 protobuf 接口；不解析 IM WebSocket：不订阅 `Network.webSocket*`，也不读取 imapi 的请求体或响应体。
- 不自动通过验证码：不点、不拖、不识别。
- 不复制 MediaCrawler、DouYin_Spider、CamarilloG、POKMJN 的代码，也不复制无许可证的 TeamBreakerr/douyin-chat-export 的代码。
- 不使用任何 GPL 或 AGPL 代码（如 TikTokDownloader、ChatGPT-On-CS）。
- 只能使用调研报告里记录的页面现象，即接口路径、选择器字符串和提示文案。

**只观察，不动作**
- 采集模块不发起任何网络请求，不导航，不点击，不输入（不调用任何 `Input.*` 或 `sendInputEvent`），不修改页面 DOM，不发送任何消息。
- 不启用 `Fetch` 域，不做请求拦截；不调用 `Network.getRequestPostData`、`Network.getCookies`、`Storage.*`、`Runtime.evaluate`。
- 不读取或保存 cookie、Storage、请求头、响应头、`postData` 和表单控件的值。

**范围**
- 不改 `parsePageResponse`、`inspectPage`、`inspectConversation`、`discover`、`send` 现有的判定逻辑，这些留给 C2。
- 不改 `keyword-acquisition.cjs` 的发送账本：`attempts`、`outcome_unknown` 不自动补发、`KEYWORD_DUPLICATE_SEND`、联系人上限都保持原样。

**打包与数据**
- 不把采集模块加入 `.dev.cjs` 白名单；不在 renderer 或任何 preload 里暴露采集相关的 IPC。
- 采集文件不进仓库、诊断包、云诊断或 `run_logs`；诊断事件里不写 ID、昵称或正文。

**操作边界**
- Codex 不登录抖音，不打开真实的抖音页面，不做任何抖音操作。这些全部由用户本人完成。
- Codex 不运行 `启动抖音采集模式.cmd` 或 `启动内部开发版.cmd`，也不启动开发版应用（原因见"背景"）。

## 验收（新增断言在当前 HEAD 上必须失败）

1. **脱敏（用合成数据）**
   构造 comment-list、search-item、profile-self 三类响应，以及一棵 DOM 树（页面函数返回格式的普通对象），其中包含：
   - cookie 和 token 字段；
   - 带 `a_bogus`、`msToken`、`verifyFp` 参数的 URL；
   - 手机号 `13812345678`；
   - 昵称 `小🐟睡不醒`，它还出现在另一条视频的描述里；
   - 纯数字 uid；
   - 形如 `MS4wLjABAAAA…` 的 sec_uid；
   - 19 位的 `aweme_id` 和 `cid`，DOM 里有指向同一个 `aweme_id` 的 `/video/<id>` 链接和 `data-*` 属性；
   - 带签名参数的 CDN 头像地址。

   断言：
   - `fixtures/` 下所有文件都不含上述原始 uid、sec_uid、昵称、手机号和 CDN 地址，也不含 `msToken=`、`a_bogus=` 这类带值的密钥；
   - uid 被替换成等长数字；sec_uid 替换后仍能通过 `validPeer`；
   - 同一个 sec_uid 在 JSON 里和 DOM 的 `/user/<id>` 链接里映射成同一个值；
   - `aweme_id`、`cid` 与原值完全相同；DOM 中的 `/video/<id>` 链接和 `data-*` 属性也保持原值；
   - 把脱敏后的 comment-list 交给现有的 `parsePageResponse`，仍能解析出这条评论，证明 fixture 可用；
   - 原值只出现在 `local-only/id-map.json` 里。
2. **网络观察**
   用假 `debugger` 依次发出以下事件：
   - 4 个目标接口各一组 `responseReceived` 和 `loadingFinished`；
   - 一条 imapi 的 `requestWillBeSent`，带 `postData` 和 `Cookie` 请求头；
   - 一条 `webSocketFrameReceived`。

   断言：
   - 生成 4 个响应文件；
   - imapi 请求在索引里只有 host、path 和 query 键名；
   - 假 `sendCommand` 只被调用过 `Network.getResponseBody`，而且从未针对 imapi 的 requestId 调用；
   - WebSocket 帧没有产生任何输出；
   - 所有文件都不含请求头或 `postData` 的内容。
3. **泄漏闸门**
   绕过脱敏函数，把未脱敏的内容直接交给写盘函数，分别含：
   - 已知原始 sec_uid；
   - 3 个字及以上的已知原始昵称；
   - 手机号；
   - `msToken=abcd1234`。

   断言：这四份都没有写盘，`manifest.json` 里对应类别的拒写计数各加 1。

   另写一行只含查询键名 `a_bogus`、`msToken` 的索引记录，断言它正常写入 `network-index.jsonl`。
4. **按键**：Enter、NumpadEnter，以及 Shift、Ctrl、Alt 加 Enter 全部被拦截；F8 触发快照；其他按键放行。
5. **适配器**
   - 传入 `devCapture` 时，`send`、`openConversation`、`discover` 都以 `DOUYIN_CAPTURE_MODE` 拒绝，且没有调用任何窗口方法。
   - 不传 `devCapture` 时，`send` 仍以 `DOUYIN_WINDOW_CLOSED` 拒绝。这一条是回归保护，在 HEAD 上本来就通过。
   - 用假的 `BrowserWindow` 和 `session` 调用 `open()`：`attach` 在 `Network.enable` 之后恰好被调用一次；关闭窗口后 `detach` 被调用。
   - `attach` 抛错时，`open()` 仍然成功。
6. **静态约束**（直接读源码断言）
   - `douyin-fixture-capture.dev.cjs` 中每一处 `sendCommand(` 的第一个参数，都必须是字面量 `"Network.getResponseBody"`。
   - `executeJavaScript` 只用来执行页面快照函数。
   - 该文件不含以下任何字符串：`Input.`、`sendInputEvent`、`insertText`、`insertCSS`、`dispatchMouseEvent`、`dispatchKeyEvent`、`loadURL`、`Fetch.`、`setRequestInterception`、`getRequestPostData`、`getCookies`、`Storage.`、`cookies.get`、`fetch(`、`net.request`、`http.request`、`https.request`、`Runtime.evaluate`。
   - 页面快照函数不含以下任何字符串：`.remove(`、`setAttribute`、`removeAttribute`、`innerHTML =`、`outerHTML =`、`.click(`、`dispatchEvent`、`.focus(`、`.value`、`scrollBy`、`scrollTo`、`scrollIntoView`、`document.cookie`、`localStorage`、`sessionStorage`。
7. **打包与开关**（写在 `customer-edition.self_check.cjs` 里）
   - `src/main/douyin-fixture-capture.dev.cjs` 文件存在；
   - `sourceAllowed` 对 test 和 delivery 两个版本都返回 false；
   - `main.cjs` 中 require 这个文件之前，必须有 `!app.isPackaged && developmentEdition && process.env.XIAOXI_DOUYIN_FIXTURE_CAPTURE === "1"` 这个条件；
   - `src/main/` 下文件名含 `preload` 的 cjs 文件，以及 `src/renderer/` 下的文件，都不出现 `douyin-fixture-capture`。
8. **命令**（在 `desktop/` 下执行）
   - 改动过的 cjs 文件都通过 `node --check`。
   - 以下自检全部通过：
     - `node src/main/douyin-fixture-capture.self_check.cjs`
     - `node src/main/keyword-acquisition.self_check.cjs`
     - `node scripts/customer-edition.self_check.cjs`
   - `npm.cmd run check:self` 通过。
   - 新自检里再断言两点：`启动抖音采集模式.cmd` 含 `XIAOXI_DOUYIN_FIXTURE_CAPTURE=1`、`chcp 65001` 和对 `启动内部开发版.cmd` 的 `call`；`createDouyinFixtureCapture` 用注入的 `log` 恰好打印一次输出根目录。
   - 实际启动由用户在采集脚本第 0 步验证，Codex 在 result 里注明"未启动开发版"。

## 需用户本人验收 / 授权（Codex 不做）

**前提**
- 准备两个自有抖音测试号：A 用新号，登录电脑上的采集窗口，里面不要有真实客户会话；B 用手机。全程不碰任何真实客户。
- **C3 之前，B 不要给 A 发私信，A、B 也不要互相关注。** 否则双方已不是陌生人，C3 无法复测"对方回复前只能发一条"。
- 采集期间尽量不要退出开发版应用。重启会开始新会话，假名不再对应。如果重启了，请在交付时说明。

**预期副作用**
- 点"私信"会在 A 的会话列表里生成一条"刚刚"的会话。
- 连续搜索可能触发验证码或风控，所以只能用测试号。

**数据处理**
- 采集到的数据包含第三方公开视频的作者和评论者，已做假名化。
- 哪些 fixture 入库，由 Claude 审阅后在 C2 决定。不需要的会话目录，由用户自行整体删除。

**采集脚本**（由调研报告的 9 步验证计划调整而来）

0. **启动**
   - 先确认开发版没有在执行微信任务：启动器会强制结束正在运行的开发版。
   - 双击仓库根目录的 `启动抖音采集模式.cmd`，确认命令行窗口打印了采集输出目录。
   - 进入"关键词获客"，点"连接抖音"，A 扫码登录，再点"刷新账号"。这一步会产生 `/user/profile/self` 响应。
   - 确认抖音窗口标题里有"采集模式"。
1. **准备**
   - 测试视频：用 A 或其他自有账号事先发布一条视频。发不发布由用户本人决定。
   - B（手机）：确认隐私设置允许陌生人私信（具体名称以当前 App 为准），然后在测试视频下评论"多少钱"。
2. **搜索**
   - A 在搜索框输入关键词，**点"搜索"按钮**（回车已屏蔽），切到"视频"页签，等结果出现后按 F8。
   - 再点开一条第三方的搜索结果视频，滚动到"全部评论"，按 F8。只看，不评论，不点赞。
3. **测试视频**：A 打开测试视频，滚动到"全部评论"，看到 B 的评论后按 F8。
4. **主页和私信浮窗**
   - A 点 B 的头像进入 B 的主页，按 F8。
   - 再点"私信"，等浮窗出现后按 F8。
   - 记下 A 的会话列表里有没有多出"刚刚"会话。
5. **草稿**
   - A 在浮窗输入框里输入"采集测试请勿发送"。**不按回车，也不点发送**。按 F8。
   - 全选删除，按 F8。
   - 关掉浮窗。
6. **推迟到 C3**：A 真实发一条私信给 B。需要 C2 合并后，由用户另行授权。
7. **推迟到 C3**，在第 6 步之后做：B 用手机回复，A 端采集收到的消息，并记下消息出现在会话列表还是陌生人消息里。
8. **反向测试**，分两部分：
   - **8a，本卡做**：
     1. B 把私信权限改为不允许陌生人；
     2. A 重新打开 B 的私信浮窗，按 F8，记下提示原文；
     3. B 恢复原设置。
   - **8b，推迟到 C3 最后做**：B 拉黑 A；A 在 B 回复前发第二条。第二条的前提是先发第一条；拉黑可能改变 A 与 B 的关系，影响 C3 的主测试。
9. **连续搜索**
   - A 回到首页，每隔 60 秒搜一个新关键词，共搜 3 个，每次结果出来后按 F8。
   - 一出现验证码就停下：先按 F8，再**手动**完成验证，并记下是第几次搜索时出现的。

**交付**：把 `fixtures/` 目录的完整路径，连同第 4、8a、9 步的手工记录一起交给 Claude。`local-only/` 不外发。
