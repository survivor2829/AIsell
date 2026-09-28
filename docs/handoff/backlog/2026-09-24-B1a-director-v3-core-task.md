# B1a 导演 v3 核心：11 项方案结构、事实守卫、提示词编译、保守模板（离线）

分支：`codex/director-v3-core`

## 依赖与顺序

- **开工前须合并**：T2、B0、T3。原因：
  - T2 改 `scripts/run-self-checks.cjs`；
  - B0 改 `SKILL.md:8` 和 `video-directors.cjs`；
  - T3 改 `product-video.self_check.cjs`。
  
  本卡这几个文件都要动。与 T1、T4、T5 没有文件重叠。
- **后续卡**：
  - B2 依赖本卡输出的分段结构；
  - B1b（大模型导演接入产品视频）在 B2 之后；
  - B1c（规划器的数字人入口，不接服务）在 B1b 之后；数字人的服务、IPC、页面接入由 **B5b** 负责，B5b 在 B1c 之后；
  - B3a 用本卡的 `sentences` 和 `subtitle` 做配音稿和字幕，并通过 `seamsOf(plan)` 读本卡的 `seams`。
- **发布约束**：本卡合并后，产品片提示词不再让模型念旁白，成片只有环境声，旁白只进字幕。**B3a、B3b 合并之前不要发布产品视频。**
- **行号**：均按 HEAD `258e37a`。B0、T3 合并后请按函数名重新定位。

## 背景

- 现在的"导演"是写死的模板：`video-directors.cjs:35-95` 的 `planVideo`，加上 `skills/cleaning-video-director/rules.cjs:3-27` 的固定句子。
- `SKILL.md` 在运行时不会被读取。全仓只 require 了 `rules.cjs`，位置在 `video-directors.cjs:1`、`digital-human-provider.cjs:10`、`digital-human-service.cjs:6`。
- 我在 HEAD 上用纯函数跑了 `planVideo` 和 `videoPayload`（场景：医院，地面：水磨石，目标：作业，带资料），实测问题如下：
  - **提示词过长**：产品片每镜约 430–580 字（随资料长度变化）；数字人 672 字，文案 160 字时达到 820 字。火山建议中文提示词不超过 500 字。
  - **旁白在句中截断**：60 秒第 3 镜的 `facts.slice(0, 42)`（:74）输出了"…清水箱容。"这类半句。
  - **说法自相矛盾**：同一行旁白写"我们已确认"（:74），但 `evidenceStatus` 是 `user_supplied_unverified`（:87）。
  - **固定 15 秒一镜**（:45、:76），30 秒要拆成两次调用。提示词写死"单镜头15秒"，并让视频模型念旁白（:79）。
  - **把事实判断交给视频模型**：例如"仅当它与已提供事实一致时表达"（:79）、"只有事实明确支持时才表现设备作业"（:51）。视频模型做不了这种判断。
  - **产品片不能有人**：写死了"无人物出镜"（:48）和"不添加虚构操作者"（`rules.cjs:12`）。手推式、驾驶式设备因此无法合理地表现作业。
- 已定方向（计划 B1、B2、B3 和用户决定）：
  - **字段**：共 11 项，第 6 项是整片调色。
  - **操作员**：产品片可以出现 AI 生成的操作员，由用户开关控制。
  - **分段**：每段 4–30 秒，30 秒为 1 段，45 秒和 60 秒各 2 段；段内可以有多个镜头；每段写明开头状态和结尾状态；段与段的接缝落在句间停顿处。
  - **声音**：产品片旁白走 TTS（B3），视频模型只出环境声，**旁白文字不进视频提示词**。
  - **数字人台词写法**：沿用现有的 `JSON.stringify(script)`，也就是双引号（`digital-human-provider.cjs:115`），与火山"对白放在双引号内"的建议一致。调研里用 `{}` 包台词的写法来自第三方，不采用。
  - **分段模型**：调研里有过"每片最多 4 段、每段 15 秒"的设计，现统一改用上面的分段模型。

本卡只做纯函数和知识包。不调用大模型，不接服务状态机，不改页面。

## 要做

