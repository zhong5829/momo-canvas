# MOMO「导演台 + Skill + ComfyUI 分支」产品与技术方案

> 文档状态：可进入开发拆解  
> 适用项目：MOMO 智能画布  
> 编写日期：2026-08-11  
> 首个验证模型：本地 ComfyUI + MiniMax H3；产品设计必须支持 Seedance 2.0、其他中转站和后续模型  
> 全局扩展：可上传 Skill、ComfyUI 工作流分支与二级菜单

## 1. 结论

“导演台”可以实现，而且与 MOMO 现有的画布、ComfyUI 模板、分镜、视频生成、资产库和视频拼接能力高度契合。

在导演台之外，本方案再增加三个全局基础能力：

- **MOMO Skill**：用户可上传创作规则包，让提示词、导演台镜头、海报排版、电商图和 Agent 按指定规范自动完善、编排与校验。
- **ComfyUI 工作流分支**：一个工作流文件可以拆成多个可命名、着色、单独运行的子工作流，并在 ComfyUI 节点中以“主菜单 → 子菜单”选择。
- **本地模型运行时**：通过 Ollama 或 llama.cpp 直接调用本机 GGUF 对话/视觉模型，用于剧本分析、Skill、提示词优化和私密对话，不依赖 ComfyUI 插件。

四者不是四个孤立功能：本地模型运行时负责私密分析与文本编排，Skill 负责“如何写、如何排、遵守什么规则”，ComfyUI 分支负责“具体运行哪条模型管线”，导演台负责“把它们组织进一集视频的生产流程”。

但它不应该被实现成一个塞满几十个控件的普通节点，也不应该在第一版就做成完整的 Premiere、Blender 或 ComfyUI 替代品。建议采用下面的产品定位：

- 画布上的“导演台”是一个**项目级复合节点**。一个导演台默认对应一条短片、一集或一个广告项目。
- 节点卡片只展示项目摘要、完成度、当前成片和“进入导演台”按钮。
- 点击后进入全屏工作台，在同一处完成脚本拆分、分镜、素材绑定、生成排队、版本挑选、故事串片预演、音频准备和剪辑交付。
- 导演台不复制 ComfyUI 工作流，而是把工作流包装成“普通创作者能理解的语义槽位”，例如“首帧”“尾帧”“角色参考 1”“动作参考视频”。
- 首版先打通最有价值的闭环：**剧本 → 片段与镜头 → 分镜静帧/首尾关键帧 → 精准喂给本地或远程配方 → 多版本挑片 → 缺片/连续性检查 → 顺序预演与剪辑交付**。
- H3 只是首个验证配方，不是导演台的专属模型。相同片段可选择本地 ComfyUI、Seedance 2.0 中转站或其他第三方视频模型，并在保留分镜和版本历史的情况下更换引擎。
- 导演台必须支持“生成所选 / 生成缺失 / 生成已修改 / 重试失败”的批量队列，用户不需要逐镜点击运行。
- 3D 导演台作为后期阶段加入，先做站位、机位、姿势和行动路径的预演，不在首版实现专业级骨骼动画、建模或材质系统。
- Skill 第一版只允许声明式指令、模板、变量和校验规则，不执行用户上传的 JavaScript、Python 或 shell，避免桌面端任意代码风险。
- ComfyUI 分支使用“保留节点白名单 + 依赖闭包”运行，不能复用逐节点忽略时的自动跨接作为分支切换机制。

最重要的设计决定是：**以“剧集—片段—镜头—版本”管理创作，而不是以一次次模型请求管理创作。**

## 2. 为什么现在适合做

MOMO 已有以下基础，不需要从零开始：

- ComfyUI API 工作流导入、模板管理、参数暴露、图片/视频上传、执行前 `object_info` 校验和 WebSocket 进度。
- 故事完善、分镜拆解、逐镜提示词输出和一键铺生成节点。
- 视频生成、首尾帧、参考图、视频取段、拼接、配音、资产落盘和生成历史。
- 画布切换后仍能把异步结果写回任务所属画布。

当前真正缺少的是一层“制片管理”：素材到底属于哪一镜、哪一次生成是选中的、哪个工作流该接哪个输入、全片完成了多少、失败后从哪里继续、最终按什么顺序拼起来。

截至 2026-08-11，ComfyUI 官方已经提供 MiniMax H3 的本地工作流说明。H3 原生覆盖 T2V、I2V、首尾帧 I2V 和多参考 R2V，并可在同一上下文中使用文本、图片、视频和音频参考；R2V 的参考素材还要求按实际连接顺序用 `<Picture 1>`、`<Video 1>`、`<Audio 1>` 标记。这正说明“按语义绑定并固定顺序”比“按 ComfyUI 节点编号猜测顺序”更重要。参考：[ComfyUI MiniMax H3 官方工作流](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)。

## 3. 竞品启发与 MOMO 的差异化

### 3.1 可借鉴的产品结构

