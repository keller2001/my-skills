import MarkdownIt from "markdown-it";
import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";

const ALIGNMENTS = new Set(["left", "center", "right"]);
const SAFE_LINK = /^(https?:|mailto:)/i;
const IMAGE_PATH = /^images\/[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}_-])?$/u;
const SENTINEL_PREFIX = "MPWALIGN_7F2C_";

function aligned(spec) {
  return {
    ...spec,
    attrs: { ...(spec.attrs || {}), align: { default: "left" } },
    parseDOM: (spec.parseDOM || []).map((rule) => ({
      ...rule,
      getAttrs(dom) {
        const inherited = typeof rule.getAttrs === "function" ? rule.getAttrs(dom) : rule.attrs || {};
        if (inherited === false) return false;
        const value = dom.getAttribute("data-align") || dom.style?.textAlign || "left";
        return { ...(inherited || {}), align: ALIGNMENTS.has(value) ? value : "left" };
      },
    })),
    toDOM(node) {
      const original = spec.toDOM(node);
      if (!Array.isArray(original)) return original;
      const attrs = typeof original[1] === "object" && !Array.isArray(original[1]) ? original[1] : {};
      const offset = attrs === original[1] ? 2 : 1;
      const nextAttrs = {
        ...attrs,
        "data-align": node.attrs.align,
        style: node.attrs.align === "left" ? undefined : `text-align:${node.attrs.align}`,
      };
      return [original[0], nextAttrs, ...original.slice(offset)];
    },
  };
}

let nodeSpecs = basicSchema.spec.nodes
  .remove("code_block")
  .remove("image")
  .remove("hard_break")
  .update("paragraph", aligned(basicSchema.spec.nodes.get("paragraph")))
  .update("heading", aligned(basicSchema.spec.nodes.get("heading")));

nodeSpecs = nodeSpecs.addToEnd("image", {
  inline: false,
  group: "block",
  draggable: true,
  selectable: true,
  attrs: {
    src: {},
    alt: { default: null },
    title: { default: null },
    align: { default: "left" },
    uploadId: { default: null },
  },
  parseDOM: [{
    tag: "img[src]",
    getAttrs(dom) {
      return {
        src: dom.getAttribute("src"),
        alt: dom.getAttribute("alt"),
        title: dom.getAttribute("title"),
        align: ALIGNMENTS.has(dom.getAttribute("data-align")) ? dom.getAttribute("data-align") : "left",
      };
    },
  }],
  toDOM(node) {
    return ["img", {
      src: node.attrs.src,
      alt: node.attrs.alt || "",
      title: node.attrs.title || undefined,
      "data-align": node.attrs.align,
      "data-upload-id": node.attrs.uploadId || undefined,
    }];
  },
});

nodeSpecs = addListNodes(nodeSpecs, "paragraph block*", "block");

export const editorSchema = new Schema({
  nodes: nodeSpecs,
  marks: basicSchema.spec.marks.remove("em").remove("code"),
});

const md = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });

function listOrder(tok) {
  return { order: Number(tok.attrGet("start")) || 1 };
}

function imageAttrs(tok) {
  let src = tok.attrGet("src");
  try { src = decodeURIComponent(src); } catch { /* 保留原值，由路径校验给出只读诊断。 */ }
  return {
    src,
    title: tok.attrGet("title") || null,
    alt: tok.content || "",
    align: "left",
    uploadId: null,
  };
}

function transformImageParagraphs(tokens) {
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const open = tokens[index];
    const inline = tokens[index + 1];
    const close = tokens[index + 2];
    if (open?.type === "paragraph_open" && inline?.type === "inline" && close?.type === "paragraph_close") {
      const visible = (inline.children || []).filter((token) => token.type !== "text" || token.content.trim() !== "");
      if (visible.length === 1 && visible[0].type === "image") {
        const image = Object.assign(Object.create(Object.getPrototypeOf(visible[0])), visible[0]);
        image.type = "image_block";
        image.level = open.level;
        image.block = true;
        result.push(image);
        index += 2;
        continue;
      }
    }
    result.push(open);
  }
  return result;
}