1. **知识包** `desktop/src/main/skills/cleaning-video-director/`
   - **重写 `SKILL.md`**：
     - 只做目录，写明版本 3；
     - 11 项字段各用一句话说明；
     - 列出 references 各文件的用途；
     - 不出现子角色姓名（见 `docs/agent-roster.md:3`）。
   - **新增 `references/`，共 6 个文件**：
     - `fields.md`：11 项字段的写法，分三类视频说明用法：无人产品片、有操作员的产品片、数字人。
     - `equipment.md`：设备类型与操作方式的对应。手推式对应推行，驾驶式对应驾驶，只有洗地机器人可以无人自走；大件设备不能手持。
     - `scenes.md`：5 个产品场景和 3 个数字人场景各自的光源、敏感元素，以及湿地面反光的处理。
     - `prompting.md`：编译规则，见第 4 步。
     - `fact-policy.md`：事实政策的人读版，并注明"以 guard 代码为准"。
     - `digital-human.md`：开头钩子和结尾咨询引导的规则。
       - 来源：HEAD 上 `video-directors.cjs:60-65` 的 `socialShots`、:75 的开头提问与结尾留言，以及 `rules.cjs:4`、`:11` 的 social 分支。B0 会删掉这些代码，请用 `git show 258e37a:<路径>` 读取。
       - 口径与 B5b 一致：第一句是现场问题或痛点，可读字数 ≤13（约 3 秒）；最后一句由本人说出，引导留言或私信说说现场情况；不含电话、微信号、链接；不承诺"爆款"，不虚构价格或权益。B5b 可以在此文件上补充。
   - **新增 `index.cjs`**，提供三项：
     - `SKILL_VERSION = '3'`；
     - `skillHash(dir = __dirname)`：取目录内除 `rules.cjs` 以外的所有文件，按相对路径排序，换行统一成 LF 后计算 sha256。Windows 的 CRLF 检出不能改变哈希。`dir` 参数只供自检用临时拷贝。打包脚本会整体复制 `src/main`（`scripts/build-portable-release.cjs:162-168`；:58 只排除 `.py` 和文件名含 `self_check` 的文件），所以安装包里的哈希与开发环境相同。
     - `promptContext(videoType)`：从 SKILL.md 和 references 中取出带 `<!-- director:common|product|digital_human -->` 标记的片段，拼接后供 B1b 作为系统提示词。每种类型不超过 6000 字。
   - **不改 `rules.cjs`**，VERSION 保持 `'2'`。原因：数字人在 B5b 接入导演之前仍使用 `humanDirection`，并把这个版本号记为 `directorSkillVersion`（`digital-human-service.cjs:297`），提前改会记错。

2. **`skills/cleaning-video-director/schema.cjs`：手写结构校验器**
   - 不引入 ajv，也不引入任何新依赖。
   - 检查范围：必填项、类型、枚举、长度上限，禁止多余字段。
   - 返回 `{ errors: [{ path, code, message }] }`。
   - 另外导出 `validateProductProfile`，供 B1b 看图识别使用。
   - `director.v3` 的字段如下。除标明 `null` 的以外均为必填；长度单位为字；`[≤n]` 表示数组上限。

   ```
   schemaVersion "director.v3" · skill {version:"3", hash} · plannerSource llm|llm_repaired|template_fallback · fallbackReason ≤40|null
   videoType product_static|product_operator|product_autonomous|digital_human
   durationSeconds 产品 30|45|60；数字人由调用方 context.durationRange 给（当前 10–15，B5 放宽）
   sourceResolution "480p"
   productProfile {category walk_behind_scrubber|ride_on_scrubber|robot_scrubber|sweeper|vacuum|other|unknown,
     sizeClass handheld|portable|walk_behind|ride_on|unknown, operation pushed|ridden|autonomous|handheld|stationary|unknown,
     visibleParts[≤8,≤12], colors[≤4], visibleText[≤4], source vision|user|none}
   evidence {level appearance_only|user_attested, facts[≤12]{id F1–F12, text≤120,
     kind category|appearance|surface|operation|spec|result|service, source photo_visible|user_attested}}
   1 concept {audience≤40, pain≤60, keyMessage≤60, hook≤40, cta≤40, factRefs[]}
   2 personReference {presence none|generated_operator|authorized_self,
     references[1–4]{slot @图片1–@图片4, role product_appearance|person_identity|approved_composite|scene_keyframe, keep≤40}}
   3 photography {defaultAngle eye|low|high, depthOfField deep|medium|shallow, productScale≤40}
   4 visualDirection {style≤30, productHero≤40, sceneArt≤60, textSafeArea none|bottom_20|top_15}
   5 skin null | {toneLock≤30, texture≤30, castControl≤30}
   6 colorScript {whiteBalance neutral|warm|cool, palette[≤3,≤12], productColorLock true, singleGrade true}
   7 lighting {motivation≤30, key≤20, fill≤20, shadowDirection≤20, floorReflection natural_soft|dry_matte}
   8 personDesign null | {role≤16, wardrobe≤20, faceEmphasis low|medium|high,
     interaction push_walk_behind|ride_on|stand_beside_point|hold_small|present_to_camera, gestures[≤3,≤16]}
   9 timeline {sentences[]{id S1…, text≤60, factRefs[]},
     segments[1–2]{id G1|G2, startSec, endSec(整数), audioPolicy ambient_only|silent|native_dialogue,
       startState≤30, endState≤30, sentenceIds[],
       shots[1–5]{startSec, endSec, shotSize WS|MS|MCU|CU|ECU, angle eye|low|high|top_down,
         move static|push_in|pull_out|pan_left|pan_right|tilt_up|tilt_down|track_lateral|track_follow|orbit_slow,
         intent establish|appearance|operation|detail|result|cta|talk, productState static|operating,
         subject≤16, action≤30, partsShown[≤3], factRefs[]}},
     seams[]{afterSegment, afterSentence, type scale_cut|broll_cover|xfade}}
   10 sound {narration tts|native_dialogue, voiceStyle≤30, charsPerSecondMax 4.5, ambience[≤3,≤12], music none|light_bed}
   11 negative {product[≤6], scene[≤6], person[≤6], render[≤6]}（每条≤20）
   ```

