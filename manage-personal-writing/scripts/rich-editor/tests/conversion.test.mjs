import test from "node:test";
import assert from "node:assert/strict";
import { editorSchema as schema, parseMarkdown, serializeMarkdown, assertRoundTrip, documentFromJson, sameDocument } from "../validator.bundle.mjs";

function richParagraph(align, label) {
  return schema.nodes.paragraph.create({ align }, [
    schema.text(`${label}：`),
    schema.text("加粗", [schema.marks.strong.create()]),
    schema.text("与"),
    schema.text("链接", [schema.marks.link.create({ href: "https://example.com", title: null })]),
  ]);
}

test("支持节点、容器、两级列表和对齐的 Markdown 往返相等", () => {
  const nestedBullet = schema.nodes.bullet_list.create(null, [
    schema.nodes.list_item.create(null, [richParagraph("right", "二级无序")]),
  ]);
  const nestedOrdered = schema.nodes.ordered_list.create({ order: 3 }, [
    schema.nodes.list_item.create(null, [richParagraph("center", "二级有序")]),
  ]);
  const bullet = schema.nodes.bullet_list.create(null, [
    schema.nodes.list_item.create(null, [richParagraph("center", "一级无序"), nestedBullet]),
  ]);
  const ordered = schema.nodes.ordered_list.create({ order: 2 }, [
    schema.nodes.list_item.create(null, [richParagraph("right", "一级有序"), nestedOrdered]),
  ]);
  const doc = schema.nodes.doc.create(null, [
    richParagraph("left", "左对齐"), richParagraph("center", "居中"), richParagraph("right", "右对齐"),
    schema.nodes.heading.create({ level: 2, align: "center" }, schema.text("标题")),
    schema.nodes.blockquote.create(null, [richParagraph("right", "引用")]), bullet, ordered,
    schema.nodes.horizontal_rule.create(),
    schema.nodes.image.create({ src: "images/test.png", alt: "图片", title: null, align: "center", uploadId: null }),
  ]);
  const markdown = assertRoundTrip(doc);
  const parsed = parseMarkdown(markdown);
  assert.equal(parsed.readOnly, false, parsed.diagnostics.join(" "));
  assert.ok(parsed.doc.eq(doc));
  assert.match(markdown, /<!--mpw:align=center-->/);
  assert.match(markdown, /> <!--mpw:align=right-->/);
});

test("开启后未编辑时解析结果可重现同一文档树", () => {
  const markdown = "# 标题\n\n段落 **加粗** [链接](mailto:test@example.com)\n";
  const parsed = parseMarkdown(markdown);
  assert.equal(parsed.readOnly, false);
  assert.ok(parseMarkdown(serializeMarkdown(parsed.doc)).doc.eq(parsed.doc));
});

test("顶层空段落按 Markdown 可表达语义折叠后仍可保存", () => {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(),
    schema.nodes.paragraph.create(null, schema.text("正文")),
    schema.nodes.paragraph.create(),
  ]);
  const markdown = assertRoundTrip(doc);
  assert.equal(markdown.trim(), "正文");
  assert.equal(sameDocument(doc, parseMarkdown(markdown).doc), true);
});

test("images 下中文和空格文件名可安全往返", () => {
  const markdown = "![中文](images/%E4%B8%AD%E6%96%87%E5%9B%BE.png)\n\n![空格](images/space%20name.png)\n";
  const parsed = parseMarkdown(markdown);
  assert.equal(parsed.readOnly, false, parsed.diagnostics.join(" "));
  assert.equal(parsed.doc.child(0).attrs.src, "images/中文图.png");
  assert.equal(parsed.doc.child(1).attrs.src, "images/space name.png");
  const serialized = assertRoundTrip(parsed.doc);
  assert.match(serialized, /images\/%E4%B8%AD%E6%96%87%E5%9B%BE\.png/);
  assert.match(serialized, /images\/space%20name\.png/);
  assert.equal(sameDocument(parsed.doc, parseMarkdown(serialized).doc), true);
});

for (const [label, markdown] of [
  ["未知对齐", "<!--mpw:align=wide-->\n\n段落\n"],
  ["孤立对齐", "段落\n\n<!--mpw:align=center-->\n"],
  ["原始 HTML", "<section>内容</section>\n"],
  ["斜体", "*斜体*\n"],
  ["行内代码", "`代码`\n"],
  ["行内图片", "文字 ![图](images/a.png) 文字\n"],
  ["非安全链接", "[x](javascript:alert(1))\n"],
  ["编码后越界图片", "![x](images/%2E%2E%5Coutside.png)\n"],
  ["图片子目录", "![x](images/sub/outside.png)\n"],
]) {
  test(`不支持结构进入只读诊断：${label}`, () => {
    const result = parseMarkdown(markdown);
    assert.equal(result.readOnly, true);
    assert.ok(result.diagnostics.length > 0);
  });
}

test("服务端拒绝待上传图片和越界图片路径", () => {
  const badUpload = { type: "doc", content: [{ type: "image", attrs: { src: "images/uploading.png", alt: null, title: null, align: "left", uploadId: "pending" } }] };
  assert.throws(() => documentFromJson(badUpload), /上传/);
  const badPath = structuredClone(badUpload);
  badPath.content[0].attrs = { ...badPath.content[0].attrs, src: "../outside.png", uploadId: null };
  assert.throws(() => documentFromJson(badPath), /路径/);
});