- LTX Studio 把一个项目下的生成空间、Storyboard、Timeline 和资产连接起来，并支持针对单个镜头 Retake。值得借鉴的是“项目上下文不断裂”和“旧版本不覆盖”；不必照搬其所有编辑能力。参考：[LTX AI Movie Maker](https://ltx.io/studio/platform/ai-movie-maker)、[LTX Projects](https://ltx.io/blog/introducing-projects)。
- Katalist 强调从脚本拆分场景和镜头，再编辑景别、视角与构图。值得借鉴的是分镜表中直接呈现导演语言，而不只是一个大段提示词。参考：[Katalist 完整视频工作流](https://help.katalist.ai/en/articles/10643422-how-to-make-complete-ai-videos-with-katalist-full-tutorial)。
- Autodesk Flow Studio 强调可控的 CG 场景、角色动作和摄影机，而不是把 AI 当作不可解释的黑盒。值得借鉴的是“先做空间预演，再让 AI 渲染”，但 MOMO 首先只需做轻量 3D blocking。参考：[Autodesk Flow Studio](https://www.autodesk.com/products/flow-studio/overview)。

### 3.2 MOMO 应该形成的差异化

- 本地优先：可直接使用用户自己的 ComfyUI、模型、LoRA 和定制工作流。
- 模型无关：同一镜头可从 H3 本地工作流切换到第三方视频 API，而不破坏分镜和时间线结构。
- 工作流语义化：用户面对的是“首帧、尾帧、角色、动作、音色”，不是 `#137 LoadImage`。
- 画布互通：角色卡、风格图、已有视频、音频、提示词都能拖入导演台，也能把导演台的选定结果输出回画布。
- 可恢复：生成队列、失败原因、历史版本和已选成片都能跨重启恢复。

## 4. 产品边界

### 4.1 首版要解决的问题

1. 导入不同的 ComfyUI 工作流后，素材可以精准写入指定节点输入。
2. 长故事能按目标成片时长和模型单次时长拆成可编辑的片段与分镜。
3. 文生图、图生图可先生成分镜静帧、首帧和尾帧，再交给视频配方；图片和视频都能单独生成、取消、重试和保留多个版本。
4. 用户明确选中的版本进入故事顺序，可硬切连播并检查缺片、时长和剧情连续性；精细裁切和正式剪辑交给外部剪辑软件。
5. 所有生成结果进入资产库，同时保持“属于哪一集、哪一镜、哪一版”的关系。

### 4.2 首版明确不做

- 不做完整多轨 NLE：导演台只做故事串片预演与标准化交付，不做复杂转场、关键帧特效、专业调色、遮罩和剪辑插件系统。
- 不做 ComfyUI 可视化编辑器替代品：工作流仍在 ComfyUI 制作，MOMO 只负责导入、语义绑定和运行。
- 不嵌入或实时操纵 ComfyUI 画布：MOMO 只连接用户本机服务，完成健康检查、提交任务、读取状态和回收结果；需要改拓扑时在外部 ComfyUI 中打开。
- 不自动修改用户工作流拓扑：除已有的安全图片入口注入外，导演台首版只写入已经确认的目标；工作流不匹配时明确报错。
- 不做专业 3D DCC：不在首版提供建模、权重涂抹、复杂 IK、材质节点或布料模拟。
- 不默认“一键生成整集”：视频生成成本和本地显存压力都很高，必须由用户显式选择镜头后启动。

## 5. 核心概念

不要把“15 秒片段”和“分镜”混为一谈。推荐的数据层级如下：

```text
导演项目 Project
└─ 场 Scene：同一地点、时间和戏剧事件
   └─ 生成片段 Segment：一次视频模型任务，目标通常不超过 15 秒
      └─ 镜头 Shot：片段内的景别、机位或剪辑变化，可有 1～3 个
         └─ 版本 Take：同一分镜图、关键帧或视频片段的第 1 次、第 2 次……生成结果
```

这里的 `Segment` 是生成和剪辑管理的最小单元，`Shot` 是提示词里的导演结构。H3 支持在一个提示词块中描述分时镜头、摄影机和声音，因此一个 15 秒 Segment 不必机械等于一个镜头。

默认规则：

- 2 分钟成片按 15 秒上限会得到至少 8 个 Segment。
- 3 分钟成片按 15 秒上限会得到至少 12 个 Segment。
- 如果剧情节奏要求更短，允许产生 4 秒、6 秒、10 秒等片段，不为了凑满 15 秒破坏节奏。
- 模型能力是动态约束。切换模型或工作流后，片段上限、帧率、分辨率和参考素材容量随“生成配方”变化，不能把 15 秒写死在项目数据里。

## 6. 总体交互设计

### 6.1 画布节点

节点名称：`导演台`

建议卡片宽度约 360～400 px，内容只保留：

- 项目名与画幅，例如“第 1 集 · 16:9”。
- 总时长、片段数和完成度，例如“02:00 · 8 段 · 已选片 5/8”。
- 当前状态：待拆分、生成中、待选片、可导出、导出失败。
- 当前成片封面或时间线叠卡缩略图。
- 主按钮“进入导演台”。
- 有成片时提供预览、保存和视频输出口。

输入口接受文本、图片、视频和音频：

- 文本：故事、剧本、风格说明。
- 图片：角色、场景、首帧、尾帧、站位图、风格参考。
- 视频：动作、运镜、已有片段。
- 音频：角色声音、配乐、音效参考。

输出口始终是视频，输出当前时间线导出的成片；尚未导出时不向下游传值。

导演台首版**不登记到 `RUNNERS`**，避免用户点击“全部运行”时意外生成整集并产生大量计费或显存任务。所有批量生成必须在导演台内二次确认。

### 6.2 全屏工作台

建议使用五个顶层页签：

1. **脚本**：故事导入、目标时长、结构分析、片段拆分。
2. **分镜**：片段卡片、镜头细节、角色/场景一致性、首尾帧规划。
3. **生成**：分镜静帧、首尾关键帧、语义素材槽、视频生成配方、任务队列和多版本挑片。
4. **成片检查**：已选版本顺序、缺片/时长/连续性提示、硬切预演、音频准备与剪辑交付；不是多轨剪辑器。
5. **3D 站位**：角色站位、预设姿势、简单行动路径、机位和控制图导出；后期阶段开放。

通用布局：

```text
┌ 左侧结构树 ┬──────── 中央主工作区 ────────┬ 右侧检查器 ┐
│ 场/片段列表 │ 分镜卡 / 大预览 / 3D 视口      │ 参数与素材槽 │
├───────────┴──────────────────────────┴───────────┤
│ 底部：故事顺序条 / 生成队列 / 日志，按当前页签切换             │
└──────────────────────────────────────────────────┘
```

关键交互约定：

- 所有拖入、粘贴和“选择上传”最终都落到用户当前聚焦的语义槽位。
- 未聚焦槽位时拖入素材，弹出轻量选择：“作为首帧 / 尾帧 / 角色参考 / 风格参考 / 动作参考”。
- 每次生成产生新 Take，绝不覆盖旧 Take。
- 只有标记“采用”的 Take 才进入故事顺序与剪辑交付清单。
- 修改提示词后显示“有未生成改动”，但不影响已采用版本。

## 7. 功能模块设计

### 7.1 剧本解析与智能切分

输入方式：

- 粘贴故事或剧本。
- 导入 `.txt`、`.md`；后续可扩展 Fountain、Final Draft XML。
- 连接画布提示词、备注或现有分镜节点。

项目参数：

- 目标总时长。
- 默认画幅、语言和风格。
- 单次生成配方及其最大时长。
- 节奏：舒缓、标准、紧凑，或自定义平均镜头长度。
- 是否保留原对白、是否让模型原生生成声音。

切分采用两步法，不能直接按字数平均切：

1. **剧情分析**：识别场景、人物、地点、时间、事件、对白和连续性要求，为人物与场景分配稳定 ID。
2. **时长装箱**：按戏剧节拍与模型最大时长把内容装入 Segment，再在 Segment 内生成带时间点的 Shot。

建议 LLM 返回严格 JSON，并在写入 store 前校验和修复：

```json
{
  "title": "短片标题",
  "characters": [{ "id": "char_1", "name": "阿澈", "continuity": "外观与服装说明" }],
  "scenes": [{
    "id": "scene_1",
    "location": "雨夜车站",
    "segments": [{
      "id": "seg_1",
      "durationSec": 15,
      "summary": "阿澈发现末班车已经离开",
      "dialogue": ["阿澈：还是晚了一步。"],
      "shots": [{
        "startSec": 0,
        "endSec": 6,
        "shotSize": "大全景",
        "camera": "缓慢推近",
        "action": "阿澈跑入空荡站台",
        "audio": "雨声、急促脚步声"
      }],
      "continuityIn": "承接上一段的服装与湿发状态",
      "continuityOut": "最后停在阿澈抬头看电子屏"
    }]
  }]
}
```

校验规则：

- 每个 Segment 的 `durationSec` 不超过当前生成配方能力。
- Shot 时间连续、不重叠、不越过 Segment。
- 总时长允许与目标时长有小幅差异，但必须显示差值并允许一键重平衡。
- LLM 不得静默丢掉原剧本段落；保存每个 Segment 对应的原文范围。
- 用户手工锁定的片段、提示词或时长，在“重新拆分”时不能被覆盖。

### 7.2 分镜静帧与首尾关键帧

导演台应把图片生成作为视频生产的正式上游，而不是要求用户预先准备好所有图片。

每个 Segment 可拥有：

- 一张分镜概念图，用于确定构图、角色和场景。
- 一张采用的首帧。
- 可选的一张采用的尾帧。
- 若干图片 Take，用于比较不同构图、服装、表情或种子。

图片来源可以是：

- 直接拖入、粘贴或选择上传。
- 从角色卡、资产库或画布图片节点引用。
- 用第三方绘画模型文生图/图生图。
- 用已语义绑定的 ComfyUI 文生图/图生图工作流生成，包括 LoRA 版和无 LoRA 版。
- 从上一段采用视频抓取末帧。
- 从 3D 预演视口导出站位图，再通过图生图工作流润色为正式关键帧。

图片生成也使用 Take 机制。用户从多个图片 Take 中选择“设为首帧”“设为尾帧”或“仅作参考”，之后视频任务才读取这些采用关系。重新生成关键帧不能覆盖旧图，也不能暗中替换已经生成过的视频输入快照。

建议在生成页把流程明确分成两层：上方是“画面准备”，下方是“视频成片”。用户可以只用外部图片跳过画面生成，也可以在导演台内完整完成文生图 → 图生图 → 图生视频。

### 7.3 模型提示词编译器

导演台内保存的是模型无关的镜头结构，不直接把最终 H3 提示词当作唯一真相。生成前由 `PromptCompiler` 根据配方编译：

- 公共层：人物连续性、场景、动作、景别、镜头运动、光线、对白、音效和音乐。
- 图片配方：编译静态构图、角色外观、姿势、场景、光线、镜头焦段和画幅，不混入无意义的视频时序描述。
- H3 基础模式：把片段组织成带时间点的镜头、摄影机与音频描述。
- H3 R2V：根据素材最终连接顺序注入 `<Picture N>`、`<Video N>`、`<Audio N>`，并明确每个参考负责身份、风格、动作、运镜或声音。
- 第三方 API：映射为对应服务支持的 prompt、首尾帧、参考图和时长参数。

必须同时保存：

- 用户可编辑的导演描述。
- 编译后的实际请求提示词。
- 生成时的配方、工作流指纹、参数和素材顺序快照。

这样才能准确复现某个 Take，也能在切换模型后重新编译，而不是污染原分镜。

### 7.4 ComfyUI 工作流“语义胶囊”

这是导演台最核心的基础能力。

#### 当前问题

现有 `runComfyTemplate` 会把剩余上游图片按 LoadImage 节点数字顺序依次填入。这对普通单图工作流可用，但对首帧、尾帧、角色参考、风格参考、多路 R2V 和 LoRA 变体不够可靠。节点编号发生变化，也可能把素材送错位置。

#### 新方案

给 ComfyUI 模板的每个“子工作流分支”增加语义能力描述和槽位映射。一个工作流文件可以拥有多个分支，例如“SeedVR2 / 图像放大”和“SeedVR2 / 视频放大”；用户只需分别在“工作流绑定向导”中确认一次。完整的分支结构见本文第 18 节。

```ts
type ComfyCapability =
  | "text-to-image"
  | "image-to-image"
  | "text-to-video"
  | "image-to-video"
  | "first-last-to-video"
  | "reference-to-video"
  | "video-to-video"
  | "custom";

type ComfySemantic =
  | "prompt"
  | "negativePrompt"
  | "firstFrame"
  | "lastFrame"
  | "referenceImage"
  | "referenceVideo"
  | "referenceAudio"
  | "layoutGuide"
  | "poseGuide"
  | "controlVideo"
  | "duration"
  | "width"
  | "height"
  | "fps"
  | "seed"
  | "loraName"
  | "loraStrength"
  | "custom";

type ComfySlotBinding = {
  nodeId: string;
  input: string;
  index?: number;
};

type ComfySemanticSlot = {
  id: string;
  label: string;
  semantic: ComfySemantic;
  media: "text" | "image" | "video" | "audio" | "number" | "boolean";
  required: boolean;
  maxItems?: number;
  bindings: ComfySlotBinding[];
};
```

语义槽必须属于具体 `variantId`，不能只挂在整个工作流文件上。因为同一个 SeedVR2 文件中的图像分支可能需要图片输入并输出图片，视频分支需要视频输入并输出视频；两者的入口、参数和输出合同完全不同。

绑定向导流程：

1. 自动扫描工作流，列出所有可能的文本、图片、视频、音频和参数入口。
2. 根据节点类型、输入名和标题给出建议，例如把 `first_frame` 建议为“首帧”。
3. 用户在中文示意图中点选目标节点，并给它分配语义。
4. 显示一张“输入合同”：必填项、最大数量、输出媒体和已绑定位置。
5. 执行一次不生成或低成本校验：检查目标节点存在、输入类型匹配、本机自定义节点已安装。
6. 保存工作流结构指纹。工作流内容变化后，原“已验证”状态自动失效，要求重新确认。

运行时必须按以下顺序执行：

1. 根据当前 Segment 和配方解析所需槽位。
2. 检查必填槽、数量上限和素材类型。
3. 图片、视频、音频按资产 ID 或内容哈希去重上传，并缓存 ComfyUI 文件名。
4. 只写入已确认的 `nodeId + input`，不再依赖节点编号排序。
5. 根据最终参考素材顺序编译提示词标签。
6. 调用现有 `object_info` 做提交前校验。
7. 在任务日志中显示“首帧 → #12.first_frame”这类可读记录，方便排错。

兼容策略：

- 老模板没有分支和 `slots` 时，加载时归一化成一个“默认”分支，并继续走现有自动填入逻辑，普通 ComfyUI 节点行为不变。
- 导演台只允许使用已完成语义绑定的模板；否则显示“先配置工作流”，不进行猜测。
- LoRA 版和非 LoRA 版如果位于同一个工作流文件的不同拓扑，可保存为两个子工作流分支，再映射成两个“生成配方”。只有工作流确实暴露了 LoRA 开关/名称/强度时，才在同一分支里切换，不能靠删节点冒险。

### 7.5 生成配方

生成配方把“用户想做什么”与“具体怎么调用”隔离：

```ts
type DirectorRecipe = {
  id: string;
  name: string;
  engine: "comfy" | "provider";
  output: "image" | "video";
  mode: "t2i" | "i2i" | "t2v" | "i2v" | "fl2v" | "r2v" | "v2v";
  templateId?: string;
  variantId?: string;
  providerModelKey?: string;
  maxDurationSec?: number;
  supportedMedia: Array<"image" | "video" | "audio">;
  defaultParams: Record<string, string | number | boolean>;
};
```

建议先提供两组配方。图片配方可连接现有绘画模型或用户的 ComfyUI 工作流：

- `分镜图 · 文生图`
- `关键帧 · 图生图`
- 用户自己的 `角色 LoRA · 文生图/图生图`

视频配方预置以下 H3 入口，但工作流 JSON 由用户导入或从官方模板库获取：

- `H3 · 文生视频 T2V`
- `H3 · 首帧图生视频 I2V`
- `H3 · 首尾帧视频 FL2V`
- `H3 · 多参考视频 R2V`
- 用户自己的 `H3 · R2V + 角色 LoRA`

配方选择器需要显示输出类型和能力徽标，而不是只显示模板名，例如“图片 · 图生图 · LoRA”或“视频 · 首+尾帧 / 9 图参考 / 3 视频参考 / 原生音频”。

### 7.6 MiniMax H3 专项规则

根据 ComfyUI 官方文档，首版应固化以下适配规则：

- T2V、I2V 与首尾帧模式使用 `fl2va` 路线；R2V 使用不同的 `ref2va` 权重，不能只靠一个布尔开关互换。
- I2V 的 `first_frame`、`last_frame` 都是可选输入；导演台 UI 应允许只有首帧，也允许首尾帧同时提供。
- R2V 最多 9 张参考图、3 条参考视频和 3 条独立参考音频；在拖入第 10 张图时直接阻止并给中文说明。
- R2V 提示词标签按实际连接顺序产生，素材卡片拖动排序后必须重新编译标签。
- 每个参考必须有“用途”：角色身份、场景风格、动作、摄影机、声音或其他。用途会被写入提示词。
- H3 时长遵循模型帧块规则，UI 中显示用户希望时长和实际可生成时长，不能默默截断。
- 分辨率以工作流参数为准，并在生成前展示实际宽高；快速预览与正式输出可保存为两个参数预设。

参考：[ComfyUI MiniMax H3 官方工作流与限制](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)。

### 7.7 素材槽与连续性

每个 Segment 默认拥有以下槽位：

- 首帧、尾帧。
- 角色参考，可从角色卡或资产库拖入。
- 场景/风格参考。
- 动作/运镜参考视频。
- 声音参考与独立配乐/音效参考。
- 3D 站位图、姿势图和控制图。

全局素材可以被某个片段继承，例如全片角色参考和统一风格；片段级素材覆盖全局素材。UI 要清楚标出“继承”还是“本段覆盖”。

连续性辅助：

- 可把上一段采用版本的末帧自动抓取为下一段首帧。
- 该操作必须生成一个可见资产并绑定槽位，不能暗中传值。
- 用户可锁定角色、服装、场景、色调和摄影机规则；重新拆分或优化提示词时保留锁定内容。
- 提供连续性检查清单，但首版不承诺用视觉模型自动判断人物是否完全一致。

### 7.8 任务队列与生成管理

任务粒度是 `一个 Segment + 一个生成目标 + 一个 Take`。生成目标可以是分镜图、首帧、尾帧或视频片段。

状态机：

```text
草稿 → 待生成 → 排队中 → 上传素材 → ComfyUI 执行 → 回收结果
                                              ├→ 成功待选
                                              ├→ 失败可重试
                                              └→ 已取消
成功待选 → 采用 → 进入时间线
```

队列规则：

- 本地 ComfyUI 默认并发数为 1，避免显存竞争；高级设置允许用户调整。
- 第三方 API 使用单独并发限制，不与本地队列混在一个计数器里。
- 支持“生成所选”“生成缺失”“重试失败”，不默认提供无确认的“全片重算”。
- 开始批量生成前汇总任务数、预计总视频秒数、调用引擎和可能计费。
- 取消只影响当前任务或选中任务；已成功的结果必须保留。
- 应用重启后，原来处于运行中的任务标记为“上次运行中断”，用户可继续排队，不能静默变回待生成。
- 切换画布或关闭导演台不取消任务，结果根据 `projectId + segmentId + takeId` 写回。

### 7.9 Take 多版本与选片

每次生成保存一个不可变快照：

```ts
type DirectorTake = {
  id: string;
  segmentId: string;
  kind: "image" | "video";
  target: "storyboard" | "firstFrame" | "lastFrame" | "clip";
  status: "queued" | "running" | "done" | "error" | "cancelled";
  assetId?: string;
  error?: string;
  promptSnapshot: string;
  recipeSnapshot: DirectorRecipe;
  slotSnapshot: Array<{ semantic: ComfySemantic; assetIds: string[] }>;
  paramSnapshot: Record<string, unknown>;
  ruleSnapshot?: DirectorRuleSet;
  skillSnapshots?: SkillRunSnapshot[];
  workflowFingerprint?: string;
  createdAt: number;
};
```

交互：

- 同一片段的 Take 横向排列，可并排预览。
- “采用”只是修改 `approvedTakeId`，不删除其他版本。
- 支持星标、备注和失败原因。
- “基于此版本再生成”复制其快照为新草稿，再允许修改提示词、seed、工作流或参考素材。
- 资产库按导演项目和片段成组收录；`groupSlot` 使用稳定的 `segmentId/takeId`，避免重复生成后旧结果丢失。

### 7.10 故事顺序、串片预演与剪辑交付

导演台不发展成剪辑软件。这里的顺序条只承担生产检查和交付闭环：

- 每个 Segment 只使用已经“采用并锁定”的 Take。
- 按剧本顺序展示场景、剧情段和镜头，允许纠正错误顺序，但不提供专业多轨编辑。
- 硬切连播，用来检查缺片、重复片、总时长、剧情跳跃和连续性。
- 缺片、失败片、未采用片以明显占位显示，不允许误导用户认为已经完成。
- 为每个镜头保存稳定 ID、采用 Take、实际时长、剧情摘要和剪辑备注。
- 输出标准项目交付包；是否同时导出一条硬切预演片由用户决定。

交付目标分三层：

1. **通用素材包**：编号视频、对白、旁白、音效、环境音、音乐、SRT、镜头表、项目清单和预演片。
2. **Premiere XML**：生成可导入的 Final Cut Pro 7 XML，按顺序预排视频和音频轨，并写入场景/剧情段/镜头标记。
3. **Premiere Bridge（后续）**：可选 UXP 插件连接 MOMO 项目清单，一键建立素材箱、序列、轨道和标记。

剪映首版只承诺通用素材包。由于没有稳定的公开跨软件工程交换协议，直接写剪映草稿只能作为按版本适配、修改前备份、失败可回退的实验功能，不能成为核心链路。

现有 `videoEdit.ts` 可继续用于硬切预演。正式预演片输出在 Tauri 下使用受控 FFmpeg sidecar，统一分辨率、帧率、像素格式和音轨；它不是最终剪辑工程的替代品。

### 7.11 3D 站位参考器

3D 的目标是“给 AI 一个确定的空间意图”，不是做最终 3D 成片。

后期阶段建议能力严格限制为：

- 导入 GLB/GLTF/VRM 角色，或使用内置低模人体替身。
- 场景中放置多个角色、简单道具和地面。
- 选择预设姿势，调整根节点位置、朝向和视线目标。
- 设置摄影机位置、焦距、景别、画幅和简单灯光。
- 绘制简单行动方向，设置起点、终点和少量关键姿势。
- 保存同一场景的多个机位，并批量生成站位参考图。
- 导出彩色预演图、轮廓图、深度图、法线图、角色分区图和骨骼姿势图。

输出到模型的方式：

- 普通视频模型：把彩色预演图作为首帧或构图参考。
- H3 R2V：把站位图作为参考图，并在提示词中说明其负责空间布局；不能宣称它能像 ControlNet 一样精确服从。
- ComfyUI 控制工作流：把深度图、姿势图或分区图绑定到 `layoutGuide` / `poseGuide` 语义槽，交给 ControlNet 或工作流中的对应控制节点。
- 行动图首版是带方向和关键位置的可视参考；后续再把 3D 动画渲染为动作参考视频。

技术建议：使用 Three.js + React Three Fiber 构建独立视口，资产引用只存文件路径或资产 ID。不要把 GLB 二进制、渲染 PNG 或大量关键帧直接塞进画布节点 data。明确不做建模、骨骼绑定、复杂动画、材质节点、雕刻和专业渲染；高级制作继续交给 Blender。

## 8. 数据与持久化设计

### 8.1 节点只保存项目引用

```ts
type DirectorData = {
  status: RunStatus;
  error?: string;
  projectId: string;
  outputUrl?: string;
  cover?: string;
  progress?: string;
};
```

导演项目不能整个放进 `DirectorData`，原因是：

- 画布 undo/redo 会复制节点 data，长项目会让快照急剧膨胀。
- 生成队列持续更新会频繁触发画布持久化。
- 视频、图片和 3D 文件应继续由资产库与文件系统管理。

### 8.2 独立导演项目 Store

新增 `directorStore.ts`，落盘到独立的 `director-projects.json`。核心结构：

```ts
type DirectorProject = {
  id: string;
  nodeId: string;
  boardId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  targetDurationSec: number;
  aspect: string;
  script: string;
  scriptImport?: {
    format: "text" | "markdown" | "json" | "fountain" | "fdx";
    mode: "strict" | "preserve-and-split" | "advisory";
    delimiter?: string;
  };
  ruleSet?: DirectorRuleSet;
  skillBindings?: SkillBinding[];
  characters: DirectorCharacter[];
  scenes: DirectorScene[];
  recipes: DirectorRecipe[];
  globalSlots: DirectorSlotValue[];
  timeline: DirectorTimeline;
  exportAssetId?: string;
  schemaVersion: 1;
};
```

持久化要求：

- 使用现有 `loadJSON/saveJSON`，并采用与 board store 同等的异步序号守卫，防止慢的旧快照覆盖新数据。
- 只保存 `assetId`、路径和必要元数据，不保存大体积 dataURL。
- 项目 schema 单独版本化，未来增加 3D 数据时走迁移。
- 删除导演台节点时默认把项目移入“孤立/归档项目”，不直接删除素材；用户在二次确认后才能彻底删除项目关系。
- 浏览器预览模式允许使用 localStorage 和现有媒体降级，不能因 Tauri API 不可用而白屏。

### 8.3 资产关联

为 `AssetItem` 增加可选来源：

```ts
director?: {
  projectId: string;
  sceneId?: string;
  segmentId?: string;
  takeId?: string;
  role?: "firstFrame" | "lastFrame" | "reference" | "generated" | "export" | "previz";
};
```

这些字段可选，不会破坏老资产。资产库可以据此增加“导演项目”筛选与定位。

## 9. 技术分层

建议保持现有依赖方向：

```text
modules/director/DirectorStudio.tsx
        ↓
core/stores/directorStore.ts
        ↓
core/directorEngine.ts        片段生成、队列、Take 状态
core/directorPrompt.ts        模型无关结构 → H3/第三方提示词
core/comfyBindings.ts         语义槽校验与精确写入
core/directorExport.ts        时间线预览与导出适配
        ↓
core/services/comfy.ts
core/services/videoGen.ts
core/videoEdit.ts
core/stores/assetStore.ts
```

职责边界：

- UI 不直接改 Comfy 工作流 JSON。
- `directorEngine` 不直接操作 React 状态，统一通过 `useDirector.getState()` 和现有 store API。
- `comfyBindings` 是纯映射/校验层，接收模板、槽值和上传后的文件名，返回要执行的工作流或中文错误。
- `services/comfy.ts` 继续只处理 Comfy 协议、上传、提交、进度和结果回收。
- 运行失败统一 `pushError("导演台 · 片段 N", msg)`，并写入 Take 错误，不裸发错误 toast。

## 10. 关键异常与保护

- 工作流指纹变化：阻止运行，提示重新确认语义槽。
- 首尾帧被反接：UI 和任务日志始终显示槽位名称与目标节点，生成前可展开核对。
- 参考素材顺序变化：重新编译 H3 标签，并让旧提示词快照保持不变。
- 工作流缺自定义节点：沿用 `object_info` 中文报错，并定位到具体配方。
- 本地 ComfyUI 离线：队列暂停而不是把所有待生成任务标失败；恢复后允许继续。
- 应用退出/崩溃：运行中 Take 标“中断”，已完成资产不丢。
- 远程视频 URL 过期：结果回收成功后立即通过资产库落盘，导演项目只引用持久资产。
- 用户改了 Segment 时长：标记提示词、镜头时间和当前采用 Take 之间存在差异，不自动删除成片。
- 删除已采用 Take：先要求选择替代版本或明确让时间线出现缺片。
- 一键重跑：汇总任务数和视频总秒数后确认，避免误操作。

## 11. 分阶段实施

### 阶段 A：H3 最小闭环

目标：先证明“再复杂的 Comfy 工作流也不会喂错图”。

- 新增导演台节点和全屏空壳。
- 新增独立导演项目 store 与持久化。
- 给 Comfy 模板增加 capability、semantic slots、fingerprint。
- 完成中文绑定向导和运行前合同检查。
- 支持 H3 T2V、I2V、首尾帧、R2V 四类配方。
- 单个 Segment 可用绘画配方生成并采用首帧/尾帧，再用 H3 配方生成视频 Take、采用版本。

完成标准：无需打开 ComfyUI 手工换图，就能在 MOMO 中稳定完成一个 H3 首尾帧或 R2V 片段。

### 阶段 B：剧集与批量生产

- 导入故事、按目标时长拆场景/片段/镜头。
- 分镜表、连续性锁定和提示词编译。
- 批量生成分镜静帧与首尾关键帧，图片 Take 可挑选和继续图生图。
- 任务队列、并发限制、取消、失败重试和跨重启恢复。
- 多 Take 选片、资产分组和上一段末帧续接。

完成标准：2 分钟故事能得到约 8 个可编辑片段，并逐段完成生成和选片。

### 阶段 C：时间线与可靠导出

- 采用版本自动进入时间线。
- 排序、启停、入点/出点、音量和顺序预览。
- 先复用 MediaRecorder 导出；再增加 Tauri FFmpeg sidecar 的可靠 MP4 导出。
- 导出成片写回节点和资产库。

完成标准：用户不打开外部剪辑软件，也能得到一条顺序正确、音画正常的粗剪成片；需要精剪时仍可导出素材继续处理。

### 阶段 D：3D 预演

- Three.js 视口、低模人物、GLB/VRM 导入。
- 站位、朝向、预设姿势、机位、焦距和简单灯光。
- 行动路径与关键位置。
- 导出彩色、深度、姿势、分区等参考图并绑定到 Comfy 语义槽。

完成标准：用户能在 3D 视口摆出双人站位和摄影机，导出站位/姿势参考，再用对应控制工作流生成该片段。

## 12. 文件级开发清单

### 12.1 类型与 Store

- `src/core/types.ts`
  - `NodeKind` 增加 `director`。
  - 增加 `DirectorData`、导演项目、场景、片段、镜头、Take、配方、槽位和时间线类型。
  - `ComfyTemplate` 增加 variants；capability、slots、fingerprint、verifiedAt 属于具体 `ComfyVariant`。
  - `AssetItem` 增加可选 director 来源。
- `src/core/stores/boardStore.ts`
  - `defaultData`、`outPortType`、`NODE_INPUTS`、`NODE_LABEL`、排序表增加 director。
  - `director` 输入 text/image/video/audio，输出 video。
- 新增 `src/core/stores/directorStore.ts`
  - 项目 CRUD、片段/Take 更新、队列状态和独立持久化。
- `src/core/stores/comfyStore.ts`
  - 增加模板 normalize；老模板补空 slots，不改变旧行为。

### 12.2 核心能力

- 新增 `src/core/comfyBindings.ts`
  - 自动建议、合同校验、精确绑定、工作流指纹。
- 修改 `src/core/services/comfy.ts`
  - 增加显式 bindings 执行入口；保留原 upstream 自动入口供老节点使用。
  - 增加音频上传/输入支持，供 H3 R2V 使用。
- 新增 `src/core/directorPrompt.ts`
  - 通用镜头结构和 H3/第三方提示词编译器。
- 新增 `src/core/directorEngine.ts`
  - 队列、取消、恢复、生成、Take 与资产收录。
- 新增 `src/core/directorExport.ts`
  - 连接时间线数据与现有 `videoEdit.ts`，后续接 FFmpeg。

### 12.3 UI

- 新增 `src/modules/canvas/nodes/DirectorNode.tsx`。
- `src/modules/canvas/SmartCanvas.tsx` 注册 nodeTypes。
- `src/modules/canvas/nodeCatalog.tsx` 加入“导演台”。
- `src/ui/icons.tsx` 增加导演台图标，不引第三方图标库。
- 新增 `src/modules/director/`：
  - `DirectorStudio.tsx`
  - `ScriptPage.tsx`
  - `StoryboardPage.tsx`
  - `GenerationPage.tsx`
  - `TimelinePage.tsx`
  - `WorkflowBindingWizard.tsx`
  - `ThreeDPage.tsx`，阶段 D 再加入
  - `director.css`，全部使用主题 token
- `src/App.tsx` 增加全屏导演台入口与关闭逻辑。

### 12.4 现有链路联动

- 资产库支持按导演项目/片段筛选和定位。
- 视频灯箱继续复用 `VideoThumb` 与现有预览。
- 导演台内图片缩略图必须使用 `Thumb`。
- 运行错误走 `pushError`。
- 生成结果多版本按资产组收录。
- 设置结构如果增加默认并发、FFmpeg 路径等字段，必须同步 Settings 迁移。
- 若新增快捷键，按项目约定同步 `HotkeyAction`、标签、默认值、keydown 和设置分组。

## 13. MVP 验收用例

1. 导入一个 H3 首尾帧 ComfyUI API 工作流，手工把两个入口分别绑定为首帧、尾帧；重启后绑定仍存在。
2. 在导演台分别拖入两张明显不同的图片，生成前检查页面准确显示它们将写入哪个节点输入，实际工作流不反接。
3. 给同一片段生成三张分镜图片，采用其中一张作为首帧；再次图生图后，旧图和采用关系都有清晰记录。
4. 导入 H3 R2V 工作流，放入 3 张图、1 条动作视频和 1 条声音；提示词中标签编号与最终连接顺序一致。
5. 超出 H3 参考容量时，在提交前阻止并给中文提示。
6. 输入 120 秒故事，系统拆出总时长接近 120 秒、单段不超过当前配方上限的结构；原文没有无提示丢失。
7. 只选择第 2、4、5 段生成，本地队列按并发 1 运行；关闭导演台后任务继续，结果仍写回正确项目。
8. 某段生成失败后保留错误与参数，可单独重试；其他成功段不受影响。
9. 同一片段生成三次，三个视频 Take 都能预览；采用第 2 个不会删除第 1、3 个。
10. 修改提示词后显示“未生成改动”，已采用视频仍在时间线。
11. 把上一段末帧设为下一段首帧后，资产库能看到对应帧资产和绑定关系。
12. 时间线缺片时不能导出“假完整成片”；补齐并采用后可顺序预览和导出。
13. 导出结果进入资产库并成为导演台节点的视频输出。
14. 应用在生成中退出后，重启显示“上次运行中断”，不会静默丢失任务或覆盖已完成版本。
15. 纯浏览器模式没有 Tauri/FFmpeg 时能降级，不白屏，并明确提示导出限制。

## 14. 导演台内部开发顺序

本节描述导演台自身的纵向切片；四套能力合并后的全局先后顺序以第 19 节为准。进入导演台开发后，不要一次性要求 GLM 完成全文：

1. **节点和持久化切片**：只实现导演台节点、全屏入口、空项目创建和重启恢复。
2. **语义绑定切片**：只实现一个 H3 首尾帧工作流的两个图片槽，完成精确写入和 preflight。
3. **R2V 切片**：增加多图/视频/音频槽、顺序和 H3 标签编译。
4. **图片 Take 切片**：文生图/图生图生成分镜静帧，结果落资产，采用为首帧或尾帧。
5. **视频 Take 切片**：读取已采用关键帧，一次生成、再次生成和采用版本。
6. **剧本拆分切片**：场景—片段—镜头 JSON、编辑和锁定。
7. **队列切片**：选中生成、并发 1、取消、重试、中断恢复。
8. **时间线切片**：采用版本入时间线、顺序预览和实验性导出。
9. **可靠导出切片**：FFmpeg sidecar、格式统一、MP4 输出和浏览器降级。
10. **3D 切片**：先单人站位与相机截图，再多人、姿势、路径和控制图。

每个切片完成后至少执行：

```bash
npx tsc --noEmit
pnpm build
```

每次只让 GLM 改与当前切片直接相关的文件，并要求它先阅读本方案、`AGENTS.md`、`runner.ts`、`services/comfy.ts`、`comfyStore.ts` 和 `assetStore.ts`。不要让它一开始重构现有 ComfyUI 或视频链路。

## 15. 可直接交给 GLM 的“导演台项目壳”任务

下面这段对应第 19 节的第 8 步，适合在 ComfyUI 分支、本地模型和 Skill 基础完成后复制给 GLM。它只启动导演台的第一个纵向切片，不同时实现工作流绑定、队列、时间线和 3D。

```text
请先完整阅读仓库根目录 AGENTS.md 和《MOMO导演台节点-产品与技术方案.md》，然后只实现“阶段 A 的第 1 个切片：导演台节点 + 独立项目持久化 + 全屏工作台空壳”。

本轮目标：
1. 新增 NodeKind "director" 和最小 DirectorData。画布上的节点中文名为“导演台”，可接收 text/image/video/audio，输出类型为 video，但没有 outputUrl 时不向下游传值。
2. DirectorNode 只显示项目名、目标时长、片段完成度占位和“进入导演台”按钮。不要把大表单塞进节点。
3. 点击后在 App 层打开全屏 DirectorStudio，先做“脚本 / 分镜 / 生成 / 剪辑 / 3D 预演”五个页签空壳；3D 页签标为后续开放。
4. 新增 directorStore，使用 loadJSON/saveJSON 单独保存 director-projects.json。项目数据不能放进画布 node.data；node.data 只保存 projectId 和摘要字段。
5. 新建导演台节点时自动创建对应项目，保存 boardId 和 nodeId；重启后可重新打开同一个项目。
6. 删除节点时本轮不要级联删除项目或资产。
7. director 不加入 RUNNERS，避免“全部运行”意外触发整集生成。
8. 注册 nodeTypes、NODE_CATALOG、defaultData、outPortType、NODE_INPUTS、NODE_LABEL，并在 icons.tsx 手绘一个导演台 SVG 图标。
9. UI 文案、注释全部使用中文，样式只用现有主题 token；交互元素加 nodrag；不要引入新依赖。
10. 兼容 Tauri 和浏览器预览模式，不手动启动 pnpm tauri dev。

本轮不做：ComfyUI semantic slots、H3 适配、LLM 拆分、生成任务、时间线导出、3D 渲染。

实现前先检查现有 App 全屏模块/弹层的打开方式、boardStore 新增节点链路和 persist.ts。完成后运行 npx tsc --noEmit 和 pnpm build，修复本轮引入的错误。最后列出改动文件、验证结果和下一轮建议，但不要自动进入下一轮。
```

## 16. 导演台产品判断

导演台的真正价值不是“按钮更多”，而是把 AI 视频最费时间的四件事变成可管理的数据：

1. 工作流输入不会接错。
2. 长故事能被拆成可以生产的镜头任务。
3. 每一镜的重生成和选片都有历史，不再靠文件夹猜版本。
4. 选中的片段天然组成时间线，能直接得到粗剪成片。

按本方案分阶段实现，MOMO 可以先快速成为本地 H3 的高效制作前台，再逐步成长为模型无关的 AI 视频导演工作站。3D 功能也完全可行，但只有在语义槽、片段结构和版本管理稳定之后加入，才会真正服务生成，而不是成为一个孤立的 3D 玩具。

## 17. MOMO Skill：全软件通用的创作规则包

### 17.1 产品定位

MOMO Skill 不是模型，也不只是保存一段“万能提示词”。它是一份可安装、可配置、可复用、可验证的创作规则包，用来告诉 MOMO：

- 当前内容要按什么专业流程完善。
- 必须遵守哪些比例、尺度、构图、镜头或文字规则。
- 需要向用户补问哪些变量。
- 结果应输出普通文本，还是海报版式、导演镜头等结构化数据。
- 完成后如何检查是否满足规则。

例如：

- “MiniMax H3 15 秒电影镜头” Skill：把普通描述整理为带时间点、摄影机、对白、音效和参考标签的 H3 提示词。
- “商业海报排版” Skill：根据画幅、主体和文案，规划安全边距、标题层级、网格、留白、主体比例与 CTA 位置，再编译成生图提示词。
- “小红书封面” Skill：控制 3:4 画幅、标题字数、人物占比、视觉焦点和移动端可读性。
- “角色一致性” Skill：把角色卡中的固定外观、服装和禁改项注入每个分镜，并检查是否遗漏。

第一版不建议新增一个必须连线的“Skill 节点”。Skill 应先成为所有提示词入口共用的能力；以后如果用户需要在画布中明确编排多步 Skill，再增加“Skill 处理”节点。

### 17.2 支持的使用位置

每个 Skill 在清单中声明适用上下文：

```ts
type SkillContext =
  | "prompt.text"
  | "prompt.image"
  | "prompt.video"
  | "director.project"
  | "director.segment"
  | "poster.layout"
  | "ecom.layout"
  | "agent.image"
  | "agent.video";
```

首批接入点：

- `PromptNode` 的“工具”菜单。
- 底部 `GenPromptBar` 的 `PromptAiTools`。
- 导演台项目的全局 Skill 栈和单个 Segment 覆盖。
- 电商图、海报或后续排版节点。
- 创作助手：只有用户显式启用的 Skill 才参与 Agent 出图/出片，不影响普通聊天。

### 17.3 导入格式

建议同时支持两种入口：

1. **快速 Skill**：直接导入一个 `SKILL.md`。导入向导让用户补充名称、分类、适用位置、执行阶段和默认变量。
2. **完整 Skill 包**：导入 `.momoskill` ZIP，内含清单、指令、参考资料和少量示例资产。

完整包结构：

```text
poster-layout.momoskill
├─ skill.json
├─ instructions.md
├─ references/
│  └─ layout-rules.md
└─ assets/
   └─ example-grid.png
```

第一版只读取上述声明式文件。即使压缩包中带有 `scripts/`、`.js`、`.py` 或可执行文件，也必须忽略并明确提示“当前版本不执行 Skill 脚本”。解压时校验路径，禁止 `../` 路径穿越，并设置文件数量与总体积上限。

`skill.json` 示例：

```json
{
  "momoSkill": 1,
  "id": "poster-commercial-layout",
  "name": "商业海报排版",
  "version": "1.0.0",
  "description": "按网格、层级和安全区完善海报提示词",
  "contexts": ["prompt.image", "poster.layout", "agent.image"],
  "phase": "authoring",
  "output": "poster-plan",
  "variables": [
    { "key": "aspect", "label": "画幅", "type": "select", "options": ["3:4", "4:5", "9:16"], "required": true },
    { "key": "safeMargin", "label": "安全边距", "type": "number", "default": 6 }
  ]
}
```

### 17.4 Skill 数据结构

```ts
type SkillPhase = "analyze" | "authoring" | "model-adapter" | "validate";
type SkillOutput = "text" | "prompt-plan" | "poster-plan" | "director-plan";

type MomoSkill = {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "builtin" | "import";
  contexts: SkillContext[];
  phase: SkillPhase;
  output: SkillOutput;
  instructions: string;
  references?: string[];
  variables: SkillVariable[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

type SkillBinding = {
  skillId: string;
  enabled: boolean;
  values: Record<string, string | number | boolean>;
};

type SkillRunSnapshot = {
  skillId: string;
  name: string;
  version: string;
  instructionFingerprint: string;
  values: Record<string, unknown>;
};
```

Skill 本体保存在独立 `skillStore`，节点和导演项目只保存 `SkillBinding`。每次真正生成图片或视频时，把 `SkillRunSnapshot` 写进生成历史或 Take，确保用户以后能知道“这条结果是用哪个版本的规则生成的”。

### 17.5 Skill 执行链

一次执行分为六步：

```text
当前文本/图片/项目上下文
  → 填充 Skill 变量
  → 读取必要规则与参考资料
  → 调用对话模型生成候选结果
  → 按输出合同解析与校验
  → 预览差异
  → 用户应用或继续修改
```

输入上下文应最小化：只传当前文本、用户主动选择的图片、画幅、目标模型和必要项目字段。不能因为 Skill 安装在本机，就默认把整个资产库、全部画布或其他项目内容发送给模型。

结果应用方式：

- **替换**：用完善结果替换当前提示词。
- **追加**：把 Skill 产生的规则片段追加到原提示词。
- **结构化应用**：把结果拆到 prompt、negativePrompt、layout、camera、audio 等字段。
- **仅检查**：不改写，返回缺失项和风险列表。

默认必须先显示预览。节点或导演项目可以显式打开“生成前自动执行”，但 UI 要常显 Skill 徽标和最近执行状态，不能静默改写用户文本。

### 17.6 Skill 栈与冲突处理

用户可能同时启用多个 Skill，例如：

```text
角色一致性 → 电影镜头编排 → MiniMax H3 适配 → H3 规则校验
```

为避免任意顺序导致结果漂移，Skill 按阶段固定排序：

1. `analyze`：提取意图、角色、文案与约束。
2. `authoring`：完善创意、构图、排版和镜头。
3. `model-adapter`：转成 H3、Flux、Seedream 等目标模型格式。
4. `validate`：只检查，不再次大幅改写。

同一阶段允许拖动排序。第一版建议单次最多启用 5 个 Skill；若两个 Skill 同时强制不同画幅、语言或最大字数，运行前列出冲突，让用户选择优先项，不能让后执行者悄悄覆盖前者。

### 17.7 结构化输出

纯文本 Skill 最容易实现，但海报和导演台需要结构化结果才能真正“编排”，而不只是把提示词写长。

海报 Skill 建议输出：

```ts
type PosterPlan = {
  prompt: string;
  negativePrompt?: string;
  aspect: string;
  safeMarginPct: number;
  grid: string;
  subject: { position: string; scalePct: number };
  title: { text: string; zone: string; maxLines: number; hierarchy: number };
  subtitle?: { text: string; zone: string; maxLines: number };
  cta?: { text: string; zone: string };
  palette?: string[];
  checklist: string[];
};
```

导演 Skill 建议输出镜头、动作、摄影机、声音和连续性字段，再由本文的 `directorPrompt.ts` 编译成目标模型提示词。Skill 不应直接绕过导演台数据模型输出一大段不可编辑文本。

### 17.8 交互设计

设置中新增“Skill”管理页：

- 导入 `SKILL.md` / `.momoskill`。
- 列表显示名称、版本、来源、适用位置、启用状态和安全级别。
- 查看完整指令、引用文件和变量。
- 收藏、停用、导出、更新和删除。
- 内置 Skill 可恢复默认；导入 Skill 删除前二次确认。

提示词工具弹层增加“Skill”区域：

- 顶部显示最近使用和已收藏 Skill。
- 点击 Skill 后先填写缺少的变量。
- 显示“原文 / 优化后”对比，可选择替换、追加或取消。
- 支持把常用 Skill 固定在生成栏为一个小胶囊。

导演台中：

- 项目级 Skill 作用于所有 Segment，例如“统一日系电影风格”。
- Segment 可继承、停用或覆盖项目 Skill。
- 生成视频 Take 时记录实际 Skill 栈快照。
- 修改 Skill 或变量后，只标记“提示词待重新编译”，不能让旧 Take 失效或被覆盖。

### 17.9 安全、稳定性与降级

- 第一版不执行 Skill 内代码，不开放网络工具权限，不允许 Skill 直接改 store。
- 所有 Skill 通过统一 `skillEngine` 读取有限上下文并返回结果。
- 指令中若要求读取不存在的文件、访问网页、发送消息或删除数据，应忽略越权动作并显示警告。
- 导入时保存原始来源和指令指纹；更新后旧生成记录仍引用旧快照。
- LLM 返回结构化数据时必须经过 JSON 提取、schema 校验和一次有限修复；修复失败则展示原始文本，不写入半成品结构。
- 没配置对话模型时，纯模板型 Skill 可以运行；需要 LLM 的 Skill 显示“需配置对话模型”，不能白屏。
- 浏览器模式只保存文本型 Skill；带本地参考资产的高级包可以降级为“资产不可用”。

### 17.10 Skill 技术落点

建议新增：

- `src/core/skillTypes.ts`：Skill、变量、上下文、结构化结果类型。
- `src/core/stores/skillStore.ts`：安装、更新、启停、收藏、独立持久化。
- `src/core/skillEngine.ts`：上下文裁剪、变量渲染、阶段排序、冲突检测、LLM 执行、结果校验。
- `src/core/skillImport.ts`：`SKILL.md` 与 `.momoskill` 安全导入、路径和体积检查。
- `src/modules/skills/SkillManager.tsx`：全局管理器。
- `src/ui/SkillPicker.tsx`：提示词栏、导演台和 Agent 共用选择器。
- 修改 `PromptAiTools.tsx` 和 `PromptToolsBtn.tsx`，复用同一 Skill 菜单，不为每个节点各写一套。
- `llmTextTransform` 的底层调用应抽成可接收自定义 system/instruction 的文本服务，避免 `skillEngine` 再复制一套供应商协议。

### 17.11 Skill 验收用例

1. 导入一个只有 `SKILL.md` 的快速 Skill，补充适用位置后，重启仍能在提示词工具中找到。
2. 导入完整 `.momoskill` 后可以查看名称、版本、指令、变量和参考文件；包内脚本不会执行。
3. “商业海报排版” Skill 在 3:4 和 9:16 两组变量下输出不同安全区、主体比例和标题区域，而不是只把原提示词写长。
4. 执行前显示原文与候选结果，取消时当前提示词完全不变。
5. 开启“生成前自动执行”后，节点常显 Skill 徽标；执行失败时保留原提示词并阻止半成品写入。
6. 同时启用角色一致性、镜头编排和 H3 适配时，按固定阶段顺序执行，并在结果记录中保存三个版本快照。
7. 两个 Skill 强制不同画幅时，运行前显示冲突，用户选择后才继续。
8. 导演台项目 Skill 能被单个 Segment 继承、停用或覆盖；修改 Skill 不覆盖旧 Take。
9. 创作助手只有在用户显式启用 Skill 时才使用它，普通聊天内容不被自动改写。
10. 没有对话模型时，LLM Skill 给出中文配置提示；纯模板 Skill 仍可运行。
11. 恶意压缩包包含 `../` 路径或可执行脚本时被拒绝/忽略，不写到 Skill 目录之外。
12. 删除已被历史结果引用的 Skill 后，历史中的快照仍能说明当时使用的名称、版本和规则指纹。

## 18. ComfyUI 工作流分支、彩色块与二级菜单

### 18.1 产品概念

一个导入文件对应一个**工作流主模板**；主模板中可以包含多个**子工作流分支**。

以用户的 SeedVR2 文件为例：

```text
SeedVR2（主菜单）
├─ 图像放大（子菜单，蓝色块，输入图片，输出图片）
└─ 视频放大（子菜单，绿色块，输入视频，输出视频）
```

工作流 JSON 仍只保存一份。分支只保存节点归属、输出、参数、颜色和语义槽，不复制整份 JSON。这样修改共享模型加载节点或重新导入工作流时更容易维护。

### 18.2 最终数据结构

```ts
type ComfyVariantColor = "blue" | "green" | "orange" | "purple" | "cyan" | "pink";

type ComfyVariant = {
  id: string;
  name: string;
  color: ComfyVariantColor;
  nodeIds: string[];
  outputNodeIds: string[];
  sharedNodeIds?: string[];
  disabledNodes?: string[];
  params: ComfyExposedParam[];
  slots?: ComfySemanticSlot[];
  capability?: ComfyCapability;
  verifiedAt?: number;
  fingerprint?: string;
};

type ComfyTemplate = {
  id: string;
  name: string;
  workflow: Record<string, ComfyWfNode>;
  variants?: ComfyVariant[];
  createdAt: number;

  // v1 兼容字段：加载时归一化为一个默认分支，后续保存可迁移
  params: ComfyExposedParam[];
  outputNodeId?: string;
  disabledNodes?: string[];
};

type ComfyData = {
  status: RunStatus;
  error?: string;
  templateId?: string;
  variantId?: string;
  paramsByVariant?: Record<string, Record<string, string | number>>;
  // 其余结果、历史和进度字段沿用现有结构
};
```

`paramsByVariant` 用来记住用户在“图像放大”和“视频放大”中分别设置过的参数。切换子菜单时不应把另一分支的参数清空，也不应把视频参数错误显示到图片分支。

### 18.3 示意图自动分块

导入工作流后，编辑器先提供自动建议：

- 如果图中存在完全断开的弱连通分量，建议每个分量成为一个分支。
- 如果多个输出共享上游节点，从每个输出反向追踪祖先，建议形成“输出分支 + 共享依赖”。
- 根据 LoadImage、LoadVideo、SaveImage、VHS VideoCombine 等能力建议名称“图像流程”“视频流程”。
- 自动建议只用于起点，用户确认前不保存。

示意图渲染：

- 每个分支显示带名称的半透明彩色背景框，节点仍保持原有中文卡片样式。
- 同属两个分支的共享节点显示中性色或双色条纹，并标“共享”。
- 未归属节点显示在“未分配”区域，保存时给出提醒。
- 自动布局先按分支分栏，再在每个块内执行现有最长路径布局，避免两套工作流上下穿插成一团。
- 颜色存的是语义色名，样式通过主题 token 和 `color-mix` 生成，兼容云白、深空蓝和深邃黑主题。

### 18.4 框选与“只运行所选”

编辑器增加框选模式：

1. 在示意图空白处拖出选框，选中与矩形相交的节点。
2. `Shift` 增选/减选；点击空白取消；可用“选择相连上游”“选择到输出”辅助补全。
3. 点击“创建子工作流”或“只运行所选”。
4. 输入分支名称、选择颜色，并从选中节点中指定一个或多个输出。
5. 系统检查外部依赖：若选中节点依赖未选中的上游，列出这些节点并提供“加入为共享依赖”。
6. 检查通过后保存为分支，并在右侧显示输入、输出、参数和语义槽合同。

“只运行所选”有两种作用：

- 对尚未建分支的临时框选：生成一个未保存的预览分支，校验通过后可试运行一次。
- 对已经命名的彩色块：直接选择该分支并运行。

建议正式按钮文案使用“创建子工作流”和“试运行所选”，比“生效”更清楚；用户口中的“只生成”可作为按钮副说明。

### 18.5 安全的分支提取算法

现有 `pruneDisabled` 会把被忽略中间节点的下游自动跨接到其第一个上游，这适合关闭某个可选处理节点，但不适合切换整条逻辑分支。

例如删除“图像放大”分支时，如果自动跨接到“视频放大”中的相邻输入，工作流虽然可能通过 JSON 校验，却会执行错误路径。因此子工作流必须使用 include-list：

```text
用户选择的分支节点 nodeIds
  + 从指定 outputNodeIds 反向找到的必要祖先
  + 显式 sharedNodeIds
  = allowedNodeIds

实际提交工作流 = 原工作流中过滤 allowedNodeIds
```

提取步骤：

1. 校验输出节点属于当前分支。
2. 从输出反向遍历连接，收集分支内部祖先。
3. 遇到分支外依赖时，只允许显式标记的 shared 节点；否则阻止并提示。
4. 删除所有不在白名单中的节点，不进行跨分支自动旁路。
5. 再对当前分支内部的 `disabledNodes` 使用现有安全忽略逻辑。
6. 检查所有连接来源仍存在、必填输入完整、输出媒体正确。
7. 最后执行 semantic slots 写入和 `object_info` 校验。

这条执行顺序应固定为：

```text
选择主模板/子分支
→ 提取白名单子工作流
→ 应用分支内部忽略节点
→ 写入参数和语义素材槽
→ object_info 预检
→ 提交 ComfyUI
```

### 18.6 颜色与重叠规则

- 一个普通节点默认只能归属一个分支。
- 若节点确实被多个分支使用，用户必须把它标记为“共享”，不能仅靠重复框选隐式重叠。
- 两个分支同时包含同一非共享节点时阻止保存，并显示冲突节点编号和名称。
- 不允许空分支，也不允许没有输出的正式分支。
- 重新着色只改变编辑器展示，不改变工作流运行。
- 删除分支只删除分支定义，不删除原始工作流节点；相关 Comfy 画布节点回退为“请选择子工作流”。

### 18.7 节点内二级菜单

现有 `PopSelect` 是单层列表，需要为 ComfyUI 新增专用 `ComfyTemplatePicker`，不建议把所有通用下拉都强行改成树菜单。

交互规则：

- 一级显示主模板，例如 `SeedVR2`。
- 鼠标悬停、键盘右方向键或点击一级项后，在右侧打开二级菜单。
- 二级显示 `图像放大`、`视频放大`，带对应色点、输入/输出类型和参数数量。
- 触摸设备或不稳定 hover 环境必须支持点击展开，不能只依赖悬停。
- 当前触发按钮显示 `SeedVR2 / 视频放大`，避免用户只看到主菜单名却不知道正在跑哪一条。
- 只有一个默认分支的老模板可以直接选择，不强制多走一级。
- 切换分支后恢复该分支自己的 `paramsByVariant`；运行按钮 title 同时显示主模板和子分支。

菜单示意：

```text
┌ 工作流模板────────────┐  ┌ SeedVR2──────────┐
│ SeedVR2              ›│  │ ● 图像放大       │
│ MiniMax H3           ›│  │ ● 视频放大   ✓   │
│ 普通单工作流模板       │  └──────────────────┘
└───────────────────────┘
```

### 18.8 与导演台和 Skill 的关系

- 导演台 `DirectorRecipe` 同时保存 `templateId + variantId`，例如“SeedVR2 / 视频放大”。
- 每个子分支拥有自己的 semantic slots；导演台选择配方后只展示该分支接受的首帧、尾帧、参考图、视频或音频槽。
- Skill 负责把提示词编排成该模型/任务需要的格式，不能替代子分支选择。
- 模型适配 Skill 可以声明它推荐的 capability，但不能未经用户确认擅自切换 ComfyUI 分支。
- 分支工作流内容或节点归属变化后，分支 fingerprint 和语义槽 verifiedAt 一起失效。

### 18.9 迁移与兼容

- 老 `ComfyTemplate` 加载时生成一个内存中的 `default` 分支，节点范围为原工作流，输出、参数和 disabledNodes 继承原字段。
- 老 `ComfyData.templateId` 自动配对该默认分支；不要求用户重新选择。
- 模板包格式升级为 `momoComfyTemplates: 2`，导入器继续接受 v1。
- 导出 v2 包时包含分支、颜色、语义槽和验证指纹，但不包含本地模型文件或真实素材。
- 原有普通 ComfyUI 节点的运行方式不变；只有选择了多分支模板时才要求 `variantId`。

### 18.10 ComfyUI 分支技术落点

建议修改：

- `src/core/types.ts`：增加 `ComfyVariant`、variant color、`ComfyData.variantId/paramsByVariant`。
- `src/core/services/comfy.ts`：新增 `extractVariantWorkflow` 纯函数；`runComfyTemplate` 接收 `variantId`，先提取再处理 disabled 和素材。
- `src/core/stores/comfyStore.ts`：增加 v1 → v2 normalize，保存时保留分支。
- `src/modules/comfy/wfGraph.ts`：增加连通分量、祖先闭包、分支布局、选框命中等纯函数。
- `src/modules/comfy/TemplateManager.tsx`：增加框选状态、分支工具条、颜色、共享节点、输出指定和右侧分支合同。
- `src/modules/comfy/templateIO.ts`：模板包 v2 导入导出。
- 新增 `src/ui/ComfyTemplatePicker.tsx`：主模板/子分支二级菜单。
- `src/modules/canvas/ComfyConfigPanel.tsx`：使用新 picker，按 variant 显示参数并恢复各分支值。
- `src/core/runner.ts`：把 `variantId` 传给 service，错误来源显示具体分支。

### 18.11 ComfyUI 分支验收用例

1. 导入包含图像放大和视频放大的 SeedVR2 单文件，编辑器能建议两个独立块。
2. 框选图像链，创建蓝色“图像放大”分支并指定图片输出；框选视频链，创建绿色“视频放大”分支并指定视频输出。
3. 两个分支共享模型加载节点时，系统要求明确标记共享，最终两边都能通过依赖校验。
4. 节点选择器一级显示 SeedVR2，悬停、点击和键盘都能打开二级菜单。
5. 选择图像放大时只显示图片参数和图片输入；实际提交 JSON 不包含视频分支节点。
6. 选择视频放大时只显示视频参数和视频输入；实际提交 JSON 不包含图像分支节点。
7. 在两个子菜单间切换后，各自参数值仍保持。
8. 框选漏掉必要上游时，试运行前列出缺失依赖，不提交残缺工作流。
9. 两个分支错误重叠非共享节点时阻止保存。
10. 修改原工作流或分支节点归属后，原语义槽验证状态失效。
11. 老模板和老画布无需手工迁移即可继续运行默认分支。
12. 导出再导入模板包后，主菜单、子菜单、颜色、参数、输出和语义槽全部保留。

## 19. 四套能力的统一开发顺序

新的合并范围包括 ComfyUI 分支、Ollama 本地模型、Skill 和导演台，建议用下面的顺序取代“先把导演台全部做完”的做法：

1. **Comfy 模板 v2 数据兼容**：先实现 `ComfyVariant`、默认分支 normalize 和 v2 导入导出，确保老模板无回归。
2. **子工作流执行内核**：实现 include-list、依赖闭包、共享节点和纯函数校验；先用固定数据验证，不急着做复杂 UI。
3. **分支编辑器与二级菜单**：框选、彩色块、主/子菜单、分支参数记忆。
4. **Ollama 本地服务商**：增加自动发现、无需 Key、模型能力与释放显存，先让本机模型能稳定参与聊天和提示词工具。
5. **Skill 基础设施**：`skillStore`、安全导入、管理页和内置一个简单提示词 Skill。
6. **Skill 执行与提示词入口**：接入 `PromptAiTools`，完成变量、预览、替换、快照和冲突提示。
7. **海报结构化 Skill**：验证 Skill 不仅能改写文本，还能输出并应用比例、网格、层级和安全区。
8. **导演台项目壳与持久化**：实现原第 15 节的项目壳任务。
9. **外部剧本导入与规则层**：支持已有分段、目标时长、全局正向/负向规则和 Skill 继承。
10. **导演台图片/视频配方**：同时支持 `templateId + variantId` 的本地 Comfy 配方和 `providerModelKey` 的 Seedance/中转站配方。
11. **批量队列与选片**：生成所选、生成缺失、生成已修改、失败重试、多 Take 和跨重启恢复。
12. **质量检查与批量后处理**：把低分辨率、帧率不足的片段送入 Comfy 放大/补帧分支，再回写时间线。
13. **导演台 Skill 栈**：项目继承、Scene/Segment 覆盖、模型适配与 Take 快照。
14. **优秀范例拆解与提示词配方**：保留原文，拆出场景、动作、景别、构图、镜头、光线、风格、连续性和负向规则，再与镜头大纲组合。
15. **剧情覆盖与连续性状态**：按镜头保存进入/结束状态，检查缺片、重复、剧情跳跃和人物/道具/机位冲突。
16. **音频导演台**：对白/旁白绑定镜头，环境音/音乐绑定场景，支持声线、读音、时长适配、字幕对齐和分轨导出。
17. **故事串片预演与标准交付包**：只做硬切检查，不建设多轨 NLE；输出编号素材、音频分轨、SRT、镜头表和预演片。
18. **Premiere XML / Bridge**：先交付可导入 XML，后续可选 UXP 插件；剪映首版使用稳定素材包，私有草稿适配仅作实验。
19. **3D 站位参考器**：只做现成模型站位、预设姿势、相机、简单光源和控制图，不做 Blender 替代品。

这样安排的原因是：导演台依赖 ComfyUI 分支和 Skill 的最终数据合同。如果先把导演台写死在旧 `templateId` 和普通提示词字符串上，后续一定会进行一次大迁移。

合并后的最终产品链路是：

```text
用户故事 / 文案 / 普通提示词
        ↓
本地 Ollama / 远程对话模型：按隐私策略提供分析与编写能力
        ↓
MOMO Skill：完善、比例/排版/镜头规则、模型适配、校验
        ↓
导演台或普通生成节点：保存可编辑结构与素材槽
        ↓
ComfyUI 主模板 / 子工作流：精确选择实际运行分支
        ↓
图片或视频结果 → Take / 历史 / 资产库 / 时间线
```

这会让 MOMO 从“可以调用很多工具”升级为“能安装创作方法、能理解工作流分支、能管理完整生产过程”的 AI 创作工作站。

## 20. 模型无关的导演台批量生产

### 20.1 重新确认产品边界

导演台不是 MiniMax H3 专用前端。H3 只是首个用于验证“本地 ComfyUI + 多参考 + 首尾帧”的配方。导演台中的剧本、场景、Segment、Shot、规则、素材槽、Take 和时间线都必须与具体模型解耦。下面的结构是对第 7.5 节简版 `DirectorRecipe` 的最终扩展。

同一个 Segment 可以使用：

- 本地 ComfyUI 的 H3 T2V、I2V、FL2V 或 R2V 分支。
- 中转站提供的 Seedance 2.0。
- MOMO 已支持或以后增加的可灵、Veo、Vidu、海螺、Sora、Wan 等视频模型。
- 用户自定义的视频协议。

导演数据保持不变，变化的只是 `DirectorRecipe`。本地配方保存 `templateId + variantId`，远程配方保存 `providerModelKey + protocol snapshot`。

```ts
type DirectorRecipe = {
  id: string;
  name: string;
  engine: "comfy" | "provider";
  output: "image" | "video";
  mode: "t2i" | "i2i" | "t2v" | "i2v" | "fl2v" | "r2v" | "v2v";
  templateId?: string;
  variantId?: string;
  providerModelKey?: string;
  capabilitySnapshot: {
    maxDurationSec?: number;
    durations?: number[];
    aspects?: string[];
    resolutions?: string[];
    firstFrame: boolean;
    lastFrame: boolean;
    referenceImages: number;
    referenceVideos: number;
    referenceAudio: number;
    nativeAudio: boolean;
  };
  defaultParams: Record<string, string | number | boolean>;
};
```

能力快照来源：

- 第三方模型复用现有 `videoMeta.ts` 与 `resolveModelCard("video")`。
- 自定义协议由 `protoSpec` 和协议能力体检提供。
- ComfyUI 分支由 semantic slots、输出类型和已验证合同提供。

切换配方时，导演台要显示不兼容项。例如某段有尾帧，但 Seedance 当前配方不支持尾帧，应让用户选择“改用参考图”“忽略尾帧”或“取消切换”，不能静默丢弃。

### 20.2 外部剧本与已有分段导入

用户可以在任何 AI、写作软件或文本编辑器中完成剧本，再导入导演台。导入器应把外部工具当作正常入口，而不是要求用户必须在 MOMO 内写剧本。

支持格式：

- 纯文本、Markdown。
- 后续支持 Fountain、Final Draft XML。
- 从剪贴板粘贴。
- 结构化 JSON，用于其他 AI 直接输出 MOMO 剧本结构。

自动识别的分隔符示例：

```text
分段1
……
分段2
……

---

### 分段 3 [15s]
……

<<<SEGMENT>>>
```

默认识别规则：

- `分段1`、`分段 1`、`第1段`、`片段1`、`Scene 1`、`Segment 1`。
- Markdown 二级/三级标题。
- 单独一行的 `---`、`***` 或用户指定符号。
- 用户输入的自定义正则表达式；高级项必须提供测试预览和错误保护。

导入向导提供三种模式：

1. **严格保留已有分段**：不重新合并，只分析每段内部的 Shot。
2. **保留边界并按时长细分**：外部分段作为 Scene，超过模型上限时在内部继续拆 Segment。
3. **仅把分隔符作为建议**：AI 可为节奏调整边界，但必须展示调整前后差异。

任何模式都保留原始全文和每段的字符范围。AI 分析失败时仍能用分隔符完成确定性切分，不应因为本地/远程模型不可用而无法导入。

时长处理：

- 用户可以设置成片目标，例如 180 秒。
- 文本头部的 `[15s]`、`时长: 12秒` 优先成为显式时长。
- 未写时长的段落按对白、动作量和节奏权重分配。
- 单段超过当前视频配方上限时提示细分，不直接截掉文本。
- 总时长与目标不一致时显示差值，并提供“重新分配未锁定片段”。

### 20.3 批量生成不是逐镜自动点击

导演台的核心操作应该是批量集合，而不是让用户重复按几十次生成按钮：

- **生成所选**：只生成勾选的 Segment。
- **生成缺失**：没有成功视频 Take 的 Segment。
- **生成已修改**：提示词、规则、素材或配方相对采用 Take 已变化的 Segment。
- **重试失败**：只重新加入失败/中断任务。
- **生成全部草稿**：高风险动作，汇总后确认。

批量确认页至少显示：

- 任务数量与总目标视频秒数。
- 本地 ComfyUI、Seedance 中转站等各引擎的任务数量。
- 预计并发、预计计费或“本地算力”。
- 使用的画幅、分辨率、时长和音频策略。
- 缺失的首帧、参考素材和必填参数。

队列可以混合引擎，但调度器按执行池隔离：

```text
ComfyUI 本地池：默认并发 1
远程视频池：按服务商/协议配置并发与速率
本地 LLM 池：剧本分析、Skill 和提示词编译
本地后处理池：放大、补帧、转码
```

同一 Segment 同一时刻只允许一个会写入采用候选的主视频任务，防止重复点击造成不可区分的并发版本；用户主动选择“并行出 3 版”时则创建三个明确 Take。

远程 API 或中转站结果由 MOMO 自动轮询、回收并落资产库，不需要用户下载再导回。只有使用不提供 API 的网页工具时，才提供“导入外部结果并绑定到 Segment”的手工通道。

### 20.4 全局、场景和分段规则

“统一风格、场景定调、不要字幕、不要背景音乐”不能只靠给每个提示词尾部拼一段文字。建议保存为结构化规则：

```ts
type DirectorRuleSet = {
  name: string;
  positive: {
    style?: string;
    visualTone?: string;
    lighting?: string;
    cameraLanguage?: string;
    sceneContinuity?: string;
    promptPrefix?: string;
    promptSuffix?: string;
  };
  negative: {
    noSubtitles?: boolean;
    noWatermark?: boolean;
    noBackgroundMusic?: boolean;
    noDialogue?: boolean;
    noText?: boolean;
    extra?: string[];
  };
  generation: {
    aspect?: string;
    resolution?: string;
    fps?: number;
    nativeAudio?: boolean;
  };
  sourceSkillSnapshots?: SkillRunSnapshot[];
};
```

作用范围和优先级：

```text
用户对当前 Segment 的明确设置
  > Scene 覆盖
  > Project 全局规则
  > Skill 默认值
  > 模型配方默认值
```

规则编译时采用模型能力优先映射：

- 模型有原生 `audio=false` 参数时，“不要背景音乐/不要声音”同时写入参数和提示词。
- 模型只有提示词控制时，编译成自然语言负向约束。
- 模型支持 negative prompt 时写入独立字段。
- “不要字幕”与“画面不要任何文字”是两条不同规则，不能混为一个开关。
- H3、Seedance 等不同模型的表达方式由 model-adapter Skill 或内置适配器处理。

规则可以：

- 在导演台内直接创建和保存为预设。
- 从 Skill 导入并绑定变量。
- 把当前规则反向导出为一个 MOMO Skill，供其他项目或海报节点复用。

修改 Project 规则后，受影响 Segment 标记“规则已变化”；用户可点击“重新编译提示词”，再选择“批量生成已修改”。旧 Take 和旧规则快照永久保留。

### 20.5 质量检查和批量后处理

生成完成不等于生产完成。导演台需要把 ComfyUI 的放大、补帧和修复工作流当作“后处理配方”，并允许批量应用：

```ts
type DirectorPostRecipe = {
  id: string;
  name: string;
  kind: "upscale-image" | "upscale-video" | "interpolate" | "denoise" | "restore" | "custom";
  templateId: string;
  variantId: string;
  inputKind: "image" | "video";
  outputKind: "image" | "video";
  defaultParams: Record<string, unknown>;
};
```

质量检查分两类：

- **确定性检查**：实际宽高、帧率、时长、文件损坏、是否有音轨、是否与项目画幅一致。
- **AI 辅助检查**：人物连续性、字幕/水印、画面崩坏、闪烁、动作异常；结果只作建议，显示模型与置信度。

批量操作：

- 放大所有低于项目目标分辨率的已采用片段。
- 只对勾选片段补帧。
- 对失败任务重试，不重复处理成功片段。
- 后处理产生新的派生 Take，原视频不被覆盖。
- 派生链记录 `原始 Take → 放大 → 补帧 → 时间线采用`，可随时回退。

SeedVR2 的图像放大和视频放大正好使用本文第 18 节的两个子工作流分支。导演台只需要选择对应后处理配方，就能把视频资产准确送进“视频放大”分支，而不会跑到图片链。

### 20.6 完整批量生产流程

```text
导入外部剧本/已有分段
→ 选择“保留分段”或“按时长细分”
→ AI 分析每段内部镜头
→ 应用项目规则、Scene 规则、Segment 覆盖和 Skill
→ 生成/导入分镜静帧与首尾帧
→ 批量预检
→ 本地 H3 / Seedance 中转站 / 其他模型混合排队
→ 每段自动回收为多个 Take
→ 用户只处理不满意或已修改的片段
→ 确定性质量检查
→ 批量送 ComfyUI 放大、补帧、修复
→ 采用结果进入时间线
→ 预览、拼接、导出
```

### 20.7 批量生产验收用例

1. 粘贴以“分段1/分段2/分段3”标记的剧本，选择严格保留后准确得到三个外部分段。
2. 导入 180 秒剧本，显式短段不被合并，超出当前模型上限的长段能在内部继续拆分。
3. 同一项目中，第 1～5 段使用本地 H3，第 6～12 段使用 Seedance 中转站，结果仍进入统一 Take 和时间线。
4. 点击“生成缺失”只创建没有成功视频的任务，不重跑已采用片段。
5. 修改全局风格后所有受影响片段标“规则已变化”，点击“生成已修改”只重跑这些片段。
6. “不要字幕”和“不要背景音乐”应用到每段；支持原生参数的模型同时正确设置参数。
7. 本地 Comfy 默认串行，远程模型按服务商并发；互不错误占用同一并发计数。
8. 关闭导演台后队列继续，重新打开能看到准确进度。
9. 不满意片段修改提示词后生成新 Take，原结果与采用状态可追溯。
10. 低分辨率视频批量进入 SeedVR2 视频放大分支，图片放大分支没有被提交。
11. 补帧或放大失败只影响派生任务，原始 Take 仍可预览和采用。
12. 整条 3 分钟项目能够通过“生成缺失 → 选片 → 后处理 → 导出”完成，不要求逐段手工触发。

## 21. Ollama、GGUF 与本地私密模型

### 21.1 本机检查结果

已检查用户给出的目录：

```text
G:\ciomfyui AI\ComfyUI-aki-v3\ComfyUI\models\LLM\QWEN3.5
```

目录中包含：

- `qwen3.5-9b-nsfw-captioning-v5.Q4_K_M.gguf`，约 5.24 GiB。
- 配套 `qwen3.5-9b-nsfw-captioning-v5.mmproj-Q8_0.gguf`，约 0.58 GiB。
- `Qwen3.5-27B-heretic-v2-Q4_K_S.gguf`，约 14.50 GiB。
- `Qwen3.5-27B-heretic.Q2_K.gguf`，约 9.43 GiB。
- 标准 `Qwen3.5-27B-Q6_K.gguf`，约 20.91 GiB，以及多个 mmproj 文件。
- 标准 `Qwen3.5-9B-Q8_0.gguf`，约 8.87 GiB。

文件头确认为 GGUF v3。仅凭本地文件名无法验证这些社区微调模型的原始模型卡、训练内容和许可证，MOMO 的导入页应要求用户补充来源并确认许可证。

本机同时满足：

- Ollama 0.32.7 已安装并运行。
- 已有 `qwen3.5:9b`、`qwen3.5:27b`、`qwen3-vl:8b`、`qwen2.5vl:3b`。
- GPU 为 RTX 5090 32GB，系统内存约 64GB。

因此 9B 和 27B Q4 级模型用于本地聊天、剧本分析和提示词优化在硬件上可行。27B Q6 也可能装入显存，但长上下文 KV cache、ComfyUI 视频模型和其他 GPU 任务会继续占用显存，不能仅按 GGUF 文件大小判断能否并行。

### 21.2 当前 MOMO 已能临时直连 Ollama

MOMO 当前对话服务已经支持 OpenAI 兼容 `/chat/completions`，Ollama 官方也提供该兼容接口。因此在不改代码的情况下，可以新建一个普通服务商：

```text
服务商名称：Ollama 本地
Base URL：http://127.0.0.1:11434/v1
API Key：ollama
对话协议：OpenAI 兼容
模型：qwen3.5:9b 或 qwen3.5:27b
```

当前设置页强制 API Key 非空，所以填写 `ollama`；Ollama 官方说明这个 Key 会被忽略。参考：[Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)。

这个临时方案已经能让本机 Ollama 模型参与：

- 创作助手聊天。
- `llmTextTransform` 提示词优化。
- Skill 执行。
- 导演台剧本分析、分镜拆分和提示词编译。

它不能自动导入尚未注册到 Ollama 的自定义 GGUF，也不能很好地控制 thinking、结构化输出、模型卸载和显存协调，因此仍建议增加原生 Ollama 配置。

### 21.3 正式的 Ollama 服务商

在 `ChatProtocol` 增加 `ollama`，设置页提供“Ollama 本地”预设：

- 默认地址 `http://127.0.0.1:11434`。
- 不要求 API Key。
- 通过 `/api/tags` 自动列出本机模型。
- 通过 `/api/show` 或能力返回识别 completion、vision、tools、thinking。
- 通过 `/api/chat` 支持流式文本、单独 thinking、结构化输出和 `keep_alive`。
- 提供“测试文本”“测试图片”“立即释放显存”。
- 在模型选择器显示“本地”徽标和预计模型大小。

Ollama 原生 Chat API 位于 `http://localhost:11434/api/chat`，支持多轮 messages；`keep_alive: 0` 可在请求完成后立即卸载模型。参考：[Ollama Chat API](https://docs.ollama.com/api/chat)、[Ollama API 基础地址](https://docs.ollama.com/api/introduction)。

建议用途预设：

- 提示词快速优化：9B、`think=false`、较短输出。
- 剧本分析/结构化拆分：27B、适中 thinking、JSON schema。
- 图片反推：已验证 vision 的模型，如官方 `qwen3.5:9b` 或 `qwen3-vl:8b`。
- 私密 Skill：强制本地模型且禁止自动回退远程。

### 21.4 自定义 GGUF 导入向导

MOMO 不应把 GGUF 塞进 ComfyUI 对话插件，也不应在 React 渲染进程直接加载几十 GB 权重。正确结构是：

```text
MOMO UI → 本地推理服务（Ollama 或 llama-server）→ GGUF
```

导入向导：

1. 选择主 GGUF。
2. 读取 GGUF 元数据和文件大小，推断架构、量化、上下文与是否需要视觉投影。
3. 扫描同目录的 `mmproj*.gguf`，让用户手工确认配对，不能只靠相似文件名自动决定。
4. 选择运行后端：Ollama 或 llama.cpp。
5. 设置 MOMO 显示名、上下文、GPU 层、thinking 默认值和系统提示词。
6. 展示预计磁盘额外占用；Ollama 导入通常会在自己的模型仓库创建内容寻址 blob。
7. 用户确认后创建模型，并执行文本测试；选择 mmproj 时再执行图片测试。
8. 测试失败保留日志和配置草稿，不删除原始 GGUF。

Ollama 官方 Modelfile 支持通过 `FROM ./model.gguf` 导入本地单文件 GGUF，并用 `ollama create` 注册。参考：[Ollama Modelfile 与 GGUF 导入](https://docs.ollama.com/modelfile)。

### 21.5 当前这些 Qwen3.5 文件的推荐调用方式

按目标拆开处理最稳妥：

#### 只需要文本聊天、特殊问题和提示词优化

- 优先把主 GGUF 作为**文本模型**导入 Ollama，不附加 mmproj。
- `Qwen3.5-27B-heretic-v2-Q4_K_S.gguf` 更适合较高质量本地对话；`qwen3.5-9b-nsfw-captioning-v5.Q4_K_M.gguf` 更轻、更快，但它的微调目标从文件名看偏向 captioning，实际聊天质量要通过测试集判断。
- MOMO 将其作为普通 `chat` 角色模型，Skill、提示词工具和导演台都能直接选择。

#### 需要图片理解或图片反推

- 主模型必须与正确的 mmproj 配套。
- 当前 Ollama 版本已比 Qwen3.5 外部 GGUF早期兼容问题所涉及的版本更新很多，但 Ollama 官方 Modelfile 文档仍只明确示例单个 GGUF；自定义 Qwen3.5 + 分离 mmproj 应由导入向导实际测试，不能在设计上承诺所有社区文件一定成功。
- 若 Ollama 无法正确加载配套 mmproj，使用 `llama-server` 作为兼容后端：它明确支持 `-m model.gguf --mmproj mmproj.gguf` 和 OpenAI 兼容 `/v1/chat/completions`。参考：[llama.cpp server 官方文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)。

因此，对用户当前最重要的需求——“加载后直接聊天，并用于优化提示词”——不需要等待 ComfyUI 插件，也不需要先解决视觉 mmproj；先把主 GGUF作为文本模型接入 Ollama即可。

### 21.6 本地与远程模型路由

为 Skill 和导演台增加模型策略：

```ts
type LlmRoutePolicy = {
  primaryModelKey?: string;
  fallbackModelKey?: string;
  privacy: "local-only" | "prefer-local" | "allow-remote";
  thinking: false | "low" | "medium" | "high";
  unloadAfterRun?: boolean;
};
```

- `local-only`：本地模型不可用就报错，不把内容发送到远程。
- `prefer-local`：先本地，失败时必须询问用户是否改用远程，不能静默上传。
- `allow-remote`：按普通重试策略使用中转站。
- UI 根据实际 URL 和模型来源显示“本机 / 局域网 / 外部”徽标；不能仅因为服务商名叫“本地”就宣称数据未上传。

### 21.7 GPU 资源协调

用户机器的 RTX 5090 32GB 能运行这些模型，但 H3/视频放大与 27B LLM 同时驻留很容易争抢显存。增加 `localComputeStore`：

- 记录 Ollama、ComfyUI 和本地后处理任务。
- 导演台开始 H3 或 SeedVR2 大任务前，可提示释放 Ollama 模型。
- 提示词编译完成后，如果配置了 `unloadAfterRun`，通过 `keep_alive: 0` 释放。
- 不自动杀死 ComfyUI 或 Ollama 进程；只调用各自正常的模型卸载/任务取消接口。
- 显存不足错误进入报错中心，并建议降低上下文、改用 9B、串行执行或释放其他模型。

### 21.8 Ollama 技术落点

- `src/core/types.ts`：`ChatProtocol` 增加 `ollama`，增加本地模型策略和可选运行参数。
- `src/core/services/ollama.ts`：tags、show、chat、create、unload、版本和能力检测。
- `src/core/services/llm.ts`：统一入口增加 Ollama native adapter；保留 OpenAI 兼容回退。
- `src/core/services/modelList.ts`：Ollama 走 `/api/tags`，不走 `/v1/models` 猜测。
- `src/modules/settings/SettingsDialog.tsx`：Ollama 预设允许空 Key，增加本地模型状态、导入 GGUF 和释放显存。
- 新增 `src/modules/settings/GgufImportDialog.tsx`：只在用户确认后调用 `ollama create` 或启动受控 llama-server sidecar。
- 新增 `src/core/stores/localComputeStore.ts`：本地 GPU 任务与卸载协调。
- `src/core/skillEngine.ts`、导演台和创作助手都只消费 `ModelCard/LlmRoutePolicy`，不能各自直接请求 Ollama。

### 21.9 Ollama/GGUF 验收用例

1. 设置页自动发现 `http://127.0.0.1:11434` 和现有 qwen3.5 模型，无需 API Key。
2. `qwen3.5:9b` 能在创作助手多轮聊天，并能执行一次提示词优化 Skill。
3. 导演台用本地 27B 把外部剧本解析成结构化 Segment，不把文本发到远程。
4. `local-only` 模式下关闭 Ollama，只显示本地不可用错误，不发生远程回退。
5. 导入单文件文本 GGUF 后能文本对话；原文件未移动或删除。
6. 选择 mmproj 的模型必须通过图片测试后才显示“视觉”能力。
7. Ollama mmproj 测试失败时可改用 llama-server 配置，MOMO 仍通过统一聊天接口使用。
8. 模型导入前显示预计额外磁盘占用和来源/许可证确认。
9. 提示词任务完成后设置 `unloadAfterRun`，模型从 Ollama 运行列表释放。
10. ComfyUI 视频任务运行时本地 LLM 队列等待或提示冲突，不造成两个任务无提示抢显存。

## 22. 全能但不臃肿的产品与打包策略

### 22.1 产品结构

MOMO 可以成为全能工作台，但主界面仍保持“画布 + 右侧创作助手”。复杂能力以按需工作区和管理器打开：

- 导演台：项目节点进入全屏工作区。
- Skill：设置管理器 + 各提示词入口的小型选择器。
- ComfyUI 分支：模板编辑器内出现，普通用户只看主/子菜单。
- GGUF/Ollama：设置中的本地模型页，日常使用只显示模型选择器。
- 故事顺序预演、音频准备和 3D 站位：只在导演台内出现，不占用普通画布空间。

功能模块默认懒加载。未使用导演台、3D 或 GGUF 导入时，不加载 Three.js、串片预演和本地运行时管理 UI。

### 22.2 安装与发行形态

最终发行不应被理解为一个孤立的单 EXE。推荐提供两种官方形态：

1. **Windows 安装包**：安装 MOMO 主程序、协议注册、卸载入口和可选 sidecar。
2. **便携压缩包**：解压即用，数据目录和外部依赖路径可配置，适合已有 ComfyUI/Ollama 环境的用户。

组件拆分：

```text
MOMO Core                 必装，Tauri + React
ComfyUI Connector         内置连接能力，不捆绑用户模型
Ollama Connector          内置连接能力，Ollama 本体可检测/引导安装
llama.cpp Sidecar         可选，用于特殊 GGUF/mmproj 兼容
FFmpeg Sidecar            可选但推荐，用于可靠 MP4 拼接与转码
3D Previz Assets          可选资源包
Builtin Skills            小体积，可随主程序
AI Models                 不随 MOMO 主安装包分发，由用户选择本地目录或单独下载
```

这样可以避免：

- 把几十 GB 模型塞进安装包。
- 重复打包用户已经安装的 ComfyUI 和 Ollama。
- 因某个 sidecar 更新而重装全部应用。
- 让普通海报用户承担 3D 和视频工具的全部体积。

### 22.3 路径与套件管理

设置新增“本地套件”页，统一显示：

- ComfyUI 地址、目录、在线状态和版本。
- Ollama 地址、版本、模型目录和运行模型。
- llama.cpp sidecar 路径与版本。
- FFmpeg 路径与编码器能力。
- 资产库、Skill 和导演项目数据目录。

MOMO 只保存路径和检测结果，不擅自移动用户已有的 `G:\ciomfyui AI` 模型。路径失效时显示重新定位，不删除旧配置。

### 22.4 最终可行性判断

这轮新增需求全部可行，且现有架构已有大部分连接点：

- Seedance/中转站可沿用 `ProviderCard`、`resolveModelCard`、`videoMeta` 和自定义协议。
- 批量生成建立在已有 runner、资产落盘、任务中断保护和历史 Take 设计之上。
- 外部分段剧本主要新增确定性解析器与导入向导。
- 全局/负向规则与 Skill 可以共用同一结构化编译链。
- Ollama 能先通过现有 OpenAI 兼容协议使用，再升级成原生 adapter。
- 特殊 GGUF 的文本聊天不依赖 ComfyUI；分离 mmproj 的视觉能力可由 Ollama 测试或 llama-server 兜底。
- ComfyUI 放大和补帧可复用子工作流分支，成为导演台批量后处理配方。

真正需要控制的不是功能数量，而是边界：MOMO 负责项目、规则、调度、版本与统一体验；ComfyUI 负责节点式生成/后处理；Ollama 或 llama.cpp 负责本地 LLM 推理；FFmpeg 负责可靠媒体导出。按这个边界扩展，能力会越来越全，但主程序不会演变成难以维护的单体巨兽。

## 23. 最终产品边界与新增制作清单

本节记录开工前的最终决定；与前文早期表述冲突时，以本节和 README“导演台与本地创作编排（计划）”为准。

### 23.1 导演台是生产编排层，不是剪辑软件

导演台负责把整条 AI 视频生产链串起来：

```text
外部剧本 / 故事大纲
→ 场景、剧情段、镜头、Take
→ 范例拆解、Skill 与提示词编译
→ 本地 ComfyUI / Seedance 中转站 / 其他视频模型
→ 批量生成、选片、补缺和后处理
→ 音频准备与故事硬切预演
→ Premiere / 剪映交付包
```

导演台必须持续回答四个问题：

1. 故事计划拆成多少场景、剧情段和生成镜头。
2. 哪些镜头缺失、失败、未选择或生成后又发生了改动。
3. 当前采用版本串起来以后，剧情、动作和时长是否基本连贯。
4. 哪些素材已经锁定，可以交给专业剪辑软件继续处理。

导演台不提供专业多轨剪辑、复杂转场、调色、特效关键帧和剪辑插件。硬切预演只是生成质量与剧情完整性的检查工具。

### 23.2 ComfyUI 只做本地外接

MOMO 不内嵌 ComfyUI 页面，不实时控制其节点画布，也不重复制作节点编辑器。连接器只负责：

- 配置地址、检测在线状态和版本。
- 导入 UI/API 工作流并生成工作流指纹。
- 读取 APP Mode、子图与 `object_info` 等明确声明。
- 结合节点类型、端口和拓扑识别语义输入、可调参数及主/辅助输出。
- 在绑定向导中显示目标节点、判断依据和置信度；不确定项由用户确认一次。
- 上传素材、提交队列、查询状态、回收结果并写回正确项目/镜头/Take。
- 缺少模型、自定义节点或必要输入时，在提交前中文提示。

需要改工作流拓扑时提供“在 ComfyUI 中打开”。用户保存后，MOMO 重新扫描变更部分；没有变化的语义绑定继续保留。

### 23.3 优秀范例拆解与提示词配方

产品界面不使用含义不清的 `Scale`。如果表达远景、中景、近景，统一叫“景别”；如果表达可复用创作规则，叫“Skill”；如果表达从优秀案例提取的场景、镜头、构图和风格组合，叫“提示词配方”。

支持导入：

- 一段优秀提示词或多镜头提示词。
- 场景/分镜案例和参考图片。
- ComfyUI 工作流中已有的提示词文本。
- 用户自己保存的角色、海报、广告或视频案例。

系统保留原始内容，再生成可编辑拆解：

```text
主体 / 角色
场景 / 时间 / 天气
动作 / 情绪
景别 / 构图
机位 / 镜头焦段 / 运镜
光线 / 色彩
美术风格 / 质感
人物与道具连续性
负向规则
模型专用表达
```

镜头提示词不是简单拼接长文本，而是按来源组合：

```text
项目统一规则
> 场景规则
> 角色固定设定
> 当前镜头大纲
> 上一镜头结束状态
> 选中的提示词配方
> 单镜头覆盖
> 模型适配器
> 负向规则
```

每一层都可以查看来源、启用/停用和覆盖。编译器负责去重、发现冲突并转换成 H3、Seedance、ComfyUI 图片/视频或海报模型需要的表达；Skill 负责创作方法，模型适配器负责目标模型方言。

### 23.4 剧情完整性与连续性状态

数据层级固定为 `Project → Scene → StoryBeat/Segment → Shot → Take`。每个镜头除提示词外还保存：

- **进入状态**：人物站位、朝向、服装、道具、动作、情绪、时间、光线和机位。
- **结束状态**：镜头结束时的上述状态、尾帧资产和下一镜头可继承内容。
- **剧情覆盖**：此镜头负责表现的剧本原文范围和剧情事件 ID。

系统据此检查：

- 原文是否存在没有镜头覆盖的段落。
- 是否缺少动作过渡或必要反应镜头。
- 是否出现重复剧情段、镜头顺序错误或目标时长缺口。
- 人物、服装、道具、时间、光线、运动方向和机位是否发生明显冲突。

视觉 AI 检查只给建议、依据和置信度，不把“不一致”当作绝对事实。最可靠的连续方式仍是把已采用镜头的尾帧和结束状态显式传给下一镜头。

### 23.5 音频导演台

音频使用同一项目结构，不另外建设音频编辑器：

- 对白、旁白绑定到镜头或剧情段。
- 环境底音和背景音乐绑定到场景，避免每个镜头重新开始。
- 动作音效绑定到镜头中的剧情事件或时间点。
- 角色绑定声线、读音词典、语言、情绪、语速和音量默认值。

提供两种制作策略：

1. **对白优先**：先生成对白并取得真实时长，再确定镜头时长和生成配方。
2. **画面优先**：画面锁定后，让 TTS 调整语速和停顿以适配镜头时长。

同一句台词允许多个 Take，采用逻辑与视频一致。字幕由采用对白进行对齐。近景对白可以创建独立口型任务，普通镜头不强制口型同步。默认建议视频模型生成无字幕、无背景音乐的视频，声音由 MOMO 分轨准备并交给剪辑软件。

### 23.6 Premiere 与剪映交付

标准交付目录至少包含：

```text
01_已确认视频
02_对白
03_旁白
04_音效
05_环境音与音乐
06_字幕
07_镜头清单与项目清单
08_Premiere_XML
09_故事预演
```

素材使用稳定、补零的名称，例如 `EP01_SC03_SH005_TAKE02_已确认.mp4`。镜头顺序来自项目数据，不依赖文件系统偶然排序。

Premiere 首版输出 Final Cut Pro 7 XML：V1 放已确认视频，A1～A5 分别放对白、旁白、音效、环境音和音乐，并写入场景/剧情段/镜头标记。后续可增加轻量 UXP Bridge 插件，实现从 MOMO 项目清单一键创建素材箱、序列、轨道和标记；不直接生成或修改私有 `.prproj`。

剪映首版输出编号素材、SRT、音频分轨、镜头表和预演片。若以后增加本地草稿适配，必须检测版本、修改前备份、失败回退并明确标为实验功能，不能让私有草稿格式成为项目数据的唯一出口。

### 23.7 3D 只做站位参考

3D 模块只允许导入现成 GLB/GLTF/VRM 或低模替身，进行位置、朝向、预设姿势、简单道具、相机、焦段和光源方向设置，并导出彩色站位图、轮廓、深度、法线、角色分区和姿势图。

不增加建模、骨骼绑定、复杂动画、材质编辑、雕刻或专业渲染。需要精细制作时交给 Blender；MOMO 只保存空间意图并把控制图准确送到 ComfyUI 或视频模型。