3. **`desktop/src/main/video-director-guard.cjs`：跨字段规则与事实守卫**
   - 入口：`reviewPlan(plan, context)`，其中 `context = { operatorAllowed, durationRange, userScript? }`。
   - 先调用 schema 校验，再检查下面两组规则。
   - 返回 `{ errors, warnings }`。只有 errors 会触发 B1b 的修正和回退。

   **结构规则**
   - **R1 分段**：段数等于 `ceil(durationSeconds/30)`；从 0 开始首尾相接，每段 4–30 秒，总和等于时长。这与 B2 卡第 1 步的契约相同。
   - **R2 镜头**：每段内的镜头首尾相接，总和等于段长。产品片每个镜头 3–8 秒；数字人每段不超过 3 个镜头，每个至少 4 秒。
   - **R3 句子与接缝**：
     - 每个句子只属于一段，并按顺序排列；每段至少 1 句；
     - 接缝数等于段数减 1，`afterSentence` 必须是前一段的最后一句；
     - `scale_cut` 类型的接缝，前一段末镜与后一段首镜的景别不能相同。
   - **R4 语速**：每段句子的可读字数（去掉空白和标点）不超过 `floor(4.5 × 段秒数)`。产品片整片低于每秒 2.5 字时只给 warning。
   - **R5 声音**：
     - 产品片各段只能是 `ambient_only` 或 `silent`，且 `sound.narration=tts`；
     - 数字人各段是 `native_dialogue`，且 `sound.narration=native_dialogue`。
   - **R6 人物**：
     - 按片型：
       - `product_static` 和 `product_autonomous` 必须是 `none`；
       - `product_operator` 必须是 `generated_operator`，并且要求 `context.operatorAllowed === true`；
       - `digital_human` 必须是 `authorized_self`。
     - 按人物设置：
       - `none` 时，`skin` 和 `personDesign` 都必须为 null，否则两者都必填；
       - `generated_operator` 时，`faceEmphasis` 必须是 `low`。
   - **R7 物理合理性**：
     - `productState=operating` 须同时满足两条：
       - (a) 该镜头引用了 `kind=operation` 的事实；
       - (b) 以下二者之一成立：
         - `product_operator`，且 `interaction` 与 `operation` 对应：pushed 对应 `push_walk_behind`，ridden 对应 `ride_on`；
         - `product_autonomous`，且 `operation=autonomous`。
     - `product_static` 和 `operation=unknown` 时不允许 operating。
     - `hold_small` 只允许用于 `sizeClass` 为 handheld 或 portable 的设备。
     - `partsShown` 里的每一项，必须出现在 `productProfile.visibleParts` 中，或出现在所引用事实的原文中。
   - **R8 参考图**：
     - 必须有 `product_appearance`；
     - slot 从 `@图片1` 起连续编号；
     - 产品片（三种 `product_*`）**只能有一张**：`@图片1 product_appearance`。原因：B2 的请求体 `image_urls` 只有 `[task.imageUrl]`，并禁止新增参考图种类；方案里多写 `@图片2` 会让提示词指向不存在的图。场景定妆帧要另开卡。
     - 数字人固定为：`@图片1 approved_composite`、`@图片2 person_identity`、`@图片3 product_appearance`，与 `digital-human-provider.cjs:109` 的顺序一致。
   - **R9 事实引用**：
     - `factRefs` 必须指向已存在的事实；
     - `intent=result` 必须引用 `kind=result` 的事实；
     - `evidence.level=appearance_only` 当且仅当没有 `user_attested` 事实。
   - **R10 数字人台词结构**（口径同 B5b）：首句等于 `concept.hook`，末句等于 `concept.cta`；hook 可读字数 ≤13。

   **事实守卫**
   - 扫描范围：`concept` 的 pain、keyMessage、hook、cta；`sentences[].text`；各段的 startState 和 endState；各镜头的 subject 和 action。
   - **不扫描** `evidence.facts` 和 `negative`。"不出现患者"这类否定约束不能误报。
   - **G1 始终拒绝的词**：
     - 移植 `desktop/sidecars/content-engine/content_engine/narrated_batch.py:446-454` 的正则（认证、资质、排名、保证、收益等），改用 JS 的 `u` 标志；
     - 加上 :4262 的"零残留、无死角、瞬间吸净"；
     - 再加"100%、百分百、彻底、一尘不染、永不、杀菌、除菌、抑菌、消毒、医院指定、指定产品/设备/品牌"。
   - **G2 须有事实依据的词**：防滑、一次干透、不留水渍、无水渍、省水、节水、省人工、省时、替代 N 人、一人顶 N 人、效率提升、续航。只有当该元素引用的事实原文里包含同一个词，才允许出现。
   - **G3 带单位的数字**：
     - 覆盖阿拉伯数字或中文数字，后接以下单位：㎡、平方米、平米、m²、小时、h、分钟、升、L、公斤、kg、%、分贝、dB、V、伏、Ah、毫米、mm、厘米、cm、米、km/h、W、瓦、rpm、转；
     - 单位按同类归一（例如 ㎡、m²、平米都视为平方米）；中文数字转成阿拉伯数字后再比较（支持到"万"，如"三千""一万五千"；转不了的按原文比较）；
     - 归一后的数字和单位，必须出现在该元素引用的事实原文中。
   - **G4 措辞**：资料最多只是 `user_attested`，所以拒绝"已确认、已核实、经检测、实测、检测报告、权威数据"。
   - **G5 人物**：镜头和状态文字中拒绝"患者、病人、医生、护士、医护、学生、儿童、小孩、未成年"。
   - **G6 调色**：拒绝"调色、滤镜、变亮、变白、提亮"。禁止用调色冒充清洁效果。
   - **G7 联系方式与价格权益**：拒绝手机号或座机号、网址（`http`、`www.`、`.com`、`.cn`）、"微信号、加微、vx、QQ"，以及"价格、报价、优惠、折扣、特价、免费、赠送、包邮、¥、￥、数字+元"。"留言、私信"不拦。
   - **数字人用户文案例外**：`videoType=digital_human`，且句子拼接后去掉空白等于 `context.userScript` 去掉空白时，这些句子上的 R4、R10 和 G1–G7 只记 warning。warning 保留与 error 相同的 `code`，并带 `userScript:true`，供 B5b 按 code 决定哪些对用户文案也要硬拦。原因：文案属于用户，硬性上限由 B5b 负责。导演自己写的字段仍记 error。

