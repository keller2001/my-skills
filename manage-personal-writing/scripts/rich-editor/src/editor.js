import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { wrapInList, liftListItem } from "prosemirror-schema-list";
import { inputRules, wrappingInputRule, textblockTypeInputRule } from "prosemirror-inputrules";
import { dropCursor } from "prosemirror-dropcursor";
import { editorSchema } from "./validator.js";

const token = new URLSearchParams(location.search).get("token");
const endpoint = (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token || "")}`;
const statusNode = document.querySelector("#status");
const recoveryNode = document.querySelector("#recovery");
const editorHost = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const fileInput = document.querySelector("#image-input");
let view;
let confirmedHash = null;
let dirty = false;
let readOnly = true;
let saving = false;
let closing = false;
let copying = false;
let uploading = false;
let conflicted = false;
let missingImages = [];
let saveTimer = null;
let editSequence = 0;

function setStatus(message, kind = "info") {
  statusNode.textContent = message;
  statusNode.dataset.kind = kind;
}

async function api(path, options = {}) {
  const response = await fetch(endpoint(path), {
    ...options,
    headers: { ...(options.body instanceof Blob ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, data });
  return data;
}

function inputRulePlugins() {
  return inputRules({ rules: [
    textblockTypeInputRule(/^(#{1,6})\s$/, editorSchema.nodes.heading, (match) => ({ level: match[1].length, align: "left" })),
    wrappingInputRule(/^\s*>\s$/, editorSchema.nodes.blockquote),
    wrappingInputRule(/^\s*([-+*])\s$/, editorSchema.nodes.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, editorSchema.nodes.ordered_list, (match) => ({ order: Number(match[1]) })),
  ] });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  if (!dirty || readOnly || conflicted || uploading || copying) return;
  saveTimer = setTimeout(() => saveDocument(false), 800);
}

function dispatchTransaction(transaction) {
  if ((closing || copying) && transaction.docChanged || copying && transaction.storedMarksSet) return;
  const next = view.state.apply(transaction);
  view.updateState(next);
  if (transaction.docChanged) {
    editSequence += 1;
    dirty = true;
    setStatus("正在编辑，即将自动保存…");
    scheduleSave();
  }
  updateToolbarState();
}

function updateToolbarState() {
  document.querySelectorAll("#toolbar button").forEach((button) => { button.disabled = saving || closing || copying || (readOnly && button.hasAttribute("data-command")); });
  document.querySelector("#rollback").disabled = saving || closing || copying;
  fileInput.disabled = saving || closing || copying;
  document.querySelector("#copy").disabled = readOnly || dirty || saving || closing || copying || uploading || conflicted || missingImages.length > 0;
  document.querySelector("#save-close").disabled = readOnly || saving || closing || copying || uploading || conflicted;
}

function setClosing(value) {
  closing = value;
  if (view) view.setProps({ editable: () => !readOnly && !closing && !copying });
  updateToolbarState();
}

function setCopying(value) {
  copying = value;
  if (view) view.setProps({ editable: () => !readOnly && !closing && !copying });
  updateToolbarState();
}

function buildView(doc) {
  const state = EditorState.create({
    doc,
    plugins: [
      inputRulePlugins(),
      history(),
      dropCursor(),
      keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo, "Mod-b": toggleMark(editorSchema.marks.strong) }),
      keymap(baseKeymap),
    ],
  });
  view = new EditorView(editorHost, {
    state,
    editable: () => !readOnly && !closing && !copying,
    dispatchTransaction,
    handlePaste(_view, event) {
      const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
      if (!files.length) return false;
      event.preventDefault();
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (total > 100 * 1024 * 1024) return setStatus("这次粘贴的图片总量超过 100 MiB。", "error"), true;
      void uploadFiles(files);
      return true;
    },
  });
}

async function loadDocument() {
  try {
    const data = await api("/api/document");
    confirmedHash = data.hash;
    readOnly = data.readOnly;
    missingImages = data.missingImages || [];
    buildView(editorSchema.nodeFromJSON(data.doc));
    renderRecovery(data.recovery);
    if (data.diagnostics?.length) setStatus(data.diagnostics.join(" "), "error");
    else if (missingImages.length) setStatus(`文章有 ${missingImages.length} 张缺图；替换或移除前不能复制。`, "error");
    else setStatus(readOnly ? "当前以只读模式打开。" : "已打开，仅编辑才会写入文件。", readOnly ? "warning" : "ok");
    updateToolbarState();
  } catch (error) {
    readOnly = true;
    editorHost.textContent = "无法打开文章。";
    setStatus(error.message, "error");
  }
}

async function saveDocument(closeAfter) {
  if (saving || copying || uploading || readOnly || conflicted) return false;
  if (!dirty && !closeAfter) return true;
  if (closeAfter) setClosing(true);
  saving = true;
  const savingSequence = editSequence;
  const savingDocument = view.state.doc.toJSON();
  updateToolbarState();
  setStatus(closeAfter ? "正在保存并关闭…" : "正在保存…");
  try {
    const data = dirty ? await api("/api/save", {
      method: "POST",
      body: JSON.stringify({ doc: savingDocument, expectedHash: confirmedHash }),
    }) : { hash: confirmedHash, missingImages };
    confirmedHash = data.hash;
    missingImages = data.missingImages || [];
    const savedCurrentVersion = editSequence === savingSequence;
    dirty = !savedCurrentVersion;
    if (savedCurrentVersion) {
      setStatus(missingImages.length ? `已保存，但有 ${missingImages.length} 张缺图。` : "已完成往返校验并保存。", missingImages.length ? "warning" : "ok");
    } else {
      setStatus("保存期间有新输入，正在继续自动保存…");
    }
    if (closeAfter && savedCurrentVersion) {
      await api("/api/close", { method: "POST", body: JSON.stringify({ expectedHash: confirmedHash }) });
      document.body.innerHTML = '<main class="closed"><h1>已安全保存并关闭</h1><p>现在可以关闭这个页面。</p></main>';
    }
    return savedCurrentVersion;
  } catch (error) {
    if (error.status === 409) conflicted = true;
    setStatus(error.message, "error");
    if (closeAfter) setClosing(false);
    return false;
  } finally {
    saving = false;
    updateToolbarState();
    if (dirty && !readOnly && !conflicted && !uploading && !copying) scheduleSave();
  }
}

function findUpload(uploadId) {
  let found = null;
  view.state.doc.descendants((node, pos) => {
    if (node.type === editorSchema.nodes.image && node.attrs.uploadId === uploadId) found = { node, pos };
  });
  return found;
}

async function uploadFiles(files, replaceSelection = false) {
  if (copying) return;
  if (saving || closing || uploading || readOnly) return setStatus("当前有保存、关闭或图片任务正在进行。", "warning");
  uploading = true;
  updateToolbarState();
  try {
    for (const file of files) {
      const uploadId = crypto.randomUUID();
      const selected = replaceSelection && view.state.selection instanceof NodeSelection && view.state.selection.node.type === editorSchema.nodes.image;
      let transaction = view.state.tr;
      if (selected) {
        const node = view.state.selection.node;
        transaction = transaction.setNodeMarkup(view.state.selection.from, undefined, { ...node.attrs, uploadId });
      } else {
        const placeholder = editorSchema.nodes.image.create({ src: "images/uploading.png", alt: file.name, align: "left", uploadId });
        transaction = transaction.replaceSelectionWith(placeholder).setSelection(NodeSelection.create(transaction.doc, transaction.selection.from - placeholder.nodeSize));
      }
      view.dispatch(transaction);
      setStatus(`正在上传 ${file.name}…`);
      const response = await api("/api/upload", {
        method: "POST",
        body: file,
        headers: { "Content-Type": "application/octet-stream", "X-Image-Name": encodeURIComponent(file.name) },
      });
      const current = findUpload(uploadId);
      if (current) {
        view.dispatch(view.state.tr.setNodeMarkup(current.pos, undefined, {
          ...current.node.attrs,
          src: response.path,
          alt: current.node.attrs.alt || file.name,
          uploadId: null,
        }));
      }
    }
    setStatus("图片已插入，即将自动保存。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    uploading = false;
    updateToolbarState();
    scheduleSave();
  }
}

function commandFor(name) {
  const paragraph = editorSchema.nodes.paragraph;
  const heading = editorSchema.nodes.heading;
  const item = editorSchema.nodes.list_item;
  const map = {
    paragraph: setBlockType(paragraph, { align: "left" }),
    h1: setBlockType(heading, { level: 1, align: "left" }), h2: setBlockType(heading, { level: 2, align: "left" }),
    h3: setBlockType(heading, { level: 3, align: "left" }), h4: setBlockType(heading, { level: 4, align: "left" }),
    h5: setBlockType(heading, { level: 5, align: "left" }), h6: setBlockType(heading, { level: 6, align: "left" }),
    strong: toggleMark(editorSchema.marks.strong), quote: wrapIn(editorSchema.nodes.blockquote),
    bullet: wrapInList(editorSchema.nodes.bullet_list), ordered: wrapInList(editorSchema.nodes.ordered_list),
    hr: (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(editorSchema.nodes.horizontal_rule.create()).scrollIntoView());
      return true;
    },
    lift: liftListItem(item), undo, redo,
  };
  return map[name];
}

function setAlignment(align) {
  const selection = view.state.selection;
  if (selection instanceof NodeSelection && selection.node.type === editorSchema.nodes.image) {
    view.dispatch(view.state.tr.setNodeMarkup(selection.from, undefined, { ...selection.node.attrs, align }));
    return true;
  }
  let transaction = view.state.tr;
  let changed = false;
  const seen = new Set();
  view.state.doc.nodesBetween(selection.from, selection.to || selection.from, (node, pos) => {
    if ([editorSchema.nodes.paragraph, editorSchema.nodes.heading].includes(node.type) && !seen.has(pos)) {
      transaction = transaction.setNodeMarkup(pos, undefined, { ...node.attrs, align });
      seen.add(pos);
      changed = true;
      return false;
    }
    return true;
  });
  if (!changed) {
    for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
      const node = selection.$from.node(depth);
      if ([editorSchema.nodes.paragraph, editorSchema.nodes.heading].includes(node.type)) {
        transaction = transaction.setNodeMarkup(selection.$from.before(depth), undefined, { ...node.attrs, align });
        changed = true;
        break;
      }
    }
  }
  if (changed) view.dispatch(transaction);
  return changed;
}

function selectedImage() {
  const selection = view.state.selection;
  return selection instanceof NodeSelection && selection.node.type === editorSchema.nodes.image ? { node: selection.node, pos: selection.from } : null;
}

function moveImage(direction) {
  const selected = selectedImage();
  if (!selected) return setStatus("请先单击选中一张图片。", "warning");
  const resolved = view.state.doc.resolve(selected.pos);
  const index = resolved.index();
  const parent = resolved.parent;
  if (direction < 0 && index === 0 || direction > 0 && index >= parent.childCount - 1) return;
  const neighbor = parent.child(index + direction);
  let transaction = view.state.tr.delete(selected.pos, selected.pos + selected.node.nodeSize);
  const insertAt = direction < 0 ? selected.pos - neighbor.nodeSize : selected.pos + neighbor.nodeSize;
  transaction = transaction.insert(insertAt, selected.node).setSelection(NodeSelection.create(transaction.doc, insertAt));
  view.dispatch(transaction);
}

function addLink() {
  const href = prompt("请输入 http、https 或 mailto 链接：", "https://");
  if (!href) return;
  if (!/^(https?:|mailto:)/i.test(href)) return setStatus("链接协议不受支持。", "error");
  toggleMark(editorSchema.marks.link, { href, title: null })(view.state, view.dispatch, view);
}

async function copyConfirmed() {
  if (copying) return;
  if (dirty || saving || uploading || conflicted || missingImages.length) return setStatus("当前状态不允许复制。", "warning");
  const copyHash = confirmedHash;
  setCopying(true);
  setStatus("正在生成富文本并写入剪贴板，请稍候…");
  try {
    const dataPromise = api("/api/copy", { method: "POST", body: JSON.stringify({ expectedHash: copyHash }) });
    const clipboardPromise = navigator.clipboard.write([new ClipboardItem({
      "text/html": dataPromise.then((data) => new Blob([data.html], { type: "text/html" })),
      "text/plain": dataPromise.then((data) => new Blob([data.plain], { type: "text/plain" })),
    })]);
    const [data] = await Promise.all([dataPromise, clipboardPromise]);
    preview.srcdoc = data.html;
    setStatus("已同时复制富文本和纯文本。请在微信公众号中粘贴后亲自验收。", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setCopying(false);
  }
}

function renderRecovery(recovery) {
  recoveryNode.innerHTML = "";
  if (!recovery) return;
  const title = document.createElement("strong");
  title.textContent = recovery.message;
  recoveryNode.append(title);
  for (const option of recovery.options || []) {
    const button = document.createElement("button");
    button.textContent = option.label;
    button.addEventListener("click", async () => {
      try {
        await api("/api/recovery", { method: "POST", body: JSON.stringify({ action: option.action }) });
        location.reload();
      } catch (error) { setStatus(error.message, "error"); }
    });
    recoveryNode.append(button);
  }
}

document.querySelector("#toolbar").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled || saving || closing || copying) return;
  const command = button.dataset.command;
  if (command) commandFor(command)?.(view.state, view.dispatch, view);
  if (button.dataset.align) setAlignment(button.dataset.align);
  if (button.id === "link") addLink();
  if (button.id === "image") fileInput.click();
  if (button.id === "replace-image") fileInput.dataset.replace = "true", fileInput.click();
  if (button.id === "delete-image") {
    const selected = selectedImage();
    if (selected) view.dispatch(view.state.tr.delete(selected.pos, selected.pos + selected.node.nodeSize));
  }
  if (button.id === "image-up") moveImage(-1);
  if (button.id === "image-down") moveImage(1);
});

fileInput.addEventListener("change", () => {
  if (saving || closing || copying) {
    fileInput.value = "";
    delete fileInput.dataset.replace;
    return;
  }
  const files = [...fileInput.files];
  const replace = fileInput.dataset.replace === "true";
  fileInput.value = "";
  delete fileInput.dataset.replace;
  if (files.length) void uploadFiles(replace ? files.slice(0, 1) : files, replace);
});

document.querySelector("#copy").addEventListener("click", copyConfirmed);
document.querySelector("#save-close").addEventListener("click", () => saveDocument(true));
document.querySelector("#rollback").addEventListener("click", async () => {
  if (copying) return;
  if (saving || closing) return setStatus("保存或关闭期间不能回退。", "warning");
  if (!confirm("确定与上一个已确认版本互换吗？")) return;
  try { await api("/api/rollback", { method: "POST", body: JSON.stringify({ expectedHash: confirmedHash }) }); location.reload(); }
  catch (error) { setStatus(error.message, "error"); }
});

window.addEventListener("beforeunload", (event) => {
  if (dirty || saving || copying || uploading) { event.preventDefault(); event.returnValue = ""; }
});

setInterval(() => { void api("/api/heartbeat", { method: "POST", body: "{}" }).catch(() => {}); }, 20_000);
void loadDocument();
