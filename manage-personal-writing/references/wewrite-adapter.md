# WeWrite CLI 可选适配器

WeWrite CLI 是可选执行后端，不是个人写作规则或个人风格的来源。直接调用 `wewrite` 命令，不依赖、激活或读取任何全局 `wewrite*` Skill。

## 何时使用

当任务需要独立 run、来源记录、质量提示、预览或公众号草稿箱能力时使用。简单讨论、人工审纲前的方案整理或局部改写无需为了形式启动 WeWrite。

## 入口检查

先从命令搜索路径定位 `wewrite`，再运行：

```powershell
wewrite --version
wewrite home
wewrite diagnose --json
```

记录 CLI 版本、状态目录和降级 flags。命令缺失或诊断失败时使用本 Skill 的独立流程，不修改、复制或重装 WeWrite。

## 与两个人工门禁对齐

1. 需要任务状态时，使用 `wewrite run start` 创建一次 run；继续已有任务时先 `wewrite run list`，确认唯一对象后再 `wewrite run resume <run_id>`。
2. 人工审纲前，只把任务卡、主张、来源和大纲写入当前 run；用 `wewrite sources` 记录外部来源。不得在门禁一之前调用 `wewrite llm-write`。
3. 用户批准大纲后，才允许在同一 run 中形成正文；CLI 的 `score` 和 `content-eval` 只提供检查线索，不能代替本 Skill 的四层质检和独立审稿。
4. AI 审稿通过后，把状态保持为“候选稿待用户确认”。用户明确确认定稿后，才执行 `wewrite run finish`。
5. `image-gen`、`preview` 和 `publish` 是正文后的独立命令。预览不等于草稿箱，草稿箱不等于已发布；调用 `publish` 前必须已有明确的发布授权，并通过 `wewrite run permission publish allow` 记录。

具体参数以当前版本的 `wewrite <command> --help` 为准，不从已卸载的写作 Skill 复制旧命令。

## 配置关系

- `C:\Users\bmskills\.wewrite\style.yaml` 和 `playbook.md` 是 WeWrite 的补充状态配置，不是流程控制器，也不能覆盖 Fengge 主风格。
- 使用“驰昕AI共学营”时核对当前账号配置是否匹配；不匹配时不得未经授权覆盖状态文件。
- WeWrite 配置与本 Skill 或用户当前指令冲突时，以用户当前指令、本 Skill 的人工门禁和个人风格为准。

## 降级

WeWrite 缺失、版本不兼容或运行失败时，保留当前任务事实，改用本 Skill 的独立流程继续生成任务书、证据账本、大纲、候选稿和审稿报告。明确报告未使用的 CLI 能力，不把降级写成完整工具验证通过。