4. **`desktop/src/main/video-director-compiler.cjs`**
   - 入口：`compileDirectorPlan(plan, { extraRequired = [] } = {})`，返回 `{ segments:[{ index, id, seconds, startSecond, endSecond, audioPolicy, prompt, promptChars, subtitle }], warnings }`。
     - `extraRequired` 是调用方给的必保留句（例如 B5a 的 `TITLE_SAFE_AREA`，由 B1c/B5b 传入），放在"约束"之前，计入 500 字预算，不参与删减。
     - `subtitle` 是本段句子原文的拼接；
     - `promptChars` 按 `Array.from(prompt).length` 计算。
   - 另导出 `hashPlan(director, segments)`：对 `{ director, segments:[{ id, seconds, startSecond, endSecond, audioPolicy, prompt }] }` 的规范化 JSON（键排序）计算 sha256，不含 warnings 和时间戳。信封的 `planHash` 就是它，供 B1b 做确认。
   - **提示词分节顺序**：
     1. 参考图用途：`@图片N是…，保持{keep}`；
     2. 场景；
     3. 人物（presence≠none 时写）；
     4. 开场状态；
     5. 镜头行 `镜头N（约X秒）：{景别}{机位}{运镜}，{subject}{action}。`；
     6. 收尾状态；
     7. 光影，含地面反光；
     8. 色彩：写明全片同一调色，产品颜色与参考图一致；
     9. 声音；
     10. 约束。
   - **声音一节**：
     - `ambient_only` 固定写"声音：只有与画面同步的环境声和设备运行声，无人声、无旁白、无音乐。"，**不得出现任何句子原文**；
     - `silent` 固定写"声音：无。"（B2 对该段传 `generate_audio:false`），同样不得出现句子原文；
     - `native_dialogue` 写"本人面对镜头说出以下完整文案，口型与话语同步，不添加额外台词："，后接 `JSON.stringify(本段文案)`。
   - **不写进提示词的内容**：
     - 画幅、分辨率、时长。这些走接口参数。
     - "仅当/只有事实/是否符合"这类元指令。
   - **必保留项**：
     - 参考图行、镜头行、声音一节、`extraRequired`；
     - 数字人台词；
     - 两段时的开场和收尾状态；
     - 必备约束：
       - 所有片型：不改变产品造型、颜色、标识和零件；无字幕、水印、文字；
       - 无人且非机器人时：设备不得无人自行移动；
       - 有操作员时：不出现可辨认的真实人物；
       - 数字人：不换脸、不改变年龄和肤色。
   - **长度控制**：
     - 超过 500 字时，按固定顺序删减可选项：palette → productScale → gestures → style → 非必备约束 → 截短 sceneArt。
     - 删到只剩必保留项仍超 500 字时：
       - 产品片抛出 `director_prompt_too_long`；
       - 数字人只记 warning `prompt_over_500`。原因：B5b 之前允许 160 字文案，而按每秒 4.5 字，15 秒只该有约 67 字。

