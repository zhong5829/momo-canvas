/**
 * 配置导出 / 导入（设置面板「模型配置」页用）
 */
import { useSettings } from "../../core/stores/settingsStore";
import { toast } from "../../core/stores/uiStore";
import { errMsg, isTauri } from "../../core/utils";

/** 写文本到用户选择的位置（Tauri 存盘对话框 / 浏览器下载） */
export async function saveTextAs(text: string, filename: string) {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = filename.split(".").pop() ?? "json";
    const path = await save({ defaultPath: filename, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return null;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, text);
    return path;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return filename;
}

/**
 * 导出配置：
 *  - stripKeys=true（默认，给别人/传网盘）：所有 API Key 置空并打 __keysStripped 标记，
 *    接收方导入后填自己的 Key；自己导入时本机已有的 Key 自动保留。
 *  - stripKeys=false（分享给信任的人直接用）：整份配置 AES 加密成分享包，
 *    文件里看不到明文密钥，接收方导入即可用（注意：能用就意味着技术上能被提取，只防翻看）。
 */
export async function exportCfg(stripKeys: boolean) {
  try {
    const s = useSettings.getState().settings;
    if (stripKeys) {
      const cleaned = {
        ...s,
        models: { ...s.models, providers: s.models.providers.map((p) => ({ ...p, apiKey: "" })) },
        search: { ...s.search, apiKey: "" },
        __keysStripped: true,
      };
      const path = await saveTextAs(JSON.stringify(cleaned, null, 2), "momo-settings.json");
      if (path) toast(`配置已导出（已抹去全部 API Key）→ ${path}`, "ok");
    } else {
      const { encryptCfg } = await import("../../core/cfgCrypto");
      const pkg = await encryptCfg(JSON.stringify(s));
      const path = await saveTextAs(JSON.stringify(pkg), "momo-settings.momocfg");
      if (path) toast(`加密分享包已导出 → ${path}（含密钥，只发给信任的人）`, "ok");
    }
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

export async function importCfg() {
  try {
    let text = "";
    if (isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ filters: [{ name: "配置文件", extensions: ["json", "momocfg"] }], multiple: false });
      if (typeof path !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      text = await readTextFile(path);
    } else {
      text = await new Promise<string>((resolve, reject) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,.momocfg";
        inp.onchange = () => {
          const f = inp.files?.[0];
          if (!f) return reject(new Error("未选择文件"));
          f.text().then(resolve, reject);
        };
        inp.click();
      });
    }
    let parsed = JSON.parse(text) as Record<string, unknown>;
    // 加密分享包 → 先解密
    const { isEncryptedCfg, decryptCfg } = await import("../../core/cfgCrypto");
    if (isEncryptedCfg(parsed)) parsed = JSON.parse(await decryptCfg(parsed)) as Record<string, unknown>;
    // 抹密钥导出的文件：本机已有的 Key 按服务商 id / 地址回填，不要用空串覆盖
    if (parsed.__keysStripped) {
      const cur = useSettings.getState().settings;
      const models = parsed.models as { providers?: { id?: string; baseUrl?: string; apiKey?: string }[] } | undefined;
      for (const p of models?.providers ?? []) {
        if (p.apiKey) continue;
        const match = cur.models.providers.find((x) => x.id === p.id) ?? cur.models.providers.find((x) => x.baseUrl && x.baseUrl === p.baseUrl);
        if (match?.apiKey) p.apiKey = match.apiKey;
      }
      const search = parsed.search as { apiKey?: string } | undefined;
      if (search && !search.apiKey && cur.search.apiKey) search.apiKey = cur.search.apiKey;
      delete parsed.__keysStripped;
    }
    useSettings.getState().importSettings(parsed);
    toast("配置已导入 ✓", "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}
