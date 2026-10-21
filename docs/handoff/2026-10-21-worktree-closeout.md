# 全工作树集成与内部发布收尾

## 目标与现场

本轮按用户确认规格保全全部独有成果，合入main，CI通过后完成test频道组件CD、本机正常入口更新验收，再退役4个附加工作树。新增付费、客户联系、真实微信/抖音与凭据变更不在本轮授权内。

起点main=e0a18ee（远端一致，CI 39532949803成功）；1798=8c62bc6，9187=31d488c，1ac9=f08d93d，product-detail-installed=fcd4aa0。

- product-detail-installed的5个独有提交已整合，保留较新的输入界面与措辞修复。
- 1798有36个变更：30个与安装验收树相同；3个为后续修复前的旧版本；3份独有验收文档已保全进入本次集成。
- 9187有75个变更文件；地图基础链路多数已在main，保留主线50家队列及启动/更新保护，按增量接入精准获客、GEO、服务端及证据。
- 旧启动反馈overlay基于1.1.93固定启动器，已被1.1.97+缓存启动和完整验证链取代；不倒退固定底座，也不引入未使用的overlay模块。原源码和记录保存在外部快照。
- 1ac9无独有提交或未提交源码。

## 修复与审查

独立只读审查发现并修复：旧map-legacy-owner标记兼容、GEO资料和平台会话跨账号隔离、同步写盘失败后busy解锁。第二轮发现最终生图authority重引入原宣传保证，已让render与生成器共享printable_captions，真实generate_v2 API请求捕获红测复现后修复；复查通过。原始计划与依据、旧政策行为保留。

## 已验证

- 详情图全套pytest：584 passed，1 skipped（可选PyYAML未装），127 subtests通过。修复后的定向113项通过；最终完整套再次通过。
- 账号A/B/A、退出登录、旧地图归属和独立精准迁移、GEO分区、写盘失败恢复及真实本机HTTP双端同步检查通过。
- 精准获客来源、附件、证据与费用边界；测试renderer构建通过。
- 精准获客生产React/preload/IPC隔离验收通过，涵盖来源未接通提示、导入/确认/复制/共享跟进/重开恢复、1024px及滚动；地图/GEO隔离界面检查通过，7个发布门禁及付费门禁关闭。
- 网关获客定向unittest：7项，1项缺可选pypdf跳过；CI安装该依赖后复核。
- 全源码检查首轮因人为TZ=Asia/Shanghai与本机Windows东部时区不一致，分钟判断夹具失败；未改系统设置或业务逻辑，移除TZ后该项通过，继续执行余下检查。

证据根目录：D:/OpenAI/WorktreeCloseout/20261021-xiaoxi；包含原始dirty快照、逐文件SHA256清单、已验证before-integration.bundle、命令日志及工作树空间盘点。截图在主目录desktop/.build/precise-preview和business-preview。

## 合并、CI 与内部 CD