5. **`video-directors.cjs`：`planVideo` 改为输出 v3 的保守模板**（即回退路径，签名改为 `planVideo(input, { fallbackReason, productProfile } = {})`）
   - **输入**：另外接受 B1b 新增的 `operatorAllowed`、`equipmentType` 两个字段，但模板不据此改变片型。`productProfile` 可由 B1b 传入（须通过 `validateProductProfile`，否则用全 `unknown`、`source:"none"`）。
   - **片型**：始终是 `product_static` + `presence=none`，所有镜头 `static`，不安排 operation 或 result 意图，`partsShown` 为空。演示目标选"作业"或"清洁前后"时，记 warning `template_static_only`。操作员只在 B1b 的大模型路径生效。
   - **分段**：30 秒为 [0,30]；45 秒为 [0,23]、[23,45]；60 秒为 [0,30]、[30,60]。每段 4 个镜头，段长除以 4 取整，余数从末镜往前每镜加 1 秒（30 秒为 7/7/8/8，23 秒为 5/6/6/6，22 秒为 5/5/6/6），都落在 5–8 秒；首段以"场景"开头，末段以"收束"结尾，中间用"外观、细节"轮换（取自原来的四个节拍）。接缝类型为 `scale_cut`，前后景别不同。
   - **事实**：用户资料按"。；;！？"和换行拆成 F1…，`kind=spec`，`source=user_attested`。超过 120 字的单句丢弃并给 warning，**不在句中截断**。
   - **句子**：依次为场景介绍、外观、事实原句、结尾引导，按段分配，每段至少 1 句。事实原句放不下、或单句过不了守卫（如含"零残留、杀菌、价格"），就整句不进 `sentences`，记 warning `fact_sentence_dropped`，但仍留在 `evidence.facts`。每句以"。？！"结尾，不写"已确认"。
   - **`expression`**：只用于 `concept.keyMessage`，截到 60 字以内的句界，并且要过守卫；过不了就改用固定句，记 warning `expression_dropped`。不进视频提示词。
   - **返回的信封字段**，现有服务和页面不用改就能继续工作：

     ```
     { version:"3", format:"director.v3", plannerSource, fallbackReason, skillVersion, skillHash, planHash, warnings,
       director:<director.v3>, segments:<compile 输出>,
       shots: segments 映射为 {index, seconds, startSecond, endSecond, title:"第N段", narration:subtitle, prompt}  // 兼容别名，B2 改用 segments 后删除
       scene, surface, dirt, goal, evidenceStatus, sourceResolution:"480p", outputSize, enhancement,
       sendText（沿用现有产品文案）, estimatedVideoUsd, estimateNote }
     ```

   - 新增 `planDigitalHumanTemplate(input, { extraRequired } = {})`（供 B1c 回退、B5b 使用），输入字段为 `sceneId`、`voiceStyle`、`durationSeconds`、`script`、`productProfile?`：
     - 1 段，`native_dialogue`；
     - 句子按原文拆分，不改写（因此走上面的"用户文案例外"）；
     - `concept.hook`、`concept.cta` 用 references 里的固定句，只作建议展示，不进台词；
     - 人物和肤色取自 `humanDirection`（`rules.cjs:19` character、`:21` visual、`:23` activity），只读引用；`scene`、`voice` 对象从 `digital-human-provider.cjs` 的 `SCENES`、`VOICES` 只读引入；
     - `interaction`：`sizeClass` 为 handheld 或 portable 时用 `hold_small`，否则用 `stand_beside_point`。
   - 删除 v2 的 15 秒逻辑、`productShots`、"单镜头15秒"和旁白进提示词的写法。选项表（SCENES、SURFACES、DIRT、GOALS）和单价常量保留。

