/**
 * 带 @ 引用胶囊的提示词编辑器 —
 * contentEditable 富文本：@图片名 始终渲染为「缩略图 + 图N」胶囊（编辑中也不打回原形，
 * 对齐即梦/可灵）；胶囊是不可编辑的原子块，退格整体删除；数据模型仍是纯文本 @token，
 * 发模型/存档不受影响。图N 编号与实际传给模型的参考图顺序一致。
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from "react";
import { useBoard } from "../core/stores/boardStore";
import { collectImageRefsFor } from "../core/runner";
import { makeThumb, thumbSync } from "./Thumb";

export type AtRef = { label: string; src: string };

export type AtTextAreaHandle = {
  /** 在光标处插入一个 @ 引用胶囊（未聚焦时插到末尾） */
  insertToken: (label: string) => void;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 生成节点自己的上游参考图（与 runner.resolveAtRefs 同序，含组成员图），供提示词框渲染 @ 胶囊 */
export function useOwnUpstreamImageRefs(nodeId: string): AtRef[] {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  return useMemo(() => collectImageRefsFor(nodeId), [nodes, edges, nodeId]);
}

/** DOM → 纯文本（胶囊还原为 @token；<br>/块级元素还原为换行） */
function serialize(el: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.at !== undefined) {
      out += `@${node.dataset.at}`;
      return;
    }
    if (node.tagName === "BR") {
      out += "\n";
      return;
    }
    if (/^(DIV|P)$/.test(node.tagName) && out && !out.endsWith("\n")) out += "\n";
    node.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out;
}

function makePill(r: AtRef, idx: number): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "at-pill";
  span.contentEditable = "false";
  span.dataset.at = r.label;
  span.title = `引用参考图 @${r.label}（发给模型时写作「图${idx + 1}」）· 退格可整体删除`;
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.src = thumbSync(r.src) ?? "";
  if (!img.src) {
    void makeThumb(r.src, 96).then((t) => {
      img.src = t;
    });
  }
  span.appendChild(img);
  span.appendChild(document.createTextNode(`图${idx + 1}`));
  return span;
}

/** 纯文本 → DOM（@token 替换为胶囊） */
function renderInto(el: HTMLElement, value: string, refs: AtRef[]) {
  el.textContent = "";
  const labs = refs.map((r) => escapeRe(`@${r.label}`)).sort((a, b) => b.length - a.length);
  const re = labs.length ? new RegExp(`(${labs.join("|")})`, "g") : null;
  value.split("\n").forEach((line, li) => {
    if (li) el.appendChild(document.createElement("br"));
    for (const p of re ? line.split(re) : [line]) {
      if (!p) continue;
      const idx = refs.findIndex((r) => `@${r.label}` === p);
      if (idx >= 0) el.appendChild(makePill(refs[idx], idx));
      else el.appendChild(document.createTextNode(p));
    }
  });
}

/** 光标移到元素内容末尾 */
function caretToEnd(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export const AtTextArea = forwardRef<
  AtTextAreaHandle,
  {
    value: string;
    onChange: (v: string) => void;
    refs: AtRef[];
    placeholder?: string;
    rows?: number;
    style?: CSSProperties;
  }
>(function AtTextArea({ value, onChange, refs, placeholder, rows = 5, style }, handle) {
  const ref = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const refsRef = useRef(refs);
  refsRef.current = refs;
  // value 变化是否来自用户在本编辑器内的输入/插入 —— 是则绝不重建 DOM（否则光标会蹦到末尾）
  const internal = useRef(false);

  // 仅「外部」改动（历史回填、AI 扩写、撤销重做、refs 导致胶囊增减）才重建 DOM；
  // 用户自己打字/插入胶囊引起的 value 变化，DOM 已是最新，跳过重建以保持光标位置
  useEffect(() => {
    const el = ref.current;
    if (!el || composing.current) return;
    if (internal.current) {
      internal.current = false;
      return;
    }
    if (serialize(el) !== value) {
      renderInto(el, value, refsRef.current);
      if (document.activeElement === el) caretToEnd(el);
    }
  }, [value, refs]);

  useImperativeHandle(handle, () => ({
    insertToken: (label: string) => {
      const el = ref.current;
      const idx = refsRef.current.findIndex((r) => r.label === label);
      if (!el || idx < 0) return;
      el.focus();
      const sel = window.getSelection();
      let range: Range;
      if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
        range = sel.getRangeAt(0);
      } else {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.deleteContents();
      const pill = makePill(refsRef.current[idx], idx);
      range.insertNode(pill);
      const space = document.createTextNode(" ");
      pill.after(space);
      const nr = document.createRange();
      nr.setStartAfter(space);
      nr.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(nr);
      internal.current = true; // 程序化插入胶囊：DOM 已更新，不要重建
      onChange(serialize(el));
    },
  }));

  return (
    <div
      ref={ref}
      className="textarea at-edit nodrag nowheel"
      style={{ minHeight: `${rows * 1.55 + 1.2}em`, ...style }}
      contentEditable
      suppressContentEditableWarning
      data-ph={placeholder ?? ""}
      spellCheck={false}
      onInput={() => {
        if (composing.current) return;
        const el = ref.current;
        if (el) {
          internal.current = true; // 用户输入：别让 useEffect 重建 DOM 打断光标
          onChange(serialize(el));
        }
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        const el = ref.current;
        if (el) {
          internal.current = true;
          onChange(serialize(el));
        }
      }}
      onPaste={(e) => {
        // 粘贴一律按纯文本插入（外来富文本会污染编辑器结构）
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        if (text) document.execCommand("insertText", false, text);
      }}
    />
  );
});
