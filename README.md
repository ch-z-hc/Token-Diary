# Token-Diary

AI 用量统计与会话回顾，支持多工具、多设备汇总。

![年度用量，模拟数据](docs/home-full-year.png)

## 功能

- 年度用量热力图，点击日期查看当天记录。
- 按日、周、月、年统计，支持工具、设备、模型分类。
- 汇总多台电脑的记录，离线设备保留上次采集结果。
- 导入 ChatGPT 聊天导出文件，统计消息数量，单独显示可见文本的 token 估算。
- 生成日、周、月、年回顾，整理会话中的任务、进展和待办。
- 导出用量与回顾。

支持 Codex、Claude Code、Pi、Oh My Pi、OpenCode、Zcode、CC Switch，以及 Qoder Work 中已保存的用量记录。ChatGPT 聊天需手动导入。

![每日用量与回顾，模拟数据](docs/daily.png)

默认只采集用量。对话摘录和 Review 需手动开启，生成回顾会使用所选模型服务。

## 使用

[安装与演示](docs/guide.md) · [统计口径与导出](docs/data.md) · [Review 设置](docs/reviews.md)

[MIT License](LICENSE)