6. **自检**
   - 新增 `desktop/src/main/video-director.self_check.cjs`，并在 `scripts/run-self-checks.cjs` 中注册（放串行组）。
   - `product-video.self_check.cjs` 只改依赖 v2 形状的断言：
     - HEAD 的 :28（`assembleVideo` 收到两镜）；
     - :38（`shots.length === 2`）；
     - :49-50（两次提交、两个 `480p`）；
     - :52（refresh 后仍是两次提交）。
     
     改为 30 秒 1 段、提交 1 次、请求体 `duration=30`（假 provider 增加记录 `duration`）。:55 的 `00:00:15,000` 这时仍成立（导出按每 15 秒写死，:259-260），留给 B2 改。B2 之后还会整体改写这些断言。

## 允许改动

- `desktop/src/main/skills/cleaning-video-director/`：`SKILL.md`、`references/*.md`、`schema.cjs`、`index.cjs`。不含 `rules.cjs`。
- `desktop/src/main/video-director-guard.cjs`、`video-director-compiler.cjs`、`video-director.self_check.cjs`（均为新增）
- `desktop/src/main/video-directors.cjs`
- `desktop/src/main/product-video.self_check.cjs`：仅限第 6 步所列断言
- `desktop/scripts/run-self-checks.cjs`：仅限注册

## 禁止

- 不改 `product-video-service.cjs`、`-ipc`、`-preload`、`ProductVideoPage.tsx`、`digital-human-*`、`rules.cjs`、`main.cjs`，也不改网关和内容引擎。
- 不调用任何大模型或付费接口，不新增依赖，`package.json` 不变。
- 守卫只能比 v2 更严：
  - 不把事实判断写成给视频模型的指令；
  - 模板不得生成作业镜头或清洁前后镜头。

## 验收（新增断言在当前 HEAD 上必须失败）

`video-director.self_check.cjs` 至少覆盖：

1. **结构**：缺必填项、枚举错误、多余字段、`schemaVersion` 错误，都要报错并带 path。
2. **分段**：
   - 30 秒 1 段，45 秒 2 段，60 秒 2 段（各 30 秒）；
   - 以下都报错：60 秒拆成 4 段 × 15 秒；段不连续；某段 31 秒；镜头总和不等于段长；
   - 以下也报错：一句话跨两段；`scale_cut` 前后景别相同。
