/**
 * 设置面板 · 音效提醒页
 */
import { Field, Row, Switch } from "../../../ui/kit";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { playDone, playError } from "../../../core/sound";
import { IcPlay, IcUpload } from "../../../ui/icons";
import { type SoundCfg } from "../../../core/types";
import { SecHelp } from "../shared";

export function SoundTab() {
  const sound = useSettings((s) => s.settings.sound);
  const update = useSettings((s) => s.update);
  const patch = (p: Partial<SoundCfg>) => update("sound", { ...sound, ...p });

  /** 上传自定义提示音（存为 dataURL；1.5MB 以内） */
  const upload = (key: "doneAudio" | "errAudio") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 1.5 * 1024 * 1024) {
        toast("音频太大（限 1.5MB 内）：建议用短促的提示音片段", "err");
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        patch({ [key]: r.result as string });
        toast("自定义提示音已保存，点「试听」确认效果", "ok");
      };
      r.readAsDataURL(f);
    };
    input.click();
  };

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">音效提醒</div>
        <div className="set-page-d">任务完成 / 报错时的提示音与语音播报。</div>
      </div>

      <div className="set-card">
        <div className="set-card-h">
          提示音
          <span className="sec-h-tail">
            <SecHelp>完成音在点击「生成/运行」的目标节点跑完后响起；报错音随报错中心触发。</SecHelp>
          </span>
        </div>
        <Row gap={12} style={{ alignItems: "center", marginBottom: 14 }}>
          <Switch on={sound.enabled} onChange={(v) => patch({ enabled: v })} />
          <b>启用音效提醒</b>
        </Row>
        <Field label="音量">
          <Row gap={10} style={{ alignItems: "center" }}>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={sound.volume}
              style={{ width: 220 }}
              onChange={(e) => patch({ volume: Number(e.target.value) })}
            />
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)" }}>{Math.round(sound.volume * 100)}%</span>
          </Row>
        </Field>
        <Field label="完成提示音" hint={sound.doneAudio ? "当前：自定义音频" : "当前：内置提示音（上扬双音）"}>
          <Row gap={8}>
            <button className="btn sm" onClick={playDone}>
              <IcPlay size={14} /> 试听
            </button>
            <button className="btn sm" onClick={() => upload("doneAudio")}>
              <IcUpload size={14} /> 上传自定义
            </button>
            {sound.doneAudio ? (
              <button className="btn sm" onClick={() => patch({ doneAudio: undefined })}>
                恢复内置
              </button>
            ) : null}
          </Row>
        </Field>
        <Field label="报错提示音" hint={sound.errAudio ? "当前：自定义音频" : "当前：内置提示音（下沉双音）"}>
          <Row gap={8}>
            <button className="btn sm" onClick={playError}>
              <IcPlay size={14} /> 试听
            </button>
            <button className="btn sm" onClick={() => upload("errAudio")}>
              <IcUpload size={14} /> 上传自定义
            </button>
            {sound.errAudio ? (
              <button className="btn sm" onClick={() => patch({ errAudio: undefined })}>
                恢复内置
              </button>
            ) : null}
          </Row>
        </Field>
      </div>

      <div className="set-card">
        <div className="set-card-h">语音播报</div>
        <Row gap={12} style={{ alignItems: "flex-start" }}>
          <Switch on={sound.speak} onChange={(v) => patch({ speak: v })} />
          <div>
            <div style={{ fontWeight: 600 }}>语音播报</div>
            <div className="set-hint" style={{ margin: "2px 0 6px" }}>
              用系统语音念出节点名与结果，例如「生成图像完成」「生成视频出错」（使用 Windows 内置中文语音，无需联网）。
            </div>
            <button
              className="btn sm"
              onClick={() => {
                // 试听不受开关限制，方便先听效果再决定开不开
                const u = new SpeechSynthesisUtterance("生成图像完成");
                u.lang = "zh-CN";
                u.volume = sound.volume;
                speechSynthesis.speak(u);
              }}
            >
              <IcPlay size={14} /> 试听播报
            </button>
          </div>
        </Row>
      </div>
    </div>
  );
}
