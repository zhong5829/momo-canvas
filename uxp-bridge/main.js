/**
 * MOMO Bridge for Premiere Pro (UXP)
 *
 * 功能：从 MOMO 导演台导出的项目清单 JSON 一键创建 Premiere 序列、素材箱和轨道。
 * 方案 §23.6：不把 .prproj 私有格式作为目标，只通过 UXP API 建立素材箱/序列/轨道/标记。
 *
 * 使用方式：
 *  1. 在 MOMO 导演台剪辑页导出「项目清单 JSON」和「Premiere XML」
 *  2. 用 Adobe UXP Developer Tool 加载本插件
 *  3. 点「选择 MOMO 项目清单 JSON」→ 点「导入素材 + 创建序列」
 */

const { log, pickManifest, importAll, importTimeline } = (() => {
  const $ = (id) => document.getElementById(id);
  return {
    log: $("log"),
    pickManifest: $("pickManifest"),
    importAll: $("importAll"),
    importTimeline: $("importTimeline"),
  };
})();

let manifest = null;

function appendLog(msg) {
  const time = new Date().toLocaleTimeString();
  log.textContent += `[${time}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

/** 选择 MOMO 项目清单 JSON 文件 */
pickManifest.addEventListener("click", async () => {
  try {
    const file = await require("uxp").storage.localFileSystem.getFileForOpening({
      types: ["json"],
    });
    if (!file) return;
    const text = await file.read();
    manifest = JSON.parse(text);
    appendLog(`已加载项目：${manifest.projectName}`);
    appendLog(`时间线：${manifest.timeline?.length ?? 0} 段，音频：${manifest.audioTracks?.length ?? 0} 轨`);
    appendLog(`场景：${manifest.scenes}，片段：${manifest.segments}`);
    importAll.disabled = false;
    importTimeline.disabled = false;
  } catch (e) {
    appendLog(`加载失败：${e.message || e}`);
  }
});

/**
 * 导入素材 + 创建序列（通过 Premiere 的 app.document API）
 * UXP 版 Premiere API 需要通过 require("premiere") 获取。
 */
importAll.addEventListener("click", async () => {
  if (!manifest) return;
  appendLog("开始导入…");
  try {
    // 创建素材箱
    const rootBin = await getRootBin();
    const momoBin = await createBin(rootBin, `MOMO · ${manifest.projectName}`);
    appendLog(`已创建素材箱：${momoBin.name}`);

    // 导入视频素材（从 timeline 的 takeId 映射，实际素材路径需要用户在同一目录提供）
    appendLog("请在弹出的对话框选择 MOMO 导出的视频素材文件夹…");
    const folder = await require("uxp").storage.localFileSystem.getFolder();
    if (!folder) {
      appendLog("未选择文件夹，跳过素材导入");
    } else {
      const files = await folder.getEntries();
      const videoFiles = files.filter((f) => f.isFile && /\.(mp4|mov|webm|avi|mxf)$/i.test(f.name));
      appendLog(`找到 ${videoFiles.length} 个视频文件`);
      // 通过 Premiere 导入这些文件
      await importFilesToBin(videoFiles, momoBin);
      appendLog("素材导入完成");
    }

    // 创建序列
    await createTimelineSequence(manifest);
    appendLog("✓ 全部导入完成");
  } catch (e) {
    appendLog(`导入失败：${e.message || e}`);
  }
});

/** 仅创建时间线序列（不导入素材文件） */
importTimeline.addEventListener("click", async () => {
  if (!manifest) return;
  appendLog("创建时间线序列…");
  try {
    await createTimelineSequence(manifest);
    appendLog("✓ 时间线序列已创建");
  } catch (e) {
    appendLog(`创建失败：${e.message || e}`);
  }
});

/** 获取根素材箱 */
async function getRootBin() {
  const app = require("premiere").app;
  const project = app.project;
  return project.rootBin;
}

/** 在父素材箱下创建子素材箱 */
async function createBin(parentBin, name) {
  // Premiere UXP API：project.rootBin.createBin(name)
  const app = require("premiere").app;
  // 尝试找已有同名 bin
  const existing = parentBin.children?.find((b) => b.name === name && b.isBin);
  if (existing) return existing;
  return await parentBin.createBin(name);
}

/** 把文件导入到指定素材箱 */
async function importFilesToBin(files, bin) {
  const app = require("premiere").app;
  const project = app.project;
  for (const f of files) {
    try {
      await project.importFile(f.nativePath || f.url, bin);
      appendLog(`  导入 ${f.name}`);
    } catch (e) {
      appendLog(`  跳过 ${f.name}（${e.message || e}）`);
    }
  }
}

/** 根据项目清单的时间线创建序列 */
async function createTimelineSequence(manifest) {
  const app = require("premiere").app;
  const project = app.project;
  const timeline = manifest.timeline ?? [];
  if (!timeline.length) {
    appendLog("时间线为空，跳过序列创建");
    return;
  }
  // 创建新序列（默认 1920×1080 或按 aspect 调整）
  const w = manifest.aspect === "9:16" ? 1080 : 1920;
  const h = manifest.aspect === "9:16" ? 1920 : 1080;
  const seq = await project.createNewSequence(`${manifest.projectName} · 时间线`, w, h);
  appendLog(`已创建序列：${seq.name}（${w}×${h}）`);

  // 写入标记（每个 timeline 条目 = 一个场景标记）
  let cursor = 0;
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const dur = entry.durationSec ?? 5;
    try {
      await seq.addMarker(cursor, `片段 ${i + 1}`, entry.segmentId, cursor, cursor + dur);
      appendLog(`  标记 ${i + 1}：${cursor.toFixed(1)}s - ${(cursor + dur).toFixed(1)}s`);
    } catch (e) {
      // addMarker API 可能因 Premiere 版本不同有差异
      appendLog(`  标记 ${i + 1} 写入失败（${e.message || e}）`);
    }
    cursor += dur;
  }
}

appendLog("MOMO Bridge 已就绪。点击「选择 MOMO 项目清单 JSON」开始。");
