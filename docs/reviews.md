# Review 机制

统计与浏览不需要模型。`captureText=true` 仅允许捕获摘录，`review.enabled=true` 才允许生成；两项都明确开启才能调用模型。

日回顾依据当日任务摘录；周 / 月只读取有效日回顾；年优先读取有效月回顾；Total 优先有效年、月，然后日回顾。父回顾的指纹包含实际子摘要、周期和模型配置。任一有任务文本的日期缺少有效摘要时，父回顾等待，不把部分材料当完整周期。统计数值变化不单独使回顾失效。

日、周、月、年都在其自然周期结束后生成，按配置时区判断；Total 排除尚未结束的当天，没有自然结束点，只能显式 `ai-log review --period total`。同一个周期在同一自然日最多生成一次，未变时不调用。为了避免历史补全突发消耗，默认每次命令最多 5 次、每天最多 20 次调用尝试。失败后延迟 30 分钟再重试。`review-runs.json` 记录尝试数，即使失败没有返回 usage 也占调用次数限制。

单次模型输入受 `maxInputChars` 限制，默认 24000 个 JavaScript 字符。超限项暂停、保持旧结果，不调用模型也不静默截断。它不是精确 token 计数；摘要可能遗漏细节，所以长周期回顾不能替代原始日志核对。未来可增加多段增量压缩；当前超限应保留明确失败状态。

生成后再次计算输入指纹，源材料改变则不能覆盖缓存。失败保留旧版。网页只读已有结果和状态；任何生成都由 CLI / watch 执行。

## 模型提供器

内置 `codex` 提供器从 PATH 或配置的命令启动已有 CLI，以 ephemeral、read-only、禁用工具与 apps 的模式生成 schema 输出。使用现有登录，不读取、复制或提交认证文件。不同 Codex CLI 版本的参数可能不同，若不兼容应报告错误，不自动放开工具或切换模型。内置参数来自最初部署使用的 CLI；真实模型调用不属于自动测试。

也可以使用 `command` 提供器：

```json
{
  "captureText": true,
  "review": {
    "enabled": true,
    "provider": "command",
    "command": "node",
    "args": ["/absolute/path/to/your-review-provider.cjs"],
    "model": "your-configured-model"
  }
}
```

命令接收一份 stdin JSON：

```json
{
  "key": "day:2026-01-02",
  "kind": "day",
  "instructions": "...journal rules...",
  "records": [{ "agent": "Example", "intent": "Build a search form" }]
}
```

stdout 只能返回一份 JSON：

```json
{
  "text": "The session discussed a search form and reported completion of validation.",
  "usage": { "input_tokens": 100, "cached_input_tokens": 20, "output_tokens": 30 }
}
```

usage 可省略，此时账本标记未知，不视为零费用。令牌字段约定 input 包含 cached，output 包含 reasoning。命令配置是受信任的本地代码执行入口，请勿使用不可信配置或把密钥放进命令行参数；凭据由提供器自身从适当的环境或凭据存储读取。

命令最多运行 10 分钟，输出最多 2 MiB。超时或收到退出信号时停止进程组；Windows 通过 taskkill 结束进程树。临时 schema / 输出在 dataDir/jobs 下，完成或失败后清理，不保存模型完整 stdout 或 stderr。

`generation-usage.json` 只记录返回结果可解析时的 usage。已消耗但未返回 usage 的调用仍可能计费，账本不能替代服务商账单。
