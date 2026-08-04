import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";
import "./styles/base.css";
import "./modules/shell/shell.css";

// 仅开发环境：把核心 store 挂到 window，方便在浏览器预览模式下调试/注入测试数据
if (import.meta.env.DEV) {
  void Promise.all([import("./core/stores/assetStore"), import("./core/stores/uiStore"), import("./core/stores/boardStore")]).then(
    ([a, u, b]) => {
      (window as unknown as Record<string, unknown>).__momo = { useAssets: a.useAssets, useUi: u.useUi, useBoard: b.useBoard };
      // ?seed=画廊数,资产数：注入彩色占位图，方便离线调试资产库/生成记录的大量条目布局
      const sp = new URLSearchParams(location.search);
      const seedGallery = Number(sp.get("seed") ?? 0);
      if (seedGallery > 0) {
        const mk = (i: number) =>
          `data:image/svg+xml,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="hsl(${(i * 37) % 360},70%,55%)"/><text x="20" y="130" font-size="36" font-weight="bold" fill="#fff">占位${i}</text></svg>`,
          )}`;
        for (let i = 0; i < seedGallery; i++) {
          u.useUi.getState().addGallery({
            kind: i % 5 === 4 ? "video" : "image",
            src: mk(i),
            prompt: `离线调试占位条目 ${i}`,
            model: "seed",
            nodeId: undefined,
          });
        }
        u.useUi.getState().setGalleryOpen(true);
      }
    },
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
