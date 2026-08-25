/**
 * 设置面板 · 图片保存页
 */
import { Field, Row, Switch } from "../../../ui/kit";
import { PopSelect } from "../../../ui/PopSelect";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { isTauri } from "../../../core/utils";
import { IcFolder } from "../../../ui/icons";
import { type Settings } from "../../../core/types";

/** 命名模板可用变量（点击追加） */
const NAME_VARS: { token: string; label: string; sample: string }[] = [
  { token: "{date}", label: "日期", sample: "20260718" },
  { token: "{time}", label: "时间", sample: "153042" },
  { token: "{model}", label: "模型", sample: "gpt-image-2" },
  { token: "{prompt}", label: "提示词", sample: "赛博朋克城市夜景" },
  { token: "{size}", label: "分辨率", sample: "2560x1440" },
  { token: "{ratio}", label: "比例", sample: "16x9" },
  { token: "{n}", label: "序号", sample: "1" },
  { token: "{seed}", label: "随机种子", sample: "12345" },
];

/** 模板实时示例：把变量替换成样例值，直观看到最终文件名（命名卡片底部醒目展示） */
function PatternPreview({ pattern }: { pattern: string }) {
  let out = pattern;
  for (const v of NAME_VARS) out = out.split(v.token).join(v.sample);
  return (
    <div className="save-preview">
      <span className="save-preview-lab">实时示例</span>
      <b className="save-preview-name">{out || "（空模板将使用 momo_日期_时间）"}.png</b>
      <span className="save-preview-note">序号 = 同前缀文件依次递增</span>
    </div>
  );
}

export function SaveTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const patch = (part: Partial<Settings["save"]>) => update("save", { ...settings.save, ...part });

  const pickDir = async () => {
    if (!isTauri) {
      toast("浏览器预览模式无法选择文件夹", "err");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "选择图片保存文件夹" });
    if (typeof dir === "string") patch({ dir });
  };

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">图片保存</div>
        <div className="set-page-d">
          控制「另存为 / 自动保存」写入磁盘的位置、格式与命名；画布生成的内容会另外自动收录进资产库，两者互不影响。
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-h">保存位置与格式</div>
        <Field label="保存文件夹">
          <Row>
            <input className="input" value={settings.save.dir} placeholder="尚未选择…"
              onChange={(e) => patch({ dir: e.target.value })} />
            <button className="btn" onClick={() => void pickDir()}>
              <IcFolder size={16} /> 浏览
            </button>
          </Row>
        </Field>
        <Row gap={12} style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Field label="保存格式">
              <PopSelect
                value={settings.save.format}
                options={[
                  { value: "png", label: "PNG", desc: "无损" },
                  { value: "jpeg", label: "JPG", desc: "体积小" },
                  { value: "webp", label: "WebP", desc: "兼顾两者" },
                ]}
                onChange={(v) => patch({ format: v as Settings["save"]["format"] })}
              />
            </Field>
          </div>
          <div style={{ flex: 1.6 }}>
            <Field
              label="PNG 元信息"
              hint="保存 PNG 时把提示词 / 模型 / seed / 生成时间嵌入文件（iTXt 文本块，不重编码图像、画质零损失，所有看图软件兼容）"
            >
              <Row gap={12} style={{ alignItems: "center" }}>
                <Switch on={settings.save.embedMeta} onChange={(v) => patch({ embedMeta: v })} />
                <span className="set-hint">写入提示词 / 模型 / seed / 时间（仅 PNG）</span>
              </Row>
            </Field>
          </div>
        </Row>
        <Field label="生成后自动保存" hint="开启后，每次生成成功都会按上述规则自动写入保存文件夹">
          <Switch on={settings.save.autoSave} onChange={(v) => patch({ autoSave: v })} />
        </Field>
      </div>

      <div className="set-card">
        <div className="set-card-h">命名模板</div>
        <input className="input" value={settings.save.pattern}
          onChange={(e) => patch({ pattern: e.target.value })} />
        <div className="var-chips">
          {NAME_VARS.map((v) => (
            <button
              key={v.token}
              className="btn sm"
              title={`点击把「${v.label}」追加到模板末尾（${v.token}）`}
              onClick={() => {
                const cur = settings.save.pattern.trim();
                patch({ pattern: cur ? `${cur}_${v.token}` : v.token });
              }}
            >
              {v.label}
            </button>
          ))}
          <button className="btn sm" title="清空模板重新组合" onClick={() => patch({ pattern: "" })}>
            清空
          </button>
        </div>
        <PatternPreview pattern={settings.save.pattern} />
      </div>
    </div>
  );
}