- 集成提交17fbba9c0aa9dc99f65a2029ce20021c206babcf；[PR #41](https://github.com/survivor2829/AIsell/pull/41)已合并，发布源码main=265430d78011306c01fd16cca25539bc3b6f893c。
- [PR CI 39552043313](https://github.com/survivor2829/AIsell/actions/runs/39552043313)、[主线CI 39553627546](https://github.com/survivor2829/AIsell/actions/runs/39553627546)成功；源码与服务检查通过。可选CI安装器作业未触发，实际安装器在本机发布链完成校验。
- 1.1.104从干净main构建；release:internal全源码检查、本地E2E、组合应用及运行时门禁通过。离线详情图E2E生成6屏、恢复6屏并导出1,959,163字节PNG，未新增付费调用。
- 原公开1.1.97完整包底座指纹3faa7628…，本机1.1.103及此次候选为d52347df…；49个实际文件差异包括Python/SSL运行库。首次组件发布在签名/上传/清单切换前被release_full_fallback_missing阻止。未绕过兼容检查或降级运行库：将已验收组合候选逐字节复制到完整包目录（整树SHA256=97819ef3997e80c481ee851d152fe00c12aa4360842c34bb9bb36e472e7c7f5c），经既有安装器门禁构建同源码完整桥接包，再发布原组件候选。
- test完整包655,802,269字节，SHA256=38b6ff242c20a2d075052a549a20bac42f0a45baaee1699d0c7fb35ba7837172；序号1792564698145；签名清单摘要4151affd6ae6d8e21fdabb4bb72c5935b5bd346eaaa0cafd1b959340145eb35b，公开读回通过。
- 四组件合计214,485,493字节，序号1792566106009；签名清单摘要324fb39f25c04eb6747fda7b25f337561a3b616aefbcc57e372d6374da633e39。公开完整包完整下载/摘要校验及组件签名读回通过。

| 组件 | SHA256 |
|---|---|
| application | af92cb7128d06f83b0e7c4b86c38ec915d5c7df3543482fb69921f08c642cd1f |
| content-engine | 9fb822b728e7222777b1577a6c6a19cb64718ef55dec481948ba08945b9ce55c |
| product-detail | ba161f2e8beca6b8a2f025416b7fc504e614bd3397f3e49c2743489a8169dc5e |
| video | f74bd5b13eaf3bbf5537127743192d0ced232819637be8d6b8ae4089d338ca4c |

服务器通过现有upgrade.sh部署获客/同步增量及公开来源目录。部署tar SHA256=b6ac3c289beceadf8c62ec39ac5809dcb1db9efc5178d22754bfedae939f70c9；备份/var/lib/ai-provider-gateway/backups/20261021T062319Z-4144823；健康runtime_revision=3a98ea075a779149。4个部署文件与归档字节相同，和main仅有Git/Windows换行差异；catalog与sync/pull的POST无认证返回401。未改预算、搜索开关或凭据。

补齐既有requirements-precise.txt声明的pypdf依赖：6.21.1纯Python wheel SHA256=553e2d42f5bb3bb2a785a7d3de8ef90bb7df74b5413eff5a7b4388007ea9254b，经摘要核验后只安装到/opt/ai-provider-gateway；未安装系统pip或改系统Python。使用实际服务用户ai-gateway运行7项离线获客/同步检查，全部通过、无跳过；文字PDF可提取，空白/扫描类PDF仍明确parseIncomplete，不冒充OCR。健康复核通过；search/read开关仍关闭，不将解析依赖就绪当作真实采购来源验收。

## 本机正常入口验收

安装目录C:/Users/Scott/AppData/Local/Programs/AI获客-测试版，资料目录C:/Users/Scott/AppData/Roaming/xiaoxi-active-touch-test。更新前用既有backup:local记录1.1.103组件选择回退点，未复制整份资料。

- 软件内“检查更新→立即更新”下载204.5MiB组件并启动1.1.104；任务f9c7a934-29f9-48fe-92fa-71e20c521750返回complete，ACK={ok:true,version:1.1.104}。active为新签名清单摘要，previous为原1.1.103的95e44acc…，pending=null、failure为空；未手改选择文件。
- 正常关闭再打开，保存的授权可登录；网关会话完成，详情图paid_ai_ready=true仅证明配置就绪，不代表新增付费生图通过。
- 地图16个任务、100条线索及各自ID摘要不变；精准工作台迁入100家企业，推荐采购商机仍为0，明确显示来源未接通。GEO读取7个发布渠道及豆包检测入口，未验收发布保持关闭并说明原因。
- 36张业务表记录数保留；除正常登录更新users表外，35张表内容摘要与起始基线一致。322个详情图基线文件中319个摘要不变，3个受控vendor静态资源同步后与包内摘要一致；原图、成图、费用回执均未改写。
- 历史任务v2_1792558403624_2c7172的11屏全部恢复为1536×2048；点击单张及完整长图下载，分别为1536×2048、1536×22528，与原文件SHA256一致。导出样本移入外部证据目录downloads/，未覆盖桌面旧文件。
- 本机上传原素材、出现“确认AI精修任务”后点击取消；请求记录仅有本机/api/upload及读取历史，未出现execute或其他新增付费请求。确认窗与三个工作台截图已保存并查看。

## 工作树保全与退役

四个附加工作树均已通过原生git worktree remove注销并移除，最终只保留主目录main；3个成果分支和集成分支已删除，远端集成分支也已删除，远端仅main。没有强制移除dirty工作树。

| 工作树 | 成果与原现场去向 | 保全文件 / 字节 |
|---|---|---:|
| 1798 | 有效详情图增量及3份文档进入main；原dirty快照6d21a6f…保留在refs/archive/worktree-closeout-20261021/1798；其余资料迁至外部1798/ignored | 2,969 / 689,042,962 |
| product-detail-installed | 5个独有提交已合入main；原HEAD=fcd4aa0；验收资料、原图与回执迁至外部同名ignored目录 | 8,427 / 5,204,469,576 |
| 9187 | 增量按块进入main，旧版整文件未覆盖主线；原dirty快照bbc4bc4…保留在refs/archive/worktree-closeout-20261021/9187；其余资料迁至外部9187/ignored | 1,159 / 135,233,934 |
| 1ac9 | 无独有成果；原HEAD=f08d93d已在main；完整底座、回滚包和旧验收素材迁至外部1ac9/ignored | 23,495 / 13,861,486,401 |

受保护文件共36,050个、19,890,232,873字节（约18.52GiB），迁移前后逐文件SHA256验证通过；junction按链接对象迁移，目标和恢复映射保留，未遍历或删除共享依赖。主目录node_modules、Python环境、抠图模型和发布浏览器均独立位于主目录或通用运行时，不依赖退役树。

原dirty路径逐项stash，核对stash工作树/未跟踪父树的Git对象后保存永久archive引用；未丢弃已有stash。before-integration.bundle与after-closeout.bundle均验证通过，后者包含原始分支、dirty archive引用及完整历史。恢复步骤见外部RESTORE.md和每树manifest.json、ignored-manifest.json、relocation.json。未证实与压缩包等价的展开发布目录完整保留。

仅回收清单中的6个可再生目录：四树desktop/dist-development，以及1ac9、product-detail-installed的desktop/.build/runtime-cache；.tmp、outputs、原始付费成图、费用回执、旧验收视频、当前与必要回退版本均保留。Windows长路径处理中途安全停止后按原清单续行，未扩大删除范围。

原生Git移除1798后，空目录仍被本次Codex会话的5个空闲工具进程持有工作目录句柄；按父进程、可执行路径和cwd逐一核实并结束这些工具进程后，空目录也已移除，没有结束业务应用或其他项目任务。

清理前后实测D盘净空闲增加5,382,328,320字节（约5.01GiB）；这是记录窗口内净变化，未把18.52GiB保全资料算作释放空间。C盘同期净空闲减少35,319,808字节，未宣称C盘回收。空间快照与逐候选结果保存在外部space-before-cleanup.json、space-after-cleanup.json、cleanup-results.json。

## 验收边界与后续手动复验

新措辞实际AI成图、三城真实商机与GEO发布检测尚未完整验收，本轮无预算不新增购买。历史11屏和旧实采证据不冒充新生成或未知渠道验收。不能因此宣称全部业务能力收尾。

后续需在另行批准预算和账号范围后，用新产品资料验证真实策划/成图与费用回执；按三城试点资料核验真实采购来源、联系方式与跟进；逐渠道完成GEO真实账号授权、编辑器、发布回执和豆包引用检测。先查询原任务和回执，不因结果未知重复购买。构建、CI、CD、本机升级通过不替代这些业务验收。

耗时和空间以命令日志及现有space-usage报告为据；不将目录逻辑大小当作实际释放量。后续仅文档收尾提交不改变本次包内源码提交265430d。
