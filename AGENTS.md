# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目

MOMO 智能画布：Tauri 2 (Rust 壳) + React 19 + TypeScript + React Flow (@xyflow/react) + Zustand 的桌面 AI 创作工作站。单一画布范式——图片、提示词、生图、生视频、ComfyUI 工作流都是画布节点，连线即工作流；对话/Agent/语音收在右侧「创作助手」侧栏。UI 文案、代码注释、commit message 全部使用中文。

## 常用命令

```bash
pnpm tauri dev      # 开发运行（Vite 固定端口 1420，被占用会直接失败）
npx tsc --noEmit    # 类型检查（最常用的验证手段；本项目无测试、无 lint 配置）
pnpm build          # tsc && vite build，仅前端产物，可作完整验证
pnpm tauri build    # 打包发行版 —— 仅在用户明确要求时执行
```

开发闭环：`.Codex/settings.json` 配置了 Stop hook（`.Codex/hooks/restart-app.ps1`），每轮结束时自动确保 dev 应用在跑（健康实例不会被杀，Vite HMR / tauri dev 自身热更新即可生效；日志在 `.Codex/dev-server.log`）。**不要手动启动 `pnpm tauri dev`**，改完代码结束回合即可看到效果。

## 架构（分层，依赖只向下）

```
src/core/types.ts       全部共享类型的唯一来源：节点 data、设置（含历次迁移的 Legacy 类型）、资产、ComfyUI 模板、快捷键
src/core/stores/        Zustand stores；React 外部一律用 useX.getState() 访问
src/core/services/      纯协议适配层：吃 ModelCard + 请求参数，吐结果，不碰 store
src/core/runner.ts      节点运行引擎：收集上游 → 调 service → 结果写回节点 + 收录资产库
src/core/agentEngine.ts 创作助手引擎：聊天（多轮 + 前情摘要压缩）与 Agent（JSON 动作协议循环）
src/core/voiceChat.ts   语音通话状态机：录音 VAD 断句 → ASR → 助手 → TTS → 自动续听（可插话打断）
src/core/modelMeta.ts   绘画家族参数推断 + 对话模型能力（vision / builtinSearch）
src/modules/            React UI（canvas / agent / assets / charlib / shell / settings / comfy）
src/ui/                 手绘 SVG 图标集 icons.tsx、轻组件 kit.tsx、ModelPicker、PopSelect/PopLayer、Thumb
src/styles/theme.css    三主题设计令牌（云白/深空蓝/深邃黑），样式只用 var(--token)
src-tauri/              Rust 壳，仅插件配置（dialog/fs/http/store/opener + asset 协议），无自定义命令
```

### 数据流转（读懂 runner.ts 即读懂本项目）

- **端口已统一**：任意输出可接任意输入，实际传什么由源节点的 `outPortType` 决定；连线只拦重复边与成环（`wouldCycle`，已含组成员隐式边）。
- `collectUpstream(nodeId)` 递归收集直接前驱的输出；防环用**当前 DFS 路径**（进入 add、返回 delete），不是全局已访问集——同一上游被两条路径引用是正常拓扑。
- 组节点按成员位置排序聚合；`data.ignored` 的节点不向下游传递；角色卡按勾选素材展开多图（`collectImageRefsFor` 与 `collectUpstream` 必须同序，否则 @图N 编号错位）。
- 生成节点提示词留空时自动取上游文本；连了上游图片自动转图生图。
- 节点上的「生成/运行」按钮统一走 `runFlow(id)`：DFS 后序把上游可运行节点按依赖顺序先跑一遍再跑自己；`runAllFlows()` 按连通分量并行、分量内串行。可自动运行的节点类型登记在 `RUNNERS` 表。

### 模型配置（改动设置结构必看）