3. **语速**：30 秒的产品段有 136 个可读字时报 error（上限 135），135 字通过；"一、二。"计为 2 字。15 秒数字人段 68 字：如果等于 `userScript`，只报 warning；如果是导演改写的，报 error。
4. **声音、人物与参考图**：
   - 产品片出现 `native_dialogue` 报错；
   - `presence=none` 但 `skin` 非空报错；
   - `operatorAllowed=false` 但片型是 `product_operator` 报错；
   - 数字人不是 `authorized_self` 报错；
   - 产品片带 `@图片2 scene_keyframe` 报错；数字人槽位顺序与 R8 不同报错。
   - 数字人导演改写的台词：首句不等于 hook、末句不等于 cta、hook 14 字，都报错；同样内容等于 `userScript` 时只报 warning，且 warning 的 `code` 与 error 相同、带 `userScript:true`。
5. **物理合理性**：
   - 手推式、无人、operating：拒绝；
   - 机器人、无人、operating 且引用 operation 事实：通过；
   - 驾驶式配 `hold_small`：拒绝；
   - operating 但没有引用 operation 事实：拒绝；
   - result 意图但没有 result 事实：拒绝。
6. **事实守卫**：
   - "每小时3000平方米"：没有对应事实时拒绝；引用了"每小时3000㎡"的事实时通过；
   - 以下任一出现即拒绝：零残留、杀菌、医院指定；
   - "一次干透"在所引用事实中没有出现时拒绝；
   - `user_attested` 事实配上"已确认"时拒绝；
   - 镜头文字出现"患者"或"调色变亮"时拒绝；
   - cta 含"13812345678""加微信""www.""限时优惠"时拒绝；"欢迎留言说说您的现场"通过；
   - "三千平方米"引用了"3000㎡"的事实时通过；
   - `negative` 里出现"不出现患者"时**不**报错。
7. **编译**：
   - 用固定的 `product_operator` 方案做快照，与期望字符串完全一致；
   - ≤500 字，含 `@图片1`，不含 `undefined`、`null`、`。。`；
   - 不含任何句子原文，包含那句固定的环境声；
   - 不含"9:16""480p""仅当"；
   - 数字人快照含 `JSON.stringify(文案)` 原样；
   - 可选项过长时被裁到 ≤500，且必保留项齐全；
   - `extraRequired` 传入的句子原样出现，且计入 500 字；
   - `silent` 段的声音一节是固定句，不含句子原文；
   - 只剩必保留项仍超 500 字时，产品片抛错。
8. **模板全组合**，共 3 时长 × 5 场景 × 6 地面 × 5 污渍 × 3 目标 × 资料（空 / 400 字样例 / 含"零残留、杀菌、售价3万元"的样例）× 操作员开关 × 设备类型（auto 及 B1b 的 4 个选项）：
   - `reviewPlan` 零 error，每段 ≤500 字，无"。。"；
   - 每句以"。？！"结尾，不含"已确认"；违规资料句不进 `sentences`，并有 `fact_sentence_dropped`；
   - `operatorAllowed=true` 时仍是 `product_static`、`presence=none`；
   - 30 秒只有 1 段，镜头秒数都在 5–8 之间。
   
   数字人模板（3 场景 × 3 声音 × 10–15 秒 × 文案 ≤67 字 / 160 字）零 error；≤67 字的文案编译后 ≤500 字。
9. **知识包**：
   - 同一内容 CRLF 与 LF 的 `skillHash()` 相同；改动任一 reference 后哈希变化（用临时拷贝测试）；
   - `promptContext('product')` 和 `promptContext('digital_human')` 都非空、≤6000 字，并含 11 项字段名。
10. **命令**：
    - `node src/main/video-director.self_check.cjs` 在 HEAD 上失败（模块不存在），本分支通过；
    - `node src/main/product-video.self_check.cjs` 通过，且 30 秒只提交 1 次；
    - `npm.cmd run check:self` 通过。

## 需用户本人验收

- 过目 `SKILL.md` 和 `references/` 的行业说法：场景光线、设备操作方式、禁用词和数字人开头结尾的口径。这是产品方维护的知识，Codex 只按本卡落地。
- 本卡不涉及真实调用和发布。B3a、B3b 合并前不要发布产品视频（见上文"发布约束"）。