const tokenizer = {
  parse(text, env) {
    return transformImageParagraphs(md.parse(text, env));
  },
};

const parser = new MarkdownParser(editorSchema, tokenizer, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph", getAttrs: () => ({ align: "left" }) },
  list_item: { block: "list_item" },
  bullet_list: { block: "bullet_list" },
  ordered_list: { block: "ordered_list", getAttrs: listOrder },
  heading: { block: "heading", getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)), align: "left" }) },
  hr: { node: "horizontal_rule" },
  image_block: { node: "image", getAttrs: imageAttrs },
  strong: { mark: "strong" },
  link: { mark: "link", getAttrs: (tok) => ({ href: tok.attrGet("href"), title: tok.attrGet("title") || null }) },
});

function prepareAlignmentDirectives(markdown, diagnostics) {
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]*\]\(\s*([^\s)]+)/g)) {
    const href = match[1].replace(/^<|>$/g, "");
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) && !SAFE_LINK.test(href)) diagnostics.push(`链接协议不支持：${href}`);
  }
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const allowed = /^((?:[ \t]*(?:>\s*)*)(?:(?:[-+*]|\d+[.)])\s+)?)<!--mpw:align=(center|right)-->(?:[ \t]*)$/;
  const prepared = [];
  lines.forEach((line, index) => {
    const match = allowed.exec(line);
    if (match) {
      prepared.push(`${match[1]}${SENTINEL_PREFIX}${match[2]}`);
      const blankPrefix = match[1].replace(/(?:[-+*]|\d+[.)])\s+$/, (value) => " ".repeat(value.length)).replace(/[ \t]+$/, "");
      prepared.push(blankPrefix);
      return;
    }
    if (/<!--\s*mpw:align=/i.test(line)) diagnostics.push(`第 ${index + 1} 行的对齐指令无效。`);
    else if (/<!--[\s\S]*?-->/.test(line)) diagnostics.push(`第 ${index + 1} 行含有不支持的 HTML 注释。`);
    else if (/<\/?[A-Za-z!][^>]*>/.test(line)) diagnostics.push(`第 ${index + 1} 行含有不支持的原始 HTML。`);
    prepared.push(line);
  });
  return prepared.join("\n");
}

function scanTokens(tokens, diagnostics) {
  const unsupported = new Map([
    ["em_open", "斜体"], ["s_open", "删除线"], ["code_inline", "行内代码"],
    ["code_block", "代码块"], ["fence", "代码块"], ["html_block", "HTML"], ["html_inline", "HTML"],
    ["table_open", "表格"], ["hardbreak", "强制换行"],
  ]);
  for (const token of tokens) {
    if (unsupported.has(token.type)) diagnostics.push(`文章含有 V1 不支持的${unsupported.get(token.type)}。`);
    if (token.type === "link_open") {
      const href = token.attrGet("href") || "";
      if (!SAFE_LINK.test(href)) diagnostics.push(`链接协议不支持：${href}`);
    }
    if (token.children) scanTokens(token.children, diagnostics);
  }
}

function consumeAlignmentSentinels(node, diagnostics) {
  if (node.isText || node.isLeaf) return node;
  const children = [];
  let pending = null;
  node.forEach((original) => {
    let child = consumeAlignmentSentinels(original, diagnostics);
    const sentinel = child.type.name === "paragraph" && child.childCount === 1 && child.firstChild?.isText &&
      child.firstChild.marks.length === 0 && new RegExp(`^${SENTINEL_PREFIX}(center|right)$`).test(child.textContent);
    if (sentinel) {
      const value = child.textContent.slice(SENTINEL_PREFIX.length);
      if (pending) diagnostics.push("同一容器深度出现重复对齐指令。");
      pending = value;
      return;
    }
    if (pending) {
      if (["paragraph", "heading", "image"].includes(child.type.name)) {
        child = child.type.create({ ...child.attrs, align: pending }, child.content, child.marks);
      } else {
        diagnostics.push("对齐指令作用到了不支持对齐的节点。");
      }
      pending = null;
    }
    children.push(child);
  });
  if (pending) diagnostics.push("存在未作用于任何节点的孤立对齐指令。");
  return node.type.create(node.attrs, children, node.marks);
}

