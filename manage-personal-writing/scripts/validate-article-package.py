#!/usr/bin/env python3
"""Validate writing package completeness and deterministic state consistency."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


STAGE_FILES = {
    "planning": (
        "task-card.md",
        "fact-ledger.md",
        "claims-and-sources.md",
        "outline.md",
        "image-plan.md",
    ),
    "candidate": (
        "task-card.md",
        "fact-ledger.md",
        "claims-and-sources.md",
        "outline.md",
        "image-plan.md",
        "review-report.md",
    ),
    "final": (
        "task-card.md",
        "fact-ledger.md",
        "claims-and-sources.md",
        "outline.md",
        "image-plan.md",
        "review-report.md",
        "delivery-card.md",
    ),
}

REQUIRED_TASK_FIELDS = (
    "任务名称",
    "目标读者",
    "发布平台",
    "账号",
    "文章问题",
    "核心判断",
    "可用材料",
    "必须核实",
    "禁止披露",
    "大纲批准",
    "用户定稿",
    "交付状态",
    "发布权限",
)

ALLOWED_STATES = (
    "大纲待用户审核",
    "大纲已批准",
    "正文初稿",
    "AI 审过的候选稿",
    "用户确认定稿",
    "带图稿",
    "预览",
    "草稿箱",
    "已发布",
)

POST_OUTLINE_STATES = set(ALLOWED_STATES[1:])
PRE_FINAL_STATES = set(ALLOWED_STATES[:4])
POST_FINAL_STATES = {"用户确认定稿", "带图稿", "预览", "草稿箱", "已发布"}
STAGE_MINIMUM_STATE_INDEX = {
    "planning": 0,
    "candidate": 3,
    "final": 4,
}


def parse_list_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    pattern = re.compile(r"^-\s*([^：]+)：\s*`?([^`\r\n]+)`?\s*$", re.MULTILINE)
    for match in pattern.finditer(text):
        fields[match.group(1).strip()] = match.group(2).strip()
    return fields


def main() -> int:
    parser = argparse.ArgumentParser(
        description="检查文章任务包的文件、待填写标记和状态冲突；不判断内容质量。"
    )
    parser.add_argument("task_dir", help="文章任务包目录")
    parser.add_argument("--stage", choices=tuple(STAGE_FILES), default="planning")
    args = parser.parse_args()

    task_dir = Path(args.task_dir).expanduser().resolve()
    errors: list[str] = []
    required_files = STAGE_FILES[args.stage]

    if not task_dir.is_dir():
        print(f"任务目录不存在：{task_dir}", file=sys.stderr)
        return 2

    contents: dict[str, str] = {}
    for name in required_files:
        path = task_dir / name
        if not path.is_file():
            errors.append(f"缺少文件：{name}")
            continue
        text = path.read_text(encoding="utf-8")
        contents[name] = text
        if not text.strip():
            errors.append(f"空文件：{name}")
        if "【待填写】" in text:
            errors.append(f"仍有待填写标记：{name}")

    task_text = contents.get("task-card.md")
    if task_text is not None:
        fields = parse_list_fields(task_text)
        for field in REQUIRED_TASK_FIELDS:
            if field not in fields or not fields[field].strip():
                errors.append(f"任务卡缺少字段：{field}")

        state = fields.get("交付状态", "")
        outline_approval = fields.get("大纲批准", "")
        final_confirmation = fields.get("用户定稿", "")
        publish_permission = fields.get("发布权限", "")

        if state and state not in ALLOWED_STATES:
            errors.append(f"未知交付状态：{state}")
        elif state and ALLOWED_STATES.index(state) < STAGE_MINIMUM_STATE_INDEX[args.stage]:
            errors.append(f"阶段冲突：{args.stage} 阶段不能使用较早的交付状态“{state}”")
        if outline_approval not in {"未批准", "已批准"}:
            errors.append(f"未知大纲批准状态：{outline_approval}")
        if final_confirmation not in {"未确认", "已确认"}:
            errors.append(f"未知用户定稿状态：{final_confirmation}")
        if publish_permission not in {"未授权", "仅预览", "允许推草稿箱", "允许发布"}:
            errors.append(f"未知发布权限：{publish_permission}")
        if state in POST_OUTLINE_STATES and outline_approval != "已批准":
            errors.append("状态冲突：大纲未批准，但交付状态已经越过大纲门禁")
        if state == "大纲待用户审核" and outline_approval != "未批准":
            errors.append("状态冲突：大纲已批准，但交付状态仍是大纲待用户审核")
        if state in PRE_FINAL_STATES and final_confirmation != "未确认":
            errors.append("状态冲突：用户已确认定稿，但交付状态仍在定稿门禁之前")
        if state in POST_FINAL_STATES and final_confirmation != "已确认":
            errors.append("状态冲突：用户未确认定稿，但交付状态已经越过定稿门禁")
        if state == "预览" and publish_permission not in {"仅预览", "允许推草稿箱", "允许发布"}:
            errors.append("状态冲突：预览状态缺少预览权限")
        if state == "草稿箱" and publish_permission not in {"允许推草稿箱", "允许发布"}:
            errors.append("状态冲突：草稿箱状态缺少推草稿箱权限")
        if state == "已发布" and publish_permission != "允许发布":
            errors.append("状态冲突：已发布状态缺少发布权限")

        outline_text = contents.get("outline.md")
        if outline_text is not None:
            outline_status = parse_list_fields(outline_text).get("状态", "")
            expected_outline_status = (
                "AI审纲通过" if state == "大纲待用户审核" else "用户已批准"
            )
            if outline_status != expected_outline_status:
                errors.append(
                    "状态冲突：outline.md 的状态应为“"
                    + expected_outline_status
                    + "”，当前为“"
                    + (outline_status or "缺失")
                    + "”"
                )

        review_text = contents.get("review-report.md")
        if review_text is not None:
            review_result = parse_list_fields(review_text).get("结论", "")
            if review_result != "通过":
                errors.append(
                    "状态冲突：候选稿或定稿阶段的 review-report.md 结论必须为“通过”"
                )

        delivery_text = contents.get("delivery-card.md")
        if delivery_text is not None:
            delivery_fields = parse_list_fields(delivery_text)
            if delivery_fields.get("当前状态", "") != state:
                errors.append("状态冲突：delivery-card.md 当前状态与任务卡不一致")
            if delivery_fields.get("发布权限", "") != publish_permission:
                errors.append("状态冲突：delivery-card.md 发布权限与任务卡不一致")

    if errors:
        print(f"文章任务包检查未通过（阶段：{args.stage}）：", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"文章任务包检查通过（阶段：{args.stage}）：{task_dir}")
    print("本结果只证明文件与状态一致，不代表事实、文章质量或人工授权已经通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
