import { memo, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { mediaNodeWidth, NodeShell, PortOut } from "../NodeShell";
import { EditSurface } from "../EditSurface";
import { IcDownload, IcImage, IcScan, IcUpload } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { fileToDataUrl, errMsg } from "../../../core/utils";
import { saveImageAs } from "../../../core/services/imageSaver";
import { useImageDims } from "../../../core/imageInfo";
import { Thumb } from "../../../ui/Thumb";
import type { ImageData } from "../../../core/types";

export const ImageNode = memo(function ImageNode({ id, data, selected }: NodeProps) {
  const d = data as ImageData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const fileRef = useRef<HTMLInputElement>(null);
  // 宽度随图片比例自适应（竖图窄、横图宽）
  const dims = useImageDims(d.src);

  const onFile = async (f?: File | null) => {
    if (!f) return;
    const src = await fileToDataUrl(f);
    upd(id, { src, name: f.name, status: "done" });
  };

  const save = async () => {
    if (!d.src) return;
    try {
      const p = await saveImageAs(d.src, useSettings.getState().settings.save, { prompt: d.name });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title={d.name || "图片"}
      icon={<IcImage size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={mediaNodeWidth(dims, 320)}
      media
      headExtra={
        d.src ? (
          <>
            <button className="nt-btn" title="放大预览" onClick={() => setLightbox(d.src!)}>
              <IcScan size={14} /> 放大
            </button>
            <button className="nt-btn" title="替换图片" onClick={() => fileRef.current?.click()}>
              <IcUpload size={14} /> 替换
            </button>
            <button className="nt-btn" title="保存到本地" onClick={save}>
              <IcDownload size={14} /> 保存
            </button>
          </>
        ) : undefined
      }
    >
      <div className="mnode-body">
        {d.src ? (
          <EditSurface id={id} src={d.src}>
            <Thumb className="img-main" src={d.src} alt={d.name} res onClick={() => setLightbox(d.src!)} />
          </EditSurface>
        ) : (
          <div
            className="img-empty"
            role="button"
            tabIndex={0}
            // 不加 nodrag：空态占满节点体，加了会导致节点无处下手拖动；点击不位移时 onClick 照常触发
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
          >
            <IcImage size={26} />
            <span>
              点击导入图片
              <br />
              也可直接拖入 / Ctrl+V 粘贴
            </span>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <PortOut kind="image" />
    </NodeShell>
  );
});