- `ProviderCard`（服务商卡片）：一个 Base URL + API Key，含 **chat / image / video / audio / asr 五个** `RoleSlot`，每槽 `models: string[]` 多模型。
- 节点/默认选模用复合键 **`providerId::model`**（`modelKey` / `splitModelKey`），旧数据可能只有 providerId。
- 服务层只消费扁平化的 `ModelCard`，入口是 `resolveModelCard(role, key?)`：节点指定 > 角色默认 > 第一家可用，无可用时抛中文提示。
- 设置结构已历经 v1→v2→v3→v4 迁移（Legacy 类型都在 types.ts）。**改 Settings 结构必须同步加迁移**，加载路径是 settingsStore 的 `normalize()`。
- `modelMeta.ts` 按模型名推断生图「家族」（banana / gpt / seedream / flux / qwen / kolors / generic），决定 GenConfigPanel 展示哪组参数、runner 发哪些字段。
  - ⚠️ 家族判定**只看模型名**，中转站以 OpenAI 兼容协议提供 nano-banana / gemini-image 很常见：此时 `aspect`/`resolution` 只有原生 gemini 分支会读，`imageGen.genOpenAI` 里必须把 aspect 折算成 `size`，否则一律回落 1024×1024 出方图。
  - `chatCaps(card)` 推断对话模型的**视觉输入**与**自带联网**能力；`builtinSearchTools(model)` 产出各家 tools 请求体，两者必须一致（自带联网以能否真的构造出 tools 为准）。

### 新增节点类型的完整清单

1. `types.ts`：加 `NodeKind` 成员 + `XxxData` 类型（必含 `status` / `error`）
2. `boardStore.ts`：`defaultData` / `outPortType` / `NODE_INPUTS` / `NODE_LABEL`
3. `nodeCatalog.tsx`：加入 `NODE_CATALOG`（添加坞/快速菜单共用）
4. `nodes/XxxNode.tsx`：用 `NodeShell` 包裹、`memo` 导出，在 `SmartCanvas.tsx` 的 nodeTypes 注册
5. 可运行的：`runner.ts` 加 `runXxx` 并登记进 `RUNNERS`

### 自定义协议链路（customProto / protoCalibrate / protoSelfHeal / protoSpec）

声明式协议（设置 → 协议）跑「模板渲染 → 提交 → 可选轮询 → 路径取结果」，四个文件分工：`customProto.ts` 执行、`protoCalibrate.ts` 真发一次请求把路径从"猜"变成"量"、`protoSelfHeal.ts` 失败后让 AI 改协议、`protoSpec.ts` 是**占位符总表 + 协议 JSON 校验的唯一来源**。

- **新增占位符只改 `protoSpec.ts`**：`ROLE_VARS` 一处登记，`varsDoc(role)` 会同时喂给协议助手（`protocolSystem`）与自愈（`repairSystem`）。
- **协议 JSON 一律过 `validateProto`**（生成 / 保存 / 校准 / 自愈 / 报错中心一键修复五个入口）：LLM 最常见的畸形是把 `submit.body` 写成对象而非字符串模板，不拦就会以 `tpl.replace is not a function` 这种原生 TypeError 糊给用户。
- **省钱优先**：`SKIP_PATTERNS` 要挡住「钱已经花了」的错误（轮询超时 / 任务失败 / 5xx），自愈只在 `reparse`（用修好的路径重读同一份响应）救不回来时才重发；并发失败按协议 id 去重，只有 leader 能重发。
- **校准的假阳性最致命**：`findResult` 必须排除 `status_url` 一类的轮询地址与回显的测试图（`echoes`），完成判定要「结果 + 状态」双确认——否则会把异步协议判成同步、把 `processing` 写成 `doneValue`，还照样盖「已校准 ✓」章。
- 「已校准」章随内容失效：保存时用 `protoFingerprint` 与 `calSnap`（校准那一刻的快照）比对，改过就清掉 `verifiedAt`。

## 关键约定

