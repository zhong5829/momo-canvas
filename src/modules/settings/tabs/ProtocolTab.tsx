/**
 * 设置面板 · 协议页 — 自定义协议管理 / 协议助手 / 真实测试与校准
 */
import { useState } from "react";
import { Switch } from "../../../ui/kit";
import { PopSelect } from "../../../ui/PopSelect";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { chatOnce } from "../../../core/services/llm";
import { calibrateProtocol } from "../../../core/services/protoCalibrate";
import { placeholdersIn, protoFingerprint, unknownPlaceholders, validateProto, varList, varsDoc } from "../../../core/services/protoSpec";
import { MANUAL, useProtoTab } from "../protoTabStore";
import { xfetch } from "../../../core/services/http";
import { errMsg, parseJsonLoose, uid } from "../../../core/utils";
import { PROTO_PRESETS, applyProtoPreset } from "../../../core/protoPresets";
import {
  IcBulb,
  IcCheck,
  IcChevronD,
  IcClose,
  IcGallery,
  IcGear,
  IcGlobe,
  IcLoading,
  IcMusic,
  IcSparkles,
  IcVideo,
  IcWarn,
} from "../../../ui/icons";
import { type CustomProtocol } from "../../../core/types";
import { IcEditSmall } from "../shared";

const protocolSystem = (role: CustomProtocol["role"]) => `你是 API 协议分析专家。用户会粘贴一个 AI 生成类中转站/服务商的接口文档、示例请求或抓包内容（图片 / 视频 / 音频生成都有可能）。请分析后输出一份 momo 画布的自定义协议 JSON（只输出 JSON，不要任何解释、不要代码块标记）。
用户在界面上把这份文档标为「${role === "video" ? "视频" : role === "audio" ? "音频" : "图片"}生成」，若你判断确实不是，再改 role。

JSON 结构（TypeScript 描述）：
{
  "name": string,            // 协议显示名，如 "某某站异步生图"
  "role": "image" | "video" | "audio", // 【务必仔细判断】该接口生成的是图片、视频还是音频：看接口路径（/images、/videos、/audio/speech）、参数（时长/帧率/音色）、返回字段（video_url、mp4、audio_url 等）
  "submit": {                // 提交生成请求
    "url": string,           // 完整 URL，可用占位符 {{baseUrl}}
    "method": "POST"|"GET",
    "headers": Record<string,string>,  // 通常 {"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}"}
    "body": string           // JSON 请求体的字符串模板
  },
  "taskIdPath": string,      // 【异步接口才填】提交响应中任务 id 的 JSON 路径，如 "task_id" 或 "data.id"；同步接口省略此字段
  "poll": {                  // 【异步接口才填】轮询查询
    "url": string,           // 查询 URL，可用 {{taskId}}
    "method": "GET"|"POST",
    "headers": Record<string,string>,
    "intervalMs": number,    // 轮询间隔毫秒，默认 3000
    "statusPath": string,    // 状态字段 JSON 路径
    "doneValue": string,     // 表示完成的状态值
    "failValue": string      // 表示失败的状态值
  },
  "resultPath": string       // 最终响应中图片/视频(url或base64)的 JSON 路径；数组用 []，如 "data[].url"
}

${varsDoc(role)}
【重要】body 必须是 JSON 字符串模板（一整个字符串），不能写成嵌套对象。{{prompt}} 必须出现，否则提示词发不出去。
【重要】若文档显示接口支持图生图（image/images 等字段），请务必把图片字段写进 body 模板，否则参考图发不出去；支持蒙版编辑（mask/inpaint）也请写上 {{mask}} 字段；视频接口把时长/分辨率/比例字段接到 {{duration}}/{{resolution}}/{{aspect}}，音频接口把音色接到 {{voice}}，否则画布面板上的设置全部不生效。
条件块语法（可选字段/端点切换用）：{{?var}}…{{/var}} 变量非空时保留；{{^var}}…{{/var}} 变量为空时保留。例：url 写 "{{baseUrl}}/v1/images/{{?images}}edits{{/images}}{{^images}}generations{{/images}}"；body 里写 {{?mask}},"mask":{"image_url":"{{mask}}"}{{/mask}}。
JSON 路径语法：点号访问对象字段，字段名后加 [] 表示展开数组，如 "data.images[].url"。
如文档信息不足，按 OpenAI 风格合理推断并在 name 里标注「(待验证)」。`;

