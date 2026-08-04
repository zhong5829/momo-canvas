/**
 * 画布右键菜单 — 画布空白与节点共用一份受控组件。
 * 父组件捕获 React Flow 的 onPaneContextMenu / onNodeContextMenu，组装 items 后渲染。
 * 自动避开屏幕边界；点外部 / 滚动 / Esc 关闭；选一项后关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type CmItem = {
  /** 菜单项文字（sep 分隔项可省略） */
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 分组标题：相同 group 的相邻项归到一个小标题下；空串 = 无标题主区 */
  group?: string;
  /** 仅作分隔，其它字段忽略 */
  sep?: boolean;
};

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CmItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 首次定位后按实际尺寸贴边，避免菜单超出窗口右下边
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + r.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    // 下一次点击/右键Anywhere 都关（mousedown 提前，避免先触发菜单项外的元素）
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // 按 group 折叠渲染（相邻同组归到一个小标题下）
  const rows: ReactNode[] = [];
  let lastGroup: string | undefined;
  let needSep = false;
  items.forEach((it, i) => {
    if (it.sep) {
      needSep = true;
      return;
    }
    if (it.group !== lastGroup) {
      if (rows.length) needSep = true;
      if (it.group) {
        if (needSep) rows.push(<div className="cm-sep" key={`s${i}`} />);
        rows.push(
          <div className="cm-group" key={`g${i}`}>
            {it.group}
          </div>,
        );
        needSep = false;
      } else if (needSep) {
        rows.push(<div className="cm-sep" key={`s${i}`} />);
        needSep = false;
      }
      lastGroup = it.group;
    } else if (needSep) {
      rows.push(<div className="cm-sep" key={`s${i}`} />);
      needSep = false;
    }
    rows.push(
      <button
        key={i}
        className={`cm-item${it.danger ? " danger" : ""}`}
        disabled={it.disabled}
        onClick={() => {
          onClose();
          it.onClick?.();
        }}
      >
        {it.icon ? <span className="cm-ic">{it.icon}</span> : <span className="cm-ic" />}
        <span>{it.label}</span>
      </button>,
    );
  });

  return createPortal(
    <div className="cm-root nodrag" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {rows}
    </div>,
    document.body,
  );
}