- **报错**：service 层抛带中文信息的 `Error`；runner 捕获后走 `pushError(source, msg)`（uiStore）→ 报错中心（标题栏铃铛）+ 可点击 toast。不要裸 `toast(..., "err")` 报运行类错误。
- **节点内大图必须用 `<Thumb>`**（`src/ui/Thumb.tsx`）而非 `<img>`：图片全程是 dataURL，原图直塞 img 会让画布拖动掉帧；原图仅用于灯箱预览/保存/传模型。
- **参数浮层与底部栏样式必须隔离**：`NodeParamsPop` Portal 到 `document.body`，只能使用 `.gd-param-pop/.gp-scope` 作为参数内容作用域，禁止给浮层附加 `.gen-panel`（该类含底部绝对定位，会导致浮层二次偏移、留白和裁切）。浮层宽度应由内容类控制，并保留 `max-width: calc(100vw - …)` 的视口兜底。
- React Flow 节点内的可交互元素加 `nodrag` class，否则拖不了输入框选不了文本。
- 持久化走 `persist.ts` 的 `loadJSON/saveJSON`：Tauri 下是 tauri-plugin-store（AppData JSON），纯浏览器预览退回 localStorage。`isTauri` 判定环境——所有功能需兼容浏览器预览模式（降级即可，不能白屏）。
- 网络请求用 `services/http.ts` 的 `xfetch`（Tauri plugin-http 绕 CORS，浏览器退回 fetch）。
- 中转站返回格式五花八门：imageGen 的 `normalizeResults` 做了大量兼容解析，改动时保持宽容。
- **资产多结果必须成组收录**：同一次生成返回 2 张及以上时，为 `AssetItem` 写同一个 `groupId`，并用稳定的 `groupSlot` 标识组内位置；电商长图的切片与最终长图共用一组，最终图设 `groupCover`，单片重生沿用原 `groupSlot` 以替换旧资产。资产库列表只渲染一张叠卡，点击后在灰色聚焦层临时展开组成员。
- 画布载入时 `sanitizeNodes(nodes)` 会把上次退出时 `running` 的节点标成中断错误（`INTERRUPTED_MSG`），不能静默重置；**切换画布**走 `sanitizeNodes(nodes, false)`——本会话仍在跑的任务不能标中断，`updateData` 会把结果写回它所属的那张画布。
- `persist()` 的落盘带**序号守卫**（`saveSeq`）：externalize 是异步深走，慢的旧快照不能覆盖新快照。
- 拖动吸附：`onNodesChange` 里算出的偏移要缓存到 `lastSnap`，松手那次 `dragging:false` 的 position 变更必须补上同样的偏移，否则节点弹回未吸附坐标。
- 撤销/重做快照、贴近自动连线、防环（`wouldCycle`）都在 boardStore，改节点/边操作时留意是否需要入历史。
- 新图标手绘 SVG 加进 `src/ui/icons.tsx`，不引第三方图标库。
- 光晕/描边等颜色一律用 `color-mix(in srgb, var(--accent) N%, transparent)`，不要硬编码 `rgba(91,140,255,…)`——黑主题的强调色是暖橙，硬编码会出现橙边配蓝光。
- 新增快捷键：`types.ts` 的 `HotkeyAction` + `HOTKEY_LABEL` + `DEFAULT_HOTKEYS` 三处同步，`normalize()` 的 `{ ...DEFAULT_HOTKEYS, ...(v.hotkeys ?? {}) }` 会自动给老用户补默认值；再在 SmartCanvas 的 keydown 分支里接线，并加进 SettingsDialog 的 `HOTKEY_GROUPS`。

## 图片处理（本项目专用）

我（GLM-5.2）本身没有视觉模块，看不到用户发的图片。处理含图需求时遵循：

- 用户发图后，先调图片分析 MCP 工具（`mcp__zai-mcp-server__analyze_image` 或 `mcp__4_5v_mcp__analyze_image`）拿一段文字描述，作为大致参考——但这是工具的转述，不是原图。
- 两个绕不开的坑：① 工具描述会**失真**（颜色/位置/元素经常不准），不能当 ground truth；② 图片 URL 带**签名时效**（Expires），过一阵工具调会 400，要趁早调。
- 涉及**精确视觉位置**（红框框哪、按钮排布、贴边与否等 UI 改动）：基于工具描述 + 代码常识给出"我理解是 XX"，**先和用户核对一句再改**，不闷头改完让用户返工。
- 工具失败或没把握时，直接请用户用文字点一下关键元素，基于代码定位改动。

### 创作助手 / 语音（agentEngine.ts + voiceChat.ts）

- Agent 走「每次回复只输出一个 JSON 动作」的纯文本协议（search / ask / image / video / reply），不依赖 function calling。
- **画幅必须自己兜底**：模型经常漏填 `aspect`/`resolution`，`agentLoop` 的解析顺序是「本轮已确认规格 > 动作字段 > 提示词措辞 > 用户对话原话」，全都没有就强制 ask 一轮再生成。
- 聊天模式的上下文：最近 10 条原样带，更早的每积 8 条压缩成「前情摘要」；压缩带 `epoch` 守卫，清空对话会作废在途的旧摘要。
- 语音通话是**轮流对讲**（VAD 断句 + 请求/响应 + TTS），不是实时双工；需要 `asr` 角色模型，`audio` 角色可选（没配就只做语音输入不朗读）。

## 其他

- 包管理器是 **pnpm**。数据/密钥存本机 AppData（`site.jinpengi.momo`），API Key 明文，不要提交任何真实 Key。
- 产品路线图（未完成事项）维护在 README.md「路线图」一节。
