# 数据与统计

所有原始会话日志只读。每个来源扫描输出标准化 usage events，中心采集器保存 gzip 快照，再构建每日和周期 JSON。JSON / gzip 文件原子替换；POSIX 下数据目录 0700、文件 0600。Windows 权限仍受操作系统 ACL 管理。

## Token 口径

归一化后的 **total = input + output**。缓存读写属于输入，reasoning 属于输出，均不能再次加到 total。

- Codex：优先逐请求 `token_usage_record`，旧 `token_count` 按累计差值。重复计数快照忽略，首个继承计数有 last usage 时只计 last usage。现代逐请求和旧计数并存时，同时检查响应 usage、时间与累计签名，防止累计值漂移造成重复。
- Claude：input = uncached + cache read + cache creation。重复 streaming blocks 保留较完整 usage。同次响应的 message / UUID / request 别名用于与导入记录去重。
- Pi / Oh My Pi：input 加 cacheRead / cacheWrite，output 已含 reasoning。
- OpenCode：input 需加 cache read / write，output 需加 reasoning。
- Zcode：provider totals 已含缓存和推理，保持 input / output 原值。
- CC Switch：导入 session 前缀剥离后匹配 assistant UUID，避免和原会话重复。

跨设备以响应 ID / 别名去重。不能无条件推断两个没有稳定标识的记录是同一次请求；格式变化或缺少 ID 时可能存在不可避免的误差。设备维度将去重后的事件归给来源配置顺序中首次出现的设备，并不证明实际发起设备。

日期以配置的 IANA 时区零点划分。会话数按 Agent + session ID 去重；周期调用数和 token 加总每日去重结果。缺失日志不视作零，也不从上下文长度、账户配额或文字长度推算 token。

空行、已确认截断且不含 usage 标记的 task_started 元数据静默跳过。损坏用量记录、未知坏行和真实连接失败仍计入状态，便于识别缺失。

## 文件布局

```text
<dataDir>/
  <source-id>.json.gz       标准化来源快照
  sources.json             连接状态和上次成功时间
  index.json               每日用量索引
  days/YYYY-MM-DD.json     日统计与可选摘录
  periods/week_*.json      周期统计（文件名兼容 Windows）
  period-index.json
  summaries.json           日回顾
  period-summaries.json    长周期回顾
  generation-usage.json    Review 返回的 usage
  review-runs.json         调用尝试、状态和时间，不含输入
  heartbeat.json
```

运行时锁与 jobs 只作协调/临时输出。来源端 `.cache/ai-log/` 按时区和摘录开关分开缓存，避免把此前捕获的文字复用于 stats-only 扫描。

## 快照导入

配置来源 `{"id":"imported","type":"file","path":"/path/to/snapshot.json.gz"}`，支持 JSON 或 gzip JSON。快照为：

```json
{
  "version": 1,
  "timezone": "Asia/Shanghai",
  "events": [
    { "id": "response:example", "day": "2026-01-02", "agent": "Example", "session": "session-1", "model": "example-model", "input": 100, "output": 20, "cached": 50, "cacheWrite": 0, "reasoning": 5 }
  ],
  "sessions": [],
  "inventory": [],
  "errors": []
}
```

来源失败保留上次快照，不用空值覆盖。快照时区与配置不一致时拒绝导入；不要只改 timezone 标签，需要重新按事件原始时间归日。

## 备份与 Diary

备份配置与整个 dataDir 即可恢复。导出默认包括每日用量和已生成日回顾，不含原始会话摘录。JSON 适合程序对接；Markdown 可手动导入日记。项目不直接修改或提交任何 Diary 仓库。

移除数据源并重新采集后，页面和导出只展示当前索引中的日期与周期；离线但仍保留在配置中的数据源继续使用最近成功快照。移除来源不会自动擦除磁盘上的历史缓存，已有回顾也不会因关闭生成开关而被删除。
