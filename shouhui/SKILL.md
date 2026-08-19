---
name: shouhui
description: Create polished Simplified Chinese hand-drawn knowledge cards from topics, notes, steps, or source material. Use when the user asks for a 知识卡片, 手绘卡片, 教程信息图, 学习笔记图, Chinese educational infographic, or a visually consistent card series. Internally plan, verify uncertain facts, review the card plan, generate the raster image, inspect the render, and correct failures before delivery.
---

# Shouhui

> **版本：2026-08-19 14:35（Asia/Shanghai）** ｜**变更：增加小昕的跨主题互动与动态表情规则，并明确面屏始终无嘴。**

## Goal

Turn a topic, note, procedure, or source into one or more finished Simplified Chinese hand-drawn knowledge cards.

- Give each card one core proposition.
- Let the content determine the layout; do not force a fixed number of modules.
- Keep the result professional, approachable, concise, and readable on a phone.
- Deliver the finished image rather than an intermediate card plan.

## Load Resources

Before planning the image:

1. Read [`references/style-guide.md`](references/style-guide.md).
2. Inspect the images under `assets/style-examples/` and select only one or two that best match the intended information structure.
3. Use `assets/mascot/xiaoxin-character-turnaround.png` as the identity reference when Xiaoxin appears.

Treat the card images as style references, not templates. Do not copy their wording, step numbers, watermark, or exact layout.

## Understand and Verify

1. Treat user-provided material as the primary source of truth. Preserve its meaning and do not invent unsupported claims.
2. If the user supplies only a topic, add the minimum knowledge needed to make the card useful.
3. Verify current, uncertain, niche, medical, legal, financial, or otherwise high-stakes claims with authoritative sources before planning the card.
4. Keep research citations out of the graphic unless the user requests them. Follow higher-level citation requirements outside the graphic when applicable.
5. Preserve filenames, commands, product names, abbreviations, and other technical terms exactly.

## Plan and Review Silently

Create an internal card brief containing:

- the audience and reader question;
- the one-sentence takeaway;
- the page count and split points;
- the exact Simplified Chinese copy;
- the reading order and information hierarchy;
- the visual metaphor, icons, arrows, and notes;
- Xiaoxin's knowledge type, role, interaction verb, gaze and expression, outfit or props, and position;
- the chosen style references and output ratio.

Derive Xiaoxin's performance from the current topic rather than inheriting the setting, costume, or action from a previous card. Xiaoxin should normally perform an action that helps explain the knowledge, such as connecting, disassembling, measuring, comparing, blocking, investigating, carrying, or operating a model. Use a quiet corner cameo only when no meaningful interaction fits. Do not default to standing, waving, holding a sign, or pointing at text without a content-based reason.

Review the brief before generating. Check factual accuracy, completeness, text length, hierarchy, mobile readability, style consistency, and whether every visual element helps explain the content. Also check that Xiaoxin's action, gaze, expression, clothing, props, and placement follow from the topic and do not repeat a pose mechanically. Revise the brief silently until it passes. Do not show the brief unless the user explicitly asks for it.

Split the material into multiple cards when one page would require cramped text, tiny type, unclear hierarchy, or more than one core proposition.

## Generate and Inspect

1. Generate a complete raster card with the available image-generation tool. Use the `infographic-diagram` or `scientific-educational` intent as appropriate.
2. Default to a vertical 3:4 composition. Obey an explicit user ratio or orientation instead.
3. Pass the chosen local style image or images as style references and the Xiaoxin turnaround as the character-identity reference. Label each image role clearly in the prompt.
4. Quote all required card text verbatim in the prompt. Require accurate Simplified Chinese and exact spelling for technical terms.
5. Render Xiaoxin in the card's hand-drawn educational illustration style while preserving the identity traits defined in the style guide.
6. Save project-bound final images in the active workspace rather than leaving them only in a generated-image cache.

After every generation, inspect the rendered image. Compare it with the approved internal brief and check:

- Chinese characters, punctuation, numbers, and English terms;
- missing, duplicated, or altered information;
- clipping, crowding, weak contrast, and broken reading order;
- unwanted watermarks, source branding, copied text, or copied composition;
- malformed icons, hands, arrows, folders, or other teaching objects;
- whether Xiaoxin's action directly supports the core proposition, the gaze follows the operated or observed object, and the body has a clear direction, weight, and result;
- whether Xiaoxin's clothing, props, expression, and placement come from the current topic without obstructing text or weakening the reading order;
- whether the face screen remains mouthless and the intended emotion is conveyed through eye shape, gaze, head angle, and body language;
- Xiaoxin's face screen, cyan accents, ear modules, the two upward cyan ear rods, dark joints, chest core, proportions, and role as a supporting element;
- within a series, or when recent cards are available for comparison, whether the pose, gesture, placement, and prop combination have been reused mechanically;
- consistency with the reference palette, paper texture, hand-drawn line quality, and adult-friendly tone.

If the image fails, make one targeted correction and inspect again. Perform at most two correction rounds. If a blocking defect remains, explain the exact limitation instead of claiming success.

## Deliver

- Show only the final image or final card series; omit the internal plan and review notes.
- Keep a multi-card series consistent in palette, title treatment, icon semantics, spacing, and Xiaoxin identity while varying layout according to content.
- Do not add article writing, social-media captions, publishing, or unrelated layout work unless the user explicitly requests a separate task.
- Report the saved workspace path for every final image.