/**
 * 从粘贴内容里挑出「值得抓的文档链接」。
 * 以前是无差别捞前两个 http URL —— 而输入框恰恰鼓励粘 curl 示例，
 * 于是第一个 URL 往往是用户自己的生成端点，程序会对它发一次无鉴权 GET，
 * 拿回 401 的错误 JSON 还当成"抓取到的文档"喂给模型（xfetch 对 4xx 不抛错，静默污染）。
 */
function pickDocUrls(text: string): string[] {
  const all = text.match(/https?:\/\/[^\s"'<>）)】\]]+/g) ?? [];
  const apiLike = /\/(v\d+)\/|\/(chat\/completions|completions|images?|generations?|videos?|audio|speech|embeddings|edits|submit|query|task)s?(\/|$|\?)/i;
  return [...new Set(all.filter((u) => !apiLike.test(u)))].slice(0, 2);
}

/** 抓来的正文看着像不像文档（404 页、登录页、JS 壳页面、错误 JSON 一律不算） */
function looksLikeDoc(text: string): boolean {
  if (text.length < 300) return false;
  return !/(enable ?javascript|页面不存在|not found|请先登录|sign in to continue|access denied)/i.test(text.slice(0, 400));
}

/** 粗糙但够用的 HTML → 纯文本（协议助手抓取文档链接用） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 抓取粘贴内容里的文档链接（校验状态码/类型/正文成色，抓不到就明说，不拿垃圾正文冒充文档） */
async function fetchDocs(docs: string, limit: number): Promise<string> {
  let material = "";
  for (const u of pickDocUrls(docs)) {
    try {
      toast(`正在抓取文档：${u.slice(0, 60)}…`, "info");
      const resp = await xfetch(u);
      if (!resp.ok) {
        toast(`抓取 ${u.slice(0, 50)} 返回 ${resp.status}，已跳过（只用你粘贴的文字分析）`, "err");
        continue;
      }
      const ct = (resp.headers?.get?.("content-type") ?? "").toLowerCase();
      if (ct && !/html|text|markdown|json|plain/.test(ct)) {
        toast(`${u.slice(0, 50)} 返回的是 ${ct}，不是文档页，已跳过`, "err");
        continue;
      }
      const text = htmlToText(await resp.text()).slice(0, limit);
      if (!looksLikeDoc(text)) {
        toast(`${u.slice(0, 50)} 抓到的内容不像文档（可能是登录页或前端渲染页），已跳过——请把关键接口段落直接复制过来`, "err");
        continue;
      }
      material += `\n\n=== 以下内容抓取自 ${u} ===\n${text}`;
      toast(`已抓取 ${text.length} 字文档内容 ✓`, "ok");
    } catch (e) {
      toast(`抓取 ${u.slice(0, 50)} 失败：${errMsg(e)}，将只用已粘贴的文字分析`, "err");
    }
  }
  return material;
}

export function ProtocolTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const [busy, setBusy] = useState(false);
  /* 草稿与校准现场都在 protoTabStore：切到其他页面/关掉弹窗不丢，正在跑的测试可停止 */
  const { docs, draft, roleSel, testProvider, testModel, manualBase, manualKey, calLog, calBusy, ctrl, calDone, calSnap, patch, logLine } =
    useProtoTab();
  const providers = settings.models.providers;
  const selProvider = testProvider || providers[0]?.id || MANUAL;
  const manual = selProvider === MANUAL;
  /* 「占位符参考」chips 行展开态：纯界面状态，不进 protoTabStore */
  const [varsOpen, setVarsOpen] = useState(false);

  /** 占位符 chip 点击复制（清单来自 protoSpec.varList，不硬编码） */
  const copyVar = (name: string) => {
    const s = `{{${name}}}`;
    navigator.clipboard
      ?.writeText(s)
      .then(() => toast(`已复制 ${s}`, "ok"))
      .catch(() => toast(`复制失败，请手动输入 ${s}`, "err"));
  };

  /** 选服务商时顺手预填其对应槽位的第一个模型 */
  const pickProvider = (pid: string) => {
    patch({ testProvider: pid });
    if (pid === MANUAL) return;
    const p = providers.find((x) => x.id === pid);
    const m = p?.models[roleSel]?.models[0];
    if (m) patch({ testModel: m });
  };

  const runCalibrate = async () => {
    let proto: CustomProtocol;
    try {
      const r = validateProto(parseJsonLoose<CustomProtocol>(draft) ?? JSON.parse(draft));
      proto = r.proto;
      if (r.warnings.length) toast(`协议有待确认之处：${r.warnings.join("；")}`, "info");
    } catch (e) {
      toast(`右侧协议 JSON 不完整：${errMsg(e)}`, "err");
      return;
    }
    proto.role = roleSel;
    const prov = manual ? undefined : providers.find((x) => x.id === selProvider);
    const baseUrl = (manual ? manualBase : prov?.baseUrl ?? "").trim();
    const apiKey = (manual ? manualKey : prov?.apiKey ?? "").trim();
    if (!baseUrl) {
      toast(manual ? "请填写用于测试的 Base URL" : "请选择服务商，或选「手动输入」直接填 Base URL / Key", "err");
      return;
    }
    if (!testModel.trim()) {
      toast("请填写用于测试的模型名", "err");
      return;
    }
    const ctrl = new AbortController();
    patch({
      calBusy: true,
      ctrl,
      calDone: null,
      calLog: [`使用${prov ? `服务商「${prov.name}」` : "手动填写的地址"}（${baseUrl}）· 模型 ${testModel.trim()} 进行真实测试…`],
    });
    try {
      const { proto: fixed, results } = await calibrateProtocol(
        proto,
        { baseUrl, apiKey, model: testModel.trim() },
        logLine,
        ctrl.signal,
      );
      if (!fixed.id) fixed.id = proto.id ?? uid(6);
      fixed.verifiedAt = Date.now(); // 真实测试通过 → 盖「已校准」章
      patch({
        draft: JSON.stringify(fixed, null, 2),
        calDone: { model: testModel.trim(), providerId: prov?.id, baseUrl, apiKey, role: roleSel },
        calSnap: fixed, // 存下这一刻的样子：之后再手改协议，「已校准」章会自动作废
      });
      logLine(`✅ 校准完成（取到 ${results.length} 个结果），协议已盖「已校准」章 —— 点下方按钮一键保存并应用到模型配置`);
      toast("测试通过，协议已按真实响应校准 ✓", "ok");
    } catch (e) {
      logLine(`❌ ${errMsg(e)}`);
      toast(`测试失败：${errMsg(e)}`, "err");
    } finally {
      patch({ calBusy: false, ctrl: null });
    }
  };

  /** 校准通过后的一键衔接：保存协议 → 服务商槽位切到该协议 → 测试模型加进槽位（没有服务商则新建一个） */
  const saveAndApply = () => {
    const done = calDone;
    if (!done) return;
    try {
      const { proto: p } = validateProto(parseJsonLoose<CustomProtocol>(draft) ?? JSON.parse(draft));
      if (!p.id) p.id = uid(6);
      p.role = done.role;
      // 校准通过后又手改了协议 → 这份没测过，不能带着「已校准」章落地
      if (p.verifiedAt && (!calSnap || protoFingerprint(p) !== protoFingerprint(calSnap))) {
        delete p.verifiedAt;
        toast("协议在校准后被修改过，「已校准」标记已清除——建议重新跑一次测试", "info");
      }
      const list = settings.customProtocols;
      const idx = list.findIndex((x) => x.id === p.id);
      update("customProtocols", idx >= 0 ? list.map((x, k) => (k === idx ? p : x)) : [...list, p]);
      const role = done.role === "video" ? "video" : done.role === "audio" ? "audio" : "image";
      const roleLabel = role === "video" ? "视频" : role === "audio" ? "音频" : "绘画";
      if (done.providerId) {
        const prov = settings.models.providers.find((x) => x.id === done.providerId);
        if (!prov) throw new Error("测试时所用的服务商已被删除，请到「模型配置」手动选择该协议");
        const models = [...new Set([done.model, ...(prov.models[role]?.models ?? [])])];
        upsertProvider({ ...prov, models: { ...prov.models, [role]: { protocol: `custom:${p.id}`, models } } });
        toast(`协议「${p.name}」已保存，并应用到「${prov.name}」的${roleLabel}槽位（模型 ${done.model}）✓ 可直接使用`, "ok");
      } else {
        const host = done.baseUrl.replace(/^https?:\/\//i, "").split("/")[0] || "新服务商";
        upsertProvider({
          id: uid(8),
          name: host,
          baseUrl: done.baseUrl,
          apiKey: done.apiKey,
          models: { [role]: { protocol: `custom:${p.id}`, models: [done.model] } },
        });
        toast(`协议「${p.name}」已保存，并新建服务商「${host}」、配好${roleLabel}槽位（模型 ${done.model}）✓ 可直接使用`, "ok");
      }
      patch({ calDone: null, draft: "", calSnap: null });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const generate = async () => {
    if (!docs.trim()) {
      toast("先把中转站的接口文档 / 文档链接 / 示例请求粘贴到左边输入框", "err");
      return;
    }
    setBusy(true);
    try {
      // 文档里的 http 链接自动抓取正文一并交给模型（最多取前 2 个，跳过看起来是 API 端点的地址）
      const material = docs.slice(0, 24000) + (await fetchDocs(docs, 20000));
      const card = resolveModelCard("chat");
      const out = await chatOnce(card, protocolSystem(roleSel), material.slice(0, 48000));
      // 宽容解析：模型经常在 JSON 前后加一句说明或包代码块，硬 JSON.parse 会直接崩
      const parsed = parseJsonLoose<CustomProtocol>(out);
      if (!parsed) {
        toast(
          `模型没有返回可解析的协议 JSON。已把原始回复填进右侧编辑框，你可以手动修整；也可以补充更完整的接口文档（请求示例 + 响应示例）后重试`,
          "err",
        );
        patch({ draft: out.slice(0, 8000) });
        return;
      }
      // 类型/必填校验：能自动纠的（body 写成对象等）当场纠，纠不了的明说缺哪个，别等运行时才炸
      let proto: CustomProtocol;
      let warnings: string[] = [];
      try {
        ({ proto, warnings } = validateProto(parsed));
      } catch (err) {
        patch({ draft: JSON.stringify(parsed, null, 2) });
        toast(`协议草稿已生成，但有问题：${errMsg(err)}——已填进右侧编辑框，补齐后再保存`, "err");
        return;
      }
      const pr = proto.role;
      // 用途不再静默覆盖用户的选择：先按你在界面上选的走，助手判断不一致时提示你自己决定
      const conflict = pr !== roleSel;
      patch({ draft: JSON.stringify({ ...proto, role: roleSel }, null, 2) });
      const lab = (r: string) => (r === "video" ? "视频" : r === "audio" ? "音频" : "图片");
      toast(
        conflict
          ? `协议草稿已生成 ✓ 但助手判定这是「${lab(pr)}生成」接口，与你选的「${lab(roleSel)}生成」不一致——请在下方「协议用途」自行确认（草稿仍按你选的用途保存）`
          : warnings.length
            ? `协议草稿已生成 ✓ 需注意：${warnings.join("；")}`
            : `协议草稿已生成 ✓ 用途「${lab(roleSel)}生成」，请核对右侧 JSON 后保存`,
        conflict || warnings.length ? "info" : "ok",
      );
    } catch (e) {
      toast(`生成失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  /** 一键补全：让协议助手在不破坏现有字段的前提下，为草稿补上图片/蒙版占位符（参考左侧文档，可抓链接） */
  const completeDraft = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const material = docs.trim().slice(0, 20000) + (await fetchDocs(docs, 16000));
      const card = resolveModelCard("chat");
      const ask = (roleSel === "audio"
        ? [
            "下面是一份音频生成协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全朗读/音乐能力：",
            "1. body 的文本字段用占位符 {{prompt}}（朗读文本或音乐描述），字段名以参考文档为准（常见：input / text / prompt / lyrics）",
            "2. 若文档有音色/歌手/风格字段，用 {{voice}} 占位（常见：voice / voice_id / timbre）",
            "3. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹；resultPath 指向音频地址（常见：data.audio_url / audio_url / data[].url）",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
        : roleSel === "video"
        ? [
            "下面是一份视频生成协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全图生视频与参数能力：",
            "1. body 补首帧图片字段：占位符 {{image}}（dataURL 或 URL），字段名以参考文档为准（常见：image / image_url / image_urls / first_frame_image）",
            "2. 若文档显示支持首尾帧过渡，补尾帧字段用 {{image2}}（常见：image_tail / last_frame_image / lastFrame）",
            "3. 补生成参数占位符：{{duration}}（秒数）/ {{resolution}}（如 720p）/ {{aspect}}（如 16:9）/ {{audio}}（true/false），字段名按文档",
            "4. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹，保证不传图/不传参时请求体依然是合法 JSON",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
        : [
            "下面是一份已能跑通文生图的协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全图生图与蒙版能力：",
            "1. body 补图片字段：占位符用 {{images}}（数组，不加引号）或 {{image}}（单图 dataURL），字段名以参考文档为准；没有文档就按常见网关风格（如 image_urls）补",
            "2. 若文档显示支持蒙版/inpaint，补 {{mask}} 字段；文生图与图生图端点不同时，用条件块切换 url",
            "3. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹，保证不传图时请求体依然是合法 JSON",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
      ).concat([
        `\n当前协议：\n${draft}`,
        material ? `\n参考文档：\n${material}` : "\n（没有粘贴文档：按站点风格合理推断）",
      ]).join("\n");
      const out = await chatOnce(card, protocolSystem(roleSel), ask.slice(0, 48000));
      const parsed = parseJsonLoose<CustomProtocol>(out);
      if (!parsed) throw new Error("模型没有返回可解析的协议 JSON（可补充更完整的接口文档后重试）");
      const { proto, warnings } = validateProto(parsed);
      // 身份字段以当前草稿为准，模型不许改（改了会变成另一条协议、丢掉绑定）
      const cur = parseJsonLoose<CustomProtocol>(draft);
      if (cur?.id) proto.id = cur.id;
      proto.role = roleSel;
      delete proto.verifiedAt; // 模板变了就不再是那份测过的协议
      if (warnings.length) toast(`补全结果需注意：${warnings.join("；")}`, "info");
      patch({ draft: JSON.stringify(proto, null, 2) });
      toast(
        roleSel === "video"
          ? "已补全图生视频/尾帧/参数字段 ✓ 核对右侧 JSON → 保存 → 校准"
          : roleSel === "audio"
            ? "已补全朗读/音色字段 ✓ 核对右侧 JSON → 保存 → 校准"
            : "已补全图片/蒙版字段 ✓ 核对右侧 JSON → 保存 → 到下方「真实测试并校准」跑一遍",
        "ok",
      );
    } catch (e) {
      toast(`补全失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    try {
      const { proto: p, warnings } = validateProto(parseJsonLoose<CustomProtocol>(draft) ?? JSON.parse(draft));
      if (!p.id) p.id = uid(6);
      // 用途以界面选择为准（可纠正助手判断）
      p.role = roleSel;
      // 「已校准」是这条链路的信任锚点：内容改过就不能继续挂着上次那枚章
      if (p.verifiedAt && (!calSnap || protoFingerprint(p) !== protoFingerprint(calSnap))) {
        delete p.verifiedAt;
        warnings.push("协议内容与上次测试通过的版本不一致，「已校准」标记已清除，建议重新跑一次校准");
      }
      const list = settings.customProtocols;
      const i = list.findIndex((x) => x.id === p.id);
      update("customProtocols", i >= 0 ? list.map((x, k) => (k === i ? p : x)) : [...list, p]);
      const lab = p.role === "video" ? "视频" : p.role === "audio" ? "音频" : "图片";
      toast(
        warnings.length
          ? `协议「${p.name}」已保存（${lab}生成）。需注意：${warnings.join("；")}`
          : `协议「${p.name}」已保存（${lab}生成）——到「模型配置」里给服务商的${p.role === "image" ? "绘画" : lab}槽位选择「★ ${p.name}」即可使用`,
        warnings.length ? "info" : "ok",
      );
      patch({ draft: "", calSnap: null });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">协议</div>
        <div className="set-page-d">
          遇到不是 OpenAI 兼容的中转站（比如异步任务式生图/生视频）？把它的接口文档或文档链接粘贴给「协议助手」，由你配置的对话模型分析生成协议；核对用途并保存后，就能在「模型配置」对应槽位的协议下拉里选用。协议也可以手写 / 修改 JSON。
        </div>
      </div>
      {/* 卡 1：协议管理 —— 自愈开关 / 中转站预设 / 已保存协议 */}
      <div className="proto-card">
        <div className="proto-card-title">协议管理</div>
        <div className="proto-switch-row">
          <Switch on={settings.protoSelfHeal} onChange={(v) => update("protoSelfHeal", v)} />
          <div className="proto-switch-txt">
            <b>协议自愈</b>
            <div className="proto-hint">
              自定义协议运行失败时，自动把报错与执行现场（真实请求/响应，密钥已脱敏）交给对话模型修协议并重试一次；
              重试成功才写回保存，失败自动回滚不留坏协议。网络/鉴权/额度类错误不触发（修协议没用）。重试会产生一次生成费用。
            </div>
          </div>
        </div>

        <div className="proto-sub">常用中转站预设（一键导入 / 修复）</div>
        <div className="preset-list">
          {PROTO_PRESETS.map((pp) => (
            <div key={pp.key} className="preset-row" title={`${pp.label}\n\n${pp.note}`}>
              <div className="pr-info">
                <b>{pp.label}</b>
                <span>{pp.note}</span>
              </div>
              <button
                className="btn sm primary"
                title="若匹配的服务商已绑定自定义协议：原地覆盖修复（绑定不变）；否则新建协议并自动绑定"
                onClick={() => toast(applyProtoPreset(pp), "ok")}
              >
                导入 / 修复
              </button>
            </div>
          ))}
        </div>
        <div className="proto-hint">预设按官方文档校对过图片/蒙版字段格式。导入后建议先跑一次下方「测试与校准」卡片的真实测试再上画布。</div>

        {settings.customProtocols.length ? (
          <>
            <div className="proto-sub">已保存的协议</div>
            <div className="proto-chips">
              {settings.customProtocols.map((p) => (
                <span
                  key={p.id}
                  className="pe-chip"
                  title={`${p.role === "video" ? "视频生成" : p.role === "audio" ? "音频生成" : "图片生成"} · ${p.taskIdPath ? "异步轮询" : "同步"} · ${
                    p.verifiedAt ? `已于 ${new Date(p.verifiedAt).toLocaleString()} 真实测试通过` : "还没跑过真实测试（建议先到下方「测试与校准」验证）"
                  } · 点 × 删除`}
                >
                  {p.role === "video" ? "视频 · " : p.role === "audio" ? "音频 · " : "图片 · "}
                  {p.name}
                  {p.verifiedAt ? " ✓" : ""}
                  <button
                    onClick={() => patch({ draft: JSON.stringify(p, null, 2), roleSel: p.role, calSnap: p })}
                    title="编辑"
                    aria-label="编辑"
                  >
                    <IcEditSmall />
                  </button>
                  <button
                    onClick={() => update("customProtocols", settings.customProtocols.filter((x) => x.id !== p.id))}
                    aria-label="删除"
                  >
                    <IcClose size={11} />
                  </button>
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {/* 卡 2：编辑协议 —— 左栏粘贴文档 / 右栏 JSON（窄窗口折单列） */}
      <div className="proto-card">
        <div className="proto-card-title">编辑协议</div>
        <div className="proto-hint">把中转站的接口文档粘贴到左侧，由「协议助手」分析生成协议 JSON；也可以在右侧直接手写或修改。</div>
        <div className="proto-cols">
          <div className="proto-col">
            <div className="proto-sub">接口文档 / 文档链接 / 示例请求</div>
            <textarea
              className="textarea proto-doc"
              placeholder={
                "把中转站的 API 文档、curl 示例、请求/响应 JSON 粘贴到这里…\n也可以直接粘贴 API 文档的网址链接，会自动抓取页面内容分析。\n信息越全，生成的协议越准。"
              }
              value={docs}
              onChange={(e) => patch({ docs: e.target.value })}
            />
            <button className="btn primary" disabled={busy} onClick={() => void generate()}>
              {busy ? <IcLoading size={16} /> : <IcSparkles size={16} />} 让协议助手分析生成
            </button>
          </div>
          <div className="proto-col">
            <div className="proto-json-head">
              <span className="proto-sub">核对 / 手动编辑协议 JSON</span>
              <button
                className={`proto-vars-toggle ${varsOpen ? "on" : ""}`}
                title="展开当前用途可用的占位符清单（点击复制）"
                onClick={() => setVarsOpen((v) => !v)}
              >
                <IcChevronD size={12} /> 占位符参考
              </button>
            </div>
            {varsOpen ? (
              <div className="proto-var-chips">
                {varList(roleSel).map((v) => (
                  <button key={v.name} className="proto-var-chip" title={`${v.desc}（点击复制）`} onClick={() => copyVar(v.name)}>
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              className="textarea proto-json"
              placeholder={
                "协议 JSON 会出现在这里，也可以直接手写。\n占位符见上方「占位符参考」（随协议用途切换，点击复制）。\n提示：要支持图生图/局部重绘，body 里必须写上图片/蒙版字段，否则图片不会发给模型"
              }
              value={draft}
              onChange={(e) => patch({ draft: e.target.value })}
            />
            {/* 通用体检：缺 {{prompt}} 或占位符名字拼错——这两条不会报错，只会静默出一张与输入无关的图 */}
            {(() => {
              if (!draft.trim()) return null;
              const p = parseJsonLoose<CustomProtocol>(draft);
              if (!p?.submit?.url) return null;
              const msgs: string[] = [];
              try {
                if (!placeholdersIn(p).has("prompt")) msgs.push("模板里没有 {{prompt}}，提示词发不出去（会照样扣费，出一张与输入无关的结果）");
                const unk = unknownPlaceholders(p);
                if (unk.length) msgs.push(`有应用不认识的占位符 ${unk.map((k) => `{{${k}}}`).join(" ")}，运行时会被渲染成空串（多半是名字拼错）`);
              } catch {
                return null;
              }
              return msgs.length ? (
                <div className="proto-hint warn row">
                  <IcWarn size={13} />
                  <span>{msgs.join("；")}</span>
                </div>
              ) : null;
            })()}
            {/* 能力体检：保存前就把「只能文生图/没有真蒙版」讲清楚，并给出一键修复入口 */}
            {roleSel === "image" && draft.trim() ? (
              !["{{image}}", "{{images}}", "{{image2}}"].some((k) => draft.includes(k)) ? (
                <div className="proto-hint warn row">
                  <IcWarn size={13} />
                  <span>模板没有图片占位符（{"{{image}} / {{images}}"}）：该协议只能<b>文生图</b>，接了参考图会直接报错。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全图生图/蒙版
                  </button>
                </div>
              ) : !draft.includes("{{mask}}") ? (
                <div className="proto-hint row">
                  <IcBulb size={13} />
                  <span>模板不含 {"{{mask}}"}：可以图生图，但「真蒙版」重绘不可用（节点上切「指令式」也能重绘）。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全蒙版
                  </button>
                </div>
              ) : (
                <div className="proto-hint ok row">
                  <IcCheck size={13} />
                  <span>模板含图片与蒙版占位符：文生图 / 图生图 / 真蒙版重绘均可用。</span>
                </div>
              )
            ) : null}
            {roleSel === "video" && draft.trim() ? (
              !draft.includes("{{image}}") ? (
                <div className="proto-hint warn row">
                  <IcWarn size={13} />
                  <span>模板没有首帧占位符（{"{{image}}"}）：该协议只能<b>文生视频</b>，接上游图片不会生效。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全图生视频/尾帧/参数
                  </button>
                </div>
              ) : !draft.includes("{{image2}}") ? (
                <div className="proto-hint row">
                  <IcBulb size={13} />
                  <span>模板不含尾帧 {"{{image2}}"}：首尾帧过渡不可用（接 2 路图时第 2 路会被忽略）。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全尾帧/参数
                  </button>
                </div>
              ) : !["{{duration}}", "{{resolution}}", "{{aspect}}"].some((k) => draft.includes(k)) ? (
                <div className="proto-hint row">
                  <IcBulb size={13} />
                  <span>模板不含 {"{{duration}} / {{resolution}} / {{aspect}}"}：面板上的时长/分辨率/比例设置不会生效。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全参数
                  </button>
                </div>
              ) : (
                <div className="proto-hint ok row">
                  <IcCheck size={13} />
                  <span>模板含首帧/尾帧/参数占位符：文生视频 / 图生视频 / 首尾帧 / 面板参数均可用。</span>
                </div>
              )
            ) : null}
            {roleSel === "audio" && draft.trim() ? (
              !draft.includes("{{voice}}") ? (
                <div className="proto-hint row">
                  <IcBulb size={13} />
                  <span>模板不含 {"{{voice}}"}：音色/歌手/风格选择不会生效（只能用服务商默认音色）。</span>
                  <button className="btn sm" disabled={busy} onClick={() => void completeDraft()}>
                    {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全音色字段
                  </button>
                </div>
              ) : (
                <div className="proto-hint ok row">
                  <IcCheck size={13} />
                  <span>模板含 {"{{prompt}}"} 与 {"{{voice}}"}：朗读文本与音色都能下发。</span>
                </div>
              )
            ) : null}
            <div className="proto-role-row">
              <span className="proto-sub" title="决定该协议出现在哪个模型槽位、结果按图片还是视频处理">
                协议用途
              </span>
              <div className="proto-seg">
                <button className={roleSel === "image" ? "on" : ""} onClick={() => patch({ roleSel: "image" })}>
                  <IcGallery size={13} /> 图片生成
                </button>
                <button className={roleSel === "video" ? "on" : ""} onClick={() => patch({ roleSel: "video" })}>
                  <IcVideo size={13} /> 视频生成
                </button>
                <button className={roleSel === "audio" ? "on" : ""} onClick={() => patch({ roleSel: "audio" })}>
                  <IcMusic size={13} /> 音频生成
                </button>
              </div>
              <span className="proto-spacer" />
              <button className="btn primary" disabled={!draft.trim()} onClick={save}>
                <IcCheck size={16} /> 校验并保存协议
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 卡 3：测试与校准 —— 真实跑一次协议，把结果路径从「猜」改成「量」 */}
      <div className="proto-card">
        <div className="proto-card-title">测试与校准</div>
        <div className="proto-hint">
          <b>真实调用一次</b>该协议（生成类接口会产生一次费用），程序在真实响应里定位任务
          ID、状态、结果字段的实际位置，自动把协议里写错的路径改成实测值。
          可以借已有服务商的 Key，也可以选「手动输入」直接填 Base URL / Key（还没建服务商也能先测协议）。
          测试在后台运行：切到其他页面不会中断，日志保留在这里，也可以随时停止。
        </div>
        <div className="proto-cal-row">
          <PopSelect
            className="proto-w-prov"
            triggerIcon
            title="借用服务商的 Key"
            value={selProvider}
            options={[
              ...providers.map((p) => ({ value: p.id, label: p.name, icon: <IcGlobe size={14} /> })),
              { value: MANUAL, label: "手动输入 Base URL / Key…", icon: <IcGear size={14} /> },
            ]}
            onChange={(v) => pickProvider(v)}
          />
          {manual ? (
            <>
              <input
                className="input proto-w-base"
                placeholder="Base URL（如 https://api.xx.com/v1）"
                value={manualBase}
                onChange={(e) => patch({ manualBase: e.target.value })}
              />
              <input
                className="input proto-w-key"
                type="password"
                placeholder="API Key"
                value={manualKey}
                onChange={(e) => patch({ manualKey: e.target.value })}
              />
            </>
          ) : null}
          <input
            className="input proto-w-model"
            placeholder="测试用模型名（如 gpt-image-2）"
            value={testModel}
            onChange={(e) => patch({ testModel: e.target.value })}
          />
          <button
            className="btn primary"
            disabled={calBusy || !draft.trim()}
            title="真实发起一次生成请求（有费用），并按真实响应校准协议 JSON"
            onClick={() => void runCalibrate()}
          >
            {calBusy ? <IcLoading size={15} /> : <IcCheck size={15} />} {calBusy ? "测试中…" : "真实测试并校准"}
          </button>
          {calBusy ? (
            <button className="btn" onClick={() => ctrl?.abort()} title="停止等待/轮询（已发出的提交请求所产生的费用无法撤回）">
              停止测试
            </button>
          ) : null}
        </div>
        {calLog.length ? (
          <div className="cal-log">
            {calLog.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        ) : null}
        {calDone && !calBusy ? (
          <div className="proto-apply-row">
            <button className="btn primary" onClick={saveAndApply}>
              <IcCheck size={15} />{" "}
              {calDone.providerId
                ? `保存协议并应用到「${providers.find((p) => p.id === calDone.providerId)?.name ?? "服务商"}」`
                : "保存协议并新建服务商"}
            </button>
            <span className="proto-hint">
              一键衔接：保存已校准协议 → {calDone.providerId ? "该服务商" : "新服务商"}的
              {calDone.role === "video" ? "视频" : calDone.role === "audio" ? "音频" : "绘画"}槽位切到此协议 → 模型 {calDone.model} 加入槽位，配完即可用
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
