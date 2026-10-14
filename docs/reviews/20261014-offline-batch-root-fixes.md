# #595288 隔离离线回放与根因修复（2026-10-14）

基线3194345 / 1.1.92。只在当前工作树修改，未发布；原APPDATA数据只读。任务：复用真实历史音频，不调用外部服务，原视频存在则走到真实成片；用户随后明确原视频已删除。

## 隔离与取证

SQLite通过只读连接backup到desktop/.build/offline-batch/data，不复制密钥。只复制目标run的10段WAV、声音试听及本机音乐（约28.6MB），未复制完整工程。隔离Python清除Key/Token类环境变量，socket connect/connect_ex/create_connection及提供方入口设为拒绝。过程未启动真实任务或写回批准。

5个原视频asset_locations均is_available=0、文件不存在。用户确认已删，因此停止寻找；未使用替代画面。可用镜头时长274109ms来自历史分析元数据，不意味着原视频当前可访问。

## 真实复现

原10段WAV和回听缓存均命中，音频总长93304ms，原方案22个整镜头共110000ms。当前rebalance函数同样报narrated_copy_too_long。根因不是总秒数简单小于配音，而是固定顺序、整镜头边界下各段的时长无法同时分配；不能把110秒与93秒直接比较后断言客户素材不足。

现有容量重排已能从历史可用镜头池扩展方案，但继续回放暴露两个程序缺陷：

1. _create_run每次generation固定1，input_hash由batch/candidate/revision决定；容量重排清掉旧_run_id却没改变这三个值，新建run时必撞UNIQUE(input_hash,generation)。修为同输入下一代generation；原run和音频记录不删除。新回归验证原run逐字段不变。
2. 容量重排重新按句子切段，把原10段拆成11段；文案虽相同，TTS/ASR缓存按短语文本匹配，导致缓存miss并试图新调用。离线拦截器成功挡住，未联网。修为容量重试且旧分段完整覆盖确认稿、满足长度约束时保留原分段，只重排镜头；文案改变或无有效旧段则正常重新分段。声音身份和缓存键不变，没有绕过缓存校验。

## 修后结果

- 原文对比不可变original-batch.json一致，10段音频摘要逐段与原缓存一致。
- 重新分配34个历史镜头窗口，预分配容量167411ms；按真实音频裁剪后画面时间线94744ms。
- 10段WAV通过原引擎缓存读取、回听记录复用、真实WAV拼接；输出recovered-narration.wav完整可解码，94744ms（93.304秒口播加段间停顿）。字幕/时间线已生成，时间线连续，源区间为正。
- 新run创建成功、无唯一约束错误。第一条修后回放的外部调用次数0。
- 第二条原来candidate_id=null，没有第二条文案/音频。实际进入rewrite_variation后在_cloud文本模型入口被拦截（1次本地拒绝、0次外部请求），没有编造第二条成功结果。
- 原始批次state_json SHA256前后完全一致，原两job仍skipped，原声音approved_at仍NULL。

## 没有验证／不能声称

- 未渲染最终视频：5个原视频已被用户删除。未验证画面、字幕实际烧录/遮挡、配乐混音、成片播放和导出。
- 音频回放直接调用内部缓存方法验证已有音频，不代表通过正常入口声音批准门禁；没有替用户批准。此批次正常入口仍需用户免费试听后决定批准。
- 未调用模型生成第二条文案、TTS或ASR；新内容端到端和新客户素材成功率未验证。
- 没有发布，运行中的正常桌面内容进程未在本轮重启加载新Python；后续正常启动才加载当前源码修复。

## 检查与证据

源码：narrated_batch.py、narrated_production.py；新增2个回归位于test_narrated_production.py。3个定向回归通过，随后相关整文件75项通过（6.357秒）；未重复跑全项目测试。Python导入/语法随回归通过，diff空白检查通过。

独立只读审查未发现业务阻断问题；指出最初unchanged_text自比较不构成证据，已改用不可变original-batch.json与输出plan.json对比并补正报告，无需重跑音频。

证据在outputs/offline-batch-20261014：snapshot.json、before-phrase-fix.json、replay.json、second-item.json、original-unchanged.json、recovered-timeline.json、recovered-narration.wav。复现脚本desktop/.build/offline-replay.py、offline-second.py。隔离数据约92.4MiB，证据约4.7MiB，保留用于原故障复查；没有清理历史备份或改动其他工作树。
