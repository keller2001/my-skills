#!/usr/bin/env python3
"""Create a writing task package from bundled templates without overwriting files."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


TEMPLATE_NAMES = (
    "task-card.md",
    "fact-ledger.md",
    "claims-and-sources.md",
    "outline.md",
    "image-plan.md",
    "review-report.md",
    "delivery-card.md",
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="从 Skill 内置模板建立文章任务包；遇到同名文件时整体停止。"
    )
    parser.add_argument("output_dir", help="任务包输出目录")
    args = parser.parse_args()

    skill_root = Path(__file__).resolve().parents[1]
    template_dir = skill_root / "assets" / "article-task-package"
    output_dir = Path(args.output_dir).expanduser().resolve()

    missing_templates = [name for name in TEMPLATE_NAMES if not (template_dir / name).is_file()]
    if missing_templates:
        print("模板缺失：" + "、".join(missing_templates), file=sys.stderr)
        return 2

    conflicts = [name for name in TEMPLATE_NAMES if (output_dir / name).exists()]
    if conflicts:
        print("为避免覆盖，任务包未创建；以下文件已存在：" + "、".join(conflicts), file=sys.stderr)
        return 3

    template_contents = {
        name: (template_dir / name).read_bytes() for name in TEMPLATE_NAMES
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    created: list[tuple[Path, tuple[int, int]]] = []
    try:
        for name in TEMPLATE_NAMES:
            target = output_dir / name
            with target.open("xb") as stream:
                file_stat = os.fstat(stream.fileno())
                created.append((target, (file_stat.st_dev, file_stat.st_ino)))
                stream.write(template_contents[name])
    except (OSError, KeyboardInterrupt) as exc:
        for target, expected_identity in created:
            try:
                current_stat = target.stat()
                current_identity = (current_stat.st_dev, current_stat.st_ino)
                if current_identity == expected_identity:
                    target.unlink()
            except (FileNotFoundError, OSError):
                pass
        if isinstance(exc, KeyboardInterrupt):
            print("任务包创建被中断，已回滚本次新文件。", file=sys.stderr)
            return 130
        print(f"任务包创建失败，已回滚本次新文件：{exc}", file=sys.stderr)
        return 4

    print(f"已创建文章任务包：{output_dir}")
    print(f"文件数：{len(TEMPLATE_NAMES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
