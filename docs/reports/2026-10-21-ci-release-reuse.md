# 1.2.6 CI与内部发布复用

## 改动与安全边界

从“两轮全量”改为“PR完整检查＋main独立证据核验”。PR的五组源码、服务、本地详情E2E、两种界面构建均保留；core保存373字节的实际合成合并checkout证明。main只在同仓已合并PR、原run/attempt整体及全部必需检查成功、证据未过期、实际Git提交对象的全树与最终main相同、受检base等于main父提交时复用。没有仅凭head提交标签或成功汇总放行。

main事件范围相关的失败原因检查另行执行。文件树或基线变化、原CI缺组/失败/取消/跳过、外仓、证明缺失/过期、查询失败均不复用，正常运行完整检查；手动工作流保留全量。发布端再次独立查验原始证据链；未经证明的skipped不是成功。产物、运行时、隐私、归档摘要、签名读回、候选与安装版验收继续执行。

`release:internal:prepare`自动等待现有main CI，以`--require-ci`衔接构建，证据不完整时停止，避免CI仍在跑又启动本地全量。入口只到candidate-ready；候选验收后沿原publish入口发布同一产物，未自动跳过验收。原release:internal的本地后备检查与force-checks仍可显式使用，没有新依赖、系统服务或计划任务。阶段时钟记录见`.build/internal-release-pipeline-1.2.6.json`。

## 验证及首次上线返工

既有internal-release及runner定向检查通过；新增同树复用断言在旧实现undefined!=84失败。全树/父基线失配、非合成合并checkout、attempt失配、原组跳过、缺E2E、过期与外仓均拒绝复用。独立只读审查指出连续入口可能在候选未验收前发布，已改为仅准备候选并复查关闭。

PR #61（57e70b7）完整CI39715700978为200秒，main1911885的39716073032轻量核验19秒成功。实际Actions在job级if为false时返回一条未展开名称`source-${{ matrix.group }}`的skipped矩阵；发布端只认识五条具体作业，安全停止，没有偷偷回退重跑或发布。PR #62仅兼容该精确表示，并要求具体五组均不存在；原PR所有实际组/E2E仍独立核对。新增断言旧失败新通过，独立复查无发现。

最终PR #62（1be3f16）完整CI39716475593为212秒，main6185b52f922f1d7aed43db16d9ec0140324976f2的39716868899仅16秒；源码矩阵与服务未重复执行，范围门禁及汇总成功。最终构建记录同时保存sourceRunId39716475593、实际受检提交9bb52792c1fab67943d7d3037e9271831857b886、完整tree83809ce9fa7ac2828930b9d49a2f781cabc06699和main run id。

## 总时间，不能用轻量核验降幅替代全链路降幅

以下以最终PR CI首runner开始作为前后可核验起点，包含合并、调度、准备、上传及操作衔接等待；排查写代码不在此区间。客户端日期均为10月21日，证据原文用UTC。

| 阶段 | 1.2.5 | 1.2.6 |
|---|---:|---:|
| 完整PR CI | 194秒 | 212秒 |
| 合并后main | 完整198秒 | 证明核验16秒 |
| 组件构建 | 109.1秒 | 141.3秒 |
| 发布与签名读回 | 68.9秒 | 78.4秒 |
| 软件检查下载至ready | 14.141秒 | 15.661秒 |
| 首runner至本机更新成功 | 12分24秒 | **10分10秒** |
| 首runner至安装检查结束 | 约15分24秒 | **11分22秒，含一项未通过** |

到本机更新成功约缩短18%，不是把main198→16秒的92%降幅说成全链路收益。本轮新npm准备命令改变现有Remotion package指纹，发生一次重建；未绕过安全指纹强行复用。构建与发布比上轮分别多约32/10秒，净收益因此小于省下的第二轮CI。上轮检查结束时间取最后成功UI证据的文件修改时间，只作近似对照；本轮检查有冷进入失败，两行不能解释成两次全项通过的同等验收性能对照。

最终代码冻结23:22:26.674，安装检查结束23:33:55.540，历时11分29秒。自初次代码冻结23:13:53.915计则20分02秒，包含平台表示适配返工及第二个不同提交的完整CI；这段首次上线成本单列，未隐藏或算成正常路径已节省时间。记录在126-flow-comparison.json。

## 候选、发布、本机及未通过项

干净main与包提交6185b52一致，源码/E2E证明实际复用；两类Python缓存命中，视频运行时一次重建，组合程序和隐私门禁通过。对同一候选用独立空profile实际启动126、检查登录UI与preload、无renderer错误并正常退出；未复制业务资料、修改窗口尺寸或付费调用。此次只有发布流程与版本公告变化，业务生产代码未改。之后发布内部test，签名清单读回成功，实际125→126下载33,651,503字节（application/video），assets/content-engine/updater/product-detail及底座105不变；健康ACK成功，首启JSON核验45ms。

真实正常退出助手complete、pending=false，PID5460及创建时间匹配，无人工调用回收器或强杀；generation保持6，两份101/104备份依赖不变，客户端跨根去重22.840GiB。联系人8、素材108（72可用位置）、首200条任务、成片88（43可用）与地图16任务/100企业及收藏跟进摘要均与更新前一致。

**冷进入两秒目标再次复现未达标，不能关闭。** 新进程首次页面/选中42ms，但编辑6457.1ms、资料6559ms；热编辑15.8ms，快速切换仍及时，renderer零长任务。启动日志gateway_session_finished为6049ms，现有content beforeStart明确等待网关会话，时间与此等待吻合。生产main/混剪/内容引擎代码相对125无差异；不能据此宣称是新CI引入，也不能只凭上轮三次快样本保证所有首启达标。本轮未扩大为网关授权/本地读取改造，保留授权和费用保护；状态为completed-with-known-issue而非全项通过，后续需隔离本地编辑与云端会话准备后再验证。

本机证据位于desktop/.build：126-proof-check/red.log、126-matrix-green/red.log、126-ci-pr/final及main-initial/final.json、126-prepare-initial-failed.json、internal-release-pipeline-1.2.6.json、126-candidate-acceptance.json、126-component-release.json、126-publish.log、real-update-1.2.6-terminal.json、1.2.6-actual-first-startup.json、126-actual-normal-exit.json、126-installed-fresh.json、126-cold-startup-timing.json、before/after-126-business.json、126-map-before/after.json、126-installed-accepted.json及126-flow-comparison.json。未做正式客户发布、真实微信发送、付费生成或历史业务数据删除。