function dedupe(values) {
  return [...new Set(values)];
}

export function parseMarkdown(markdown) {
  const diagnostics = [];
  if (typeof markdown !== "string") return { doc: null, diagnostics: ["正文必须是文本。"], readOnly: true };
  const prepared = prepareAlignmentDirectives(markdown, diagnostics);
  let tokens = [];
  try {
    tokens = tokenizer.parse(prepared, {});
    scanTokens(tokens, diagnostics);
  } catch (error) {
    diagnostics.push(`Markdown 解析失败：${error.message}`);
  }
  let doc = null;
  if (!diagnostics.length) {
    try {
      doc = consumeAlignmentSentinels(parser.parse(prepared), diagnostics);
      validateDocument(doc, diagnostics);
    } catch (error) {
      diagnostics.push(`Markdown 转换失败：${error.message}`);
    }
  }
  return { doc, diagnostics: dedupe(diagnostics), readOnly: diagnostics.length > 0 };
}

function writeAlign(state, node) {
  if (node.attrs.align && node.attrs.align !== "left") {
    state.write(`<!--mpw:align=${node.attrs.align}-->`);
    state.closeBlock(node);
  }
}

const serializer = new MarkdownSerializer({
  blockquote: defaultMarkdownSerializer.nodes.blockquote,
  heading(state, node) {
    writeAlign(state, node);
    state.write(`${"#".repeat(node.attrs.level)} `);
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  horizontal_rule: defaultMarkdownSerializer.nodes.horizontal_rule,
  bullet_list(state, node) {
    state.renderList(node, "  ", () => "- ");
  },
  ordered_list: defaultMarkdownSerializer.nodes.ordered_list,
  list_item: defaultMarkdownSerializer.nodes.list_item,
  paragraph(state, node) {
    writeAlign(state, node);
    state.renderInline(node);
    state.closeBlock(node);
  },
  image(state, node) {
    writeAlign(state, node);
    const encodedSrc = encodeURI(String(node.attrs.src)).replace(/[()]/g, "\\$&");
    state.write(`![${state.esc(node.attrs.alt || "")}](${encodedSrc}${node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ""})`);
    state.closeBlock(node);
  },
  text: defaultMarkdownSerializer.nodes.text,
}, {
  strong: defaultMarkdownSerializer.marks.strong,
  link: defaultMarkdownSerializer.marks.link,
}, { strict: true });

export function serializeMarkdown(doc) {
  const diagnostics = [];
  validateDocument(doc, diagnostics);
  if (diagnostics.length) throw new Error(diagnostics.join(" "));
  return `${serializer.serialize(doc).trimEnd()}\n`;
}

export function validateDocument(doc, diagnostics = []) {
  if (!doc || doc.type !== editorSchema.topNodeType) {
    diagnostics.push("文档树根节点无效。");
    return diagnostics;
  }
  doc.descendants((node) => {
    if (["paragraph", "heading", "image"].includes(node.type.name) && !ALIGNMENTS.has(node.attrs.align)) {
      diagnostics.push(`无效对齐值：${node.attrs.align}`);
    }
    if (node.type.name === "image") {
      if (node.attrs.uploadId) diagnostics.push("尚有图片正在上传。");
      if (!IMAGE_PATH.test(node.attrs.src)) diagnostics.push(`图片路径无效：${node.attrs.src}`);
    }
    if (node.type.name === "text") {
      for (const mark of node.marks) {
        if (mark.type.name === "link" && !SAFE_LINK.test(mark.attrs.href || "")) diagnostics.push(`链接协议不支持：${mark.attrs.href}`);
      }
    }
  });
  return diagnostics;
}

export function documentFromJson(json) {
  const doc = editorSchema.nodeFromJSON(json);
  const diagnostics = validateDocument(doc, []);
  if (diagnostics.length) throw new Error(diagnostics.join(" "));
  return doc;
}

export function sameDocument(left, right) {
  const comparable = (doc) => {
    const json = doc.toJSON();
    json.content = (json.content || []).filter((node) => node.type !== "paragraph" || (node.content && node.content.length));
    return JSON.stringify(json);
  };
  return comparable(left) === comparable(right);
}

export function assertRoundTrip(doc) {
  const markdown = serializeMarkdown(doc);
  const parsed = parseMarkdown(markdown);
  if (parsed.readOnly || !parsed.doc || !sameDocument(doc, parsed.doc)) {
    throw new Error(`往返校验失败${parsed.diagnostics.length ? `：${parsed.diagnostics.join(" ")}` : ""}`);
  }
  return markdown;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderInline(node) {
  let output = "";
  node.forEach((child) => {
    if (!child.isText) return;
    let text = escapeHtml(child.text || "");
    for (const mark of child.marks.slice().reverse()) {
      if (mark.type.name === "strong") text = `<strong style="font-weight:700">${text}</strong>`;
      if (mark.type.name === "link" && SAFE_LINK.test(mark.attrs.href || "")) {
        text = `<a href="${escapeHtml(mark.attrs.href)}" style="color:#576b95;text-decoration:none">${text}</a>`;
      }
    }
    output += text;
  });
  return output;
}

function renderNode(node, imageData) {
  const align = ALIGNMENTS.has(node.attrs?.align) ? node.attrs.align : "left";
  const blockStyle = `text-align:${align};margin:0 0 16px;line-height:1.75;color:#2b2b2b`;
  switch (node.type.name) {
    case "paragraph": return `<p style="${blockStyle};font-size:16px">${renderInline(node)}</p>`;
    case "heading": {
      const sizes = { 1: 28, 2: 24, 3: 21, 4: 19, 5: 17, 6: 16 };
      return `<h${node.attrs.level} style="${blockStyle};font-size:${sizes[node.attrs.level]}px;font-weight:700">${renderInline(node)}</h${node.attrs.level}>`;
    }
    case "image": {
      const src = imageData.get(node.attrs.src);
      if (!src) throw new Error(`图片缺失：${node.attrs.src}`);
      return `<p style="${blockStyle}"><img src="${src}" alt="${escapeHtml(node.attrs.alt || "")}" style="max-width:100%;height:auto;display:inline-block" /></p>`;
    }
    case "horizontal_rule": return '<hr style="border:0;border-top:1px solid #e6e6e6;margin:24px 0" />';
    case "blockquote": return `<blockquote style="margin:16px 0;padding:8px 16px;border-left:4px solid #d9d9d9;background:#fafafa">${renderChildren(node, imageData)}</blockquote>`;
    case "bullet_list": return `<ul style="padding-left:1.6em;margin:0 0 16px">${renderChildren(node, imageData)}</ul>`;
    case "ordered_list": return `<ol start="${Number(node.attrs.order) || 1}" style="padding-left:1.6em;margin:0 0 16px">${renderChildren(node, imageData)}</ol>`;
    case "list_item": return `<li style="margin:4px 0">${renderChildren(node, imageData)}</li>`;
    default: throw new Error(`无法复制未支持节点：${node.type.name}`);
  }
}

function renderChildren(node, imageData) {
  let html = "";
  node.forEach((child) => { html += renderNode(child, imageData); });
  return html;
}

export function renderConfirmedHtml(doc, imageData, themeCss) {
  validateDocument(doc, []);
  return `<section style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;word-wrap:break-word">${renderChildren(doc, imageData)}</section><style>${String(themeCss).replace(/<\/style/gi, "<\\/style")}</style>`;
}

export function plainText(doc) {
  const lines = [];
  doc.descendants((node) => {
    if (["paragraph", "heading"].includes(node.type.name)) lines.push(node.textContent);
    if (node.type.name === "image") lines.push(node.attrs.alt ? `[图片：${node.attrs.alt}]` : "[图片]");
  });
  return lines.join("\n");
}

export const constraints = { IMAGE_PATH, SAFE_LINK, ALIGNMENTS };
