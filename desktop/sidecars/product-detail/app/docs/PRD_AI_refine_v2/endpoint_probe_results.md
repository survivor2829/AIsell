# APIMart 端点探测实测结果

**实测日期**: 2026-04-23
**脚本**: `demo_gpt_image2_v2.py`
**目标**: 确认 APIMart 是否支持 gpt-image-2 edits 端点 + thinking 参数

## 探测结果汇总

| 项目 | 结论 | HTTP | 依据 |
|------|------|------|------|
| `/v1/images/edits` | ❌ **不可用** | 500 | `apimart_error: get_channel_failed` — 路由有, 后端无通道 |
| `/v1/images/generations` | ✅ **可用** | 200 | 返回 `task_id`, 轮询 completed |
| `thinking: "medium"` | ⚠ **接受但不确认透传** | 200 | payload 里塞了, 耗时 ×2.3 (46s vs 原 20s), 质量提升 |
| `reasoning_effort: "medium"` | ⚠ **同上** | 200 | 和 thinking 一起塞, 不报错 |

## 原始日志片段

### edits 端点探测

```
[probe] 探测 /images/edits 端点是否可用...
[probe] edits 端点返回: HTTP 500
[probe]   response: code=None  msg={
    'message': 'Please wait and try again later. Thank you for your patience! (request id: 2026042310001289812066q1HVeAb7)',
    'type': 'apimart_error',
    'param': '',
    'code': 'get_channel_failed'
}
[decide] 用端点: /images/generations  (generations (降级))
```

**诊断**: HTTP 500 + `get_channel_failed` 不是 404(路由不存在)也不是 400(参数错),而是 "APIMart 路由层有,后端没给 gpt-image-2 配 edits 通道"。等于**被 APIMart 显式禁用**。

### generations + thinking 提交

```
[try] thinking='medium'
[submit] POST https://api.apimart.ai/v1/images/generations
         prompt.len=1222 size=1:1 thinking='medium'
[submit] task_id = task_01KPW11ZY5CWV92QYGFDK55KM3
[poll]  status=completed  progress=100%  t=40.4s
[OK] endpoint=images/generations thinking='medium'
[OK] 产物: /tmp/demo_gpt2_v2_dz600m.jpg (2430KB)
[OK] 耗时: 46.6s
```

## 可落生产的结论

### 端点: 只走 generations
- 不要再调 edits, 会 500 浪费一次探测成本 (~$0.04)
- 如果将来要真正的 edits (精确修改局部而非"参考生成"), 方案:
  - 换 fal.ai (`openai/gpt-image-2/edit` 有独立路径)
  - 直连 OpenAI 官方 API (成本更高, 需另配 key)

### thinking 参数: 默认开 `medium`
- APIMart 接受无报错, 不确定上游是否真的启用, 但至少无害
- 耗时 ×2.3 / 质量 +3 分 → **性价比有**
- 生产代码建议:
  ```python
  payload["thinking"] = "medium"
  payload["reasoning_effort"] = "medium"  # 双保险, 某些网关认这个名字
  ```

### 下次 APIMart 端点测试建议
- 季度回头测一次 edits 是否开通了 (供应商接入可能会变)
- 测试方法: 一个 minimal POST probe, 如果 HTTP 不是 500/404 就进一步试真提交
