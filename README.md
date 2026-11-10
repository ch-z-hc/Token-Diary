# Token-Diary

把不同工具、不同电脑上的 AI 使用记录放到一起。今天用了多少 token，最近在忙什么，都可以回来翻一翻。

![Token-Diary 年度用量，模拟数据](docs/home-full-year.png)

## 用量

- 年度热力墙显示每天的 token 用量，点击日期查看当天记录。
- 按日、周、月、年或全部历史查看，也能按工具、设备和模型拆分。
- 汇总多台电脑上的记录，设备离线时仍能查看上次采集的结果。
- 导入 ChatGPT 导出文件，查看消息统计和可见文本的 token 估算。估算与实测用量分开显示。

支持 Codex、Claude Code、Pi、Oh My Pi、OpenCode、Zcode、CC Switch，以及 Qoder Work 中已保存的用量记录。ChatGPT 通过导出文件导入，新聊天需要重新导入。

## 回顾

开启 Review 后，可以按日、周、月、年翻看对话中的任务、进展和待办，也能手动整理一份总回顾。

![Token-Diary 每日用量与回顾，模拟数据](docs/daily.png)

记录保存在自己的设备上。默认只统计用量；对话摘录和 Review 需要自行开启。生成回顾会使用所选模型服务，浏览记录不会调用模型。

## 开始使用

[使用指南](docs/guide.md)里有安装步骤和演示数据。可以先看看面板，再接入自己的记录和其他设备。

[统计口径与导出](docs/data.md) · [Review 设置](docs/reviews.md) · [MIT License](LICENSE)
