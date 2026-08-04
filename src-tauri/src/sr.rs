//! 本地超分推理引擎（阶段二 + §5 倍率策略 + 双频段融合）
//!
//! 关键决策（对照实施文档）：
//! - ort 2.x + DirectML（5090 是 sm_120，CUDA EP 无 kernel，DirectML 走 DX12 唯一稳路）。
//! - §5 倍率策略 + 内存上限 CAP：目标≤原图→不跑 SR 只重采样；否则预算模型输入使输出≈min(目标,CAP)，
//!   避免大图 4x 产生 16K 中间图在融合阶段爆内存/卡顿（曾卡 82% 的根因）。
//! - 主模型(NomosWebPhoto)保色结构 + 细节模型(UltraSharp)补高频，内容掩膜×权重路由，
//!   双频段融合（比拉普拉斯金字塔快 ~3x，文档 §4.6 允许的等价多频段）。
//! - 笨 Tile + 三角窗无缝拼接；Alpha 单独缩放回贴；精确缩放到目标长边（可上采到目标）；原子写。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::enhance2::{
    analyze, content_mask, enforce_source_consistency, fuse_2band, gate_candidate_weight,
    guard_detail_deviation, hard_edge_mask, suppress_halos, FidelityReport, QualityReport,
};
use image::{imageops, GenericImageView, ImageBuffer, Luma, Rgba, RgbaImage};
use ndarray::{Array2, Array3, Array4, Ix4};
use ort::{session::Session, value::TensorRef};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::Channel;

type SResult<T> = Result<T, String>;
const DETAIL_TIMEOUT_MSG: &str = "细节模型超过安全时限，已自动回退主模型";
fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

type SharedSession = Arc<Mutex<Session>>;

type CancelMap = Mutex<HashMap<String, std::sync::Arc<AtomicBool>>>;
static CANCELS: OnceLock<CancelMap> = OnceLock::new();
fn cancels() -> &'static CancelMap {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn register_task(id: &str) -> std::sync::Arc<AtomicBool> {
    let flag = std::sync::Arc::new(AtomicBool::new(false));
    cancels()
        .lock()
        .unwrap()
        .insert(id.to_string(), flag.clone());
    flag
}
fn unregister_task(id: &str) {
    cancels().lock().unwrap().remove(id);
}
pub fn request_cancel(task_id: &str) {
    if let Some(flag) = cancels().lock().unwrap().get(task_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceConfig {
    pub scale: u32,
    pub tile_size: u32,
    pub tile_overlap: u32,
    pub target_long_edge: Option<u32>,
    pub detail_model_path: Option<String>,
    pub detail_weight: f32,
    /// 去压缩预处理："auto"(jpegScore>0.3 触发) | "on"(强制) | "off"(关闭)
    #[serde(default = "default_dejpeg")]
    pub dejpeg: String,
    /// DeJPG 1x 模型路径（None = 不跑预处理）
    pub dejpeg_model_path: Option<String>,
    /// 输出位深：8=普通；16=专业印刷无损（仅 PNG/TIFF 生效，JPEG 强制 8 位）
    #[serde(default = "default_bit_depth")]
    pub bit_depth: u8,
    /// 人脸检测（SCRFD）模型路径：Some 时启用人脸分支（人像档）
    #[serde(default)]
    pub face_detect_model_path: Option<String>,
    /// FaceUpDAT 4x 人脸增强模型路径（中等人脸 ROI 用）
    #[serde(default)]
    pub face_upscale_model_path: Option<String>,
    /// 小脸生成式修复："identity"(不修复) | "gfpgan" | "codeformer"
    #[serde(default = "default_face_restore")]
    pub face_restore: String,
    /// GFPGAN / CodeFormer 模型路径（可选模型，未下载为 None → 跳过生成式修复）
    #[serde(default)]
    pub face_restore_model_path: Option<String>,
    /// 输出格式 "png"|"jpeg"|"tiff"（印刷/无损工作流用 TIFF）
    pub output_format: String,
    /// 输出 DPI 元数据；印刷尺寸使用用户设置，普通屏幕输出通常为 72。
    pub output_dpi: Option<u32>,
    /// 是否额外输出 vectorGuide（保结构引导图）+ analysisMap（内容分析 JSON）资产供矢量化节点复用
    pub emit_assets: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum SrEvent {
    Stage { stage: String, pct: f32 },
    Progress { pct: f32 },
    Log { msg: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceResult {
    pub out_path: String,
    pub width: u32,
    pub height: u32,
    pub elapsed_ms: u64,
    pub tiles: u32,
    /// 主模型实际使用的 Tile；显存回退后可能小于请求值
    pub tile_size_used: u32,
    /// 基于实际 Tile 与管线复杂度的保守显存估算（不是驱动实时读数）
    pub estimated_vram_mb: u32,
    pub backend: String,
    pub pipeline: String,
    pub quality: Option<QualityReport>,
    /// 缩回源尺寸的一致性与候选细节拒绝统计；用于生产质量门禁和 UI 报告。
    pub fidelity: Option<FidelityReport>,
    /// analysisMap JSON 资产路径（内容分析契约，供矢量化节点复用）
    pub analysis_path: Option<String>,
    /// vectorGuide PNG 资产路径（保结构引导图契约）
    pub vector_guide_path: Option<String>,
    /// 人脸分支报告（人像档）：检测数 / ROI 增强数 / 生成式修复数 / 小脸警告
    pub face_report: Option<String>,
}

pub fn run(
    task_id: &str,
    input_bytes: &[u8],
    out_path: &str,
    model_path: &str,
    cfg: &EnhanceConfig,
    on_event: &Channel<SrEvent>,
) -> SResult<EnhanceResult> {
    let result = run_core(task_id, input_bytes, out_path, model_path, cfg, &|e| {
        let _ = on_event.send(e);
    });
    if result.is_err() {
        cleanup_failed_outputs(out_path);
    }
    result
}

fn cleanup_failed_outputs(out_path: &str) {
    // 任务取消/超时/失败时清理尚未成为正式资产的中间文件，避免 AppData 长期堆积孤儿文件。
    for path in [
        format!("{}.tmp", out_path),
        format!("{}.guide.png.tmp.png", out_path),
        format!("{}.analysis.json", out_path),
        format!("{}.guide.png", out_path),
        format!("{}.guide.json", out_path),
        format!("{}.mask.flat.png", out_path),
        format!("{}.mask.edge.png", out_path),
    ] {
        let _ = std::fs::remove_file(path);
    }
}

fn deadline_expired(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|at| Instant::now() >= at)
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

fn default_dejpeg() -> String {
    "auto".into()
}

fn default_bit_depth() -> u8 {
    8
}

fn default_face_restore() -> String {
    "identity".into()
}

/// 去压缩触发判定（纯函数便于单测）：off=关 / on=强制 / auto=jpegScore>0.3（文档 §4.3：>0.3 视为明显压缩）
fn should_dejpg(mode: &str, jpeg_score: f32, has_model: bool) -> bool {
    if !has_model || mode == "off" {
        return false;
    }
    mode == "on" || jpeg_score > 0.3
}

/// 写 analysisMap JSON + 像素级掩膜 PNG（flat 色块 / edge 边缘），供矢量化节点复用（文档 §7.1）
fn write_analysis_map(
    qa: &QualityReport,
    rgba: &RgbaImage,
    out_json: &str,
    source_id: &str,
    w: u32,
    h: u32,
) -> SResult<()> {
    let stem = out_json.trim_end_matches(".analysis.json");
    let flat_path = format!("{}.mask.flat.png", stem);
    let edge_path = format!("{}.mask.edge.png", stem);
    let (mw, mh) = crate::enhance2::write_analysis_masks(rgba, &flat_path, &edge_path)?;
    let sx = w as f32 / mw.max(1) as f32;
    let sy = h as f32 / mh.max(1) as f32;
    let m = serde_json::json!({
        "schemaVersion": 1,
        "sourceAssetId": source_id,
        "analysisWidth": mw, "analysisHeight": mh,
        "masks": { "flat": flat_path, "edge": edge_path },
        "degradation": { "jpegScore": round2(qa.jpeg_score), "noiseScore": round2(qa.noise), "blurScore": round2(qa.blur), "ringingScore": 0.0 },
        "content": { "type": qa.content_type, "edgeDensity": round2(qa.edge_density), "hardEdgeRatio": round2(qa.hard_edge_ratio), "flatRatio": round2(qa.flat_ratio), "brightness": round2(qa.brightness) },
        // 掩膜在 mw×mh 坐标系；映射回原图的缩放变换
        "modelSpaceTransform": [sx, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 1.0]
    });
    std::fs::write(out_json, m.to_string()).map_err(|e| format!("写 analysisMap 失败：{}", e))
}

/// 写 vectorGuide：保结构引导图（≤2x、≤4096、无最终锐化/生成修复/纹理增强）+ 元数据 JSON（文档 §7.2）
fn write_vector_guide(
    rgba: &RgbaImage,
    out_png: &str,
    out_json: &str,
    source_id: &str,
) -> SResult<()> {
    let (iw, ih) = (rgba.width(), rgba.height());
    let src_long = iw.max(ih);
    // 文档 §7.2 尺寸策略：<2048 翻倍(封顶4096)；2048-4096 原尺寸；>4096 缩到4096
    let guide_long = if src_long < 2048 {
        (src_long * 2).min(4096)
    } else {
        src_long.min(4096)
    };
    let r = guide_long as f32 / src_long.max(1) as f32;
    let (gw, gh) = (
        ((iw as f32 * r).round() as u32).max(1),
        ((ih as f32 * r).round() as u32).max(1),
    );
    let guide = imageops::resize(rgba, gw, gh, imageops::FilterType::Lanczos3);
    let tmp = format!("{}.tmp.png", out_png);
    guide
        .save(&tmp)
        .map_err(|e| format!("写 vectorGuide 失败：{}", e))?;
    std::fs::rename(&tmp, out_png).map_err(|e| format!("移动 vectorGuide 失败：{}", e))?;
    let meta = serde_json::json!({
        "schemaVersion": 1,
        "sourceAssetId": source_id,
        "imageAssetId": source_id,
        "width": gw, "height": gh,
        "processing": {
            "scale": r, "dejpeg": false, "denoiseStrength": 0.0,
            "edgePreserving": false, "finalSharpenApplied": false,
            "generativeRestorationApplied": false, "textureEnhancementApplied": false
        },
        "sourceToGuideTransform": [r, 0.0, 0.0, 0.0, r, 0.0, 0.0, 0.0, 1.0],
        "guideToSourceTransform": [1.0 / r.max(1e-6), 0.0, 0.0, 0.0, 1.0 / r.max(1e-6), 0.0, 0.0, 0.0, 1.0],
        "algorithmVersions": { "resize": "lanczos3" }
    });
    std::fs::write(out_json, meta.to_string())
        .map_err(|e| format!("写 vectorGuide 元数据失败：{}", e))
}

/// 把 (iw,ih) 按长边缩到 t（保宽高比，t 为新长边；可上采或下采）
fn target_dims(iw: u32, ih: u32, t: u32) -> (u32, u32) {
    let longest = iw.max(ih);
    if longest == 0 || longest == t {
        return (iw.max(1), ih.max(1));
    }
    let r = t as f32 / longest as f32;
    (
        (iw as f32 * r).round().max(1.0) as u32,
        (ih as f32 * r).round().max(1.0) as u32,
    )
}

/// 按指定格式写图（PNG/TIFF 保 Alpha；JPEG 先压平到 RGB）。不依赖文件扩展名。
fn extract_icc(input: &[u8]) -> Option<Vec<u8>> {
    use img_parts::{DynImage, ImageICC};
    DynImage::from_bytes(input.to_vec().into())
        .ok()??
        .icc_profile()
        .map(|bytes| bytes.to_vec())
}

fn save_image(img: &RgbaImage, path: &str, fmt: &str, dpi: u32, icc: Option<&[u8]>) -> SResult<()> {
    use std::fs::File;
    use std::io::BufWriter;
    if matches!(fmt.to_ascii_lowercase().as_str(), "tiff" | "tif") {
        use tiff::encoder::{colortype, Compression, Rational, TiffEncoder};
        use tiff::tags::Tag;
        let f = File::create(path).map_err(|e| format!("创建输出文件失败：{}", e))?;
        let mut enc = TiffEncoder::new(BufWriter::new(f))
            .map_err(|e| format!("初始化 TIFF 失败：{}", e))?
            .with_compression(Compression::Deflate(Default::default()));
        let mut image = enc
            .new_image::<colortype::RGBA8>(img.width(), img.height())
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(Tag::Software, "MOMO Canvas")
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(
                Tag::XResolution,
                Rational {
                    n: dpi.max(1),
                    d: 1,
                },
            )
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(
                Tag::YResolution,
                Rational {
                    n: dpi.max(1),
                    d: 1,
                },
            )
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(Tag::ResolutionUnit, 2u16)
            .map_err(|e| e.to_string())?;
        if let Some(profile) = icc {
            image
                .encoder()
                .write_tag(Tag::IccProfile, profile)
                .map_err(|e| e.to_string())?;
        }
        return image
            .write_data(img.as_raw())
            .map_err(|e| format!("编码 TIFF 失败：{}", e));
    }
    let format = match fmt.to_ascii_lowercase().as_str() {
        "tiff" | "tif" => image::ImageFormat::Tiff,
        "jpeg" | "jpg" => image::ImageFormat::Jpeg,
        _ => image::ImageFormat::Png,
    };
    let f = File::create(path).map_err(|e| format!("创建输出文件失败：{}", e))?;
    let w = BufWriter::new(f);
    if matches!(format, image::ImageFormat::Jpeg) {
        use image::ImageEncoder;
        // JPEG 不支持 Alpha → 压平到 RGB（白底）
        let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(w, 95);
        if let Some(profile) = icc {
            encoder
                .set_icc_profile(profile.to_vec())
                .map_err(|e| format!("写入 JPEG ICC 失败：{}", e))?;
        }
        encoder
            .write_image(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| format!("编码 JPEG 失败：{}", e))
    } else {
        use image::ImageEncoder;
        let mut encoder = image::codecs::png::PngEncoder::new(w);
        if let Some(profile) = icc {
            encoder
                .set_icc_profile(profile.to_vec())
                .map_err(|e| format!("写入 PNG ICC 失败：{}", e))?;
        }
        encoder
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("编码 PNG 失败：{}", e))
    }
}

/// 16 位无损输出（专业印刷档）：PNG/TIFF 支持 16 位 RGBA
fn save_image_16(
    img: &ImageBuffer<Rgba<u16>, Vec<u16>>,
    path: &str,
    fmt: &str,
    dpi: u32,
    icc: Option<&[u8]>,
) -> SResult<()> {
    use std::fs::File;
    use std::io::BufWriter;
    if matches!(fmt.to_ascii_lowercase().as_str(), "tiff" | "tif") {
        use tiff::encoder::{colortype, Compression, Rational, TiffEncoder};
        use tiff::tags::Tag;
        let f = File::create(path).map_err(|e| format!("创建输出文件失败：{}", e))?;
        let mut enc = TiffEncoder::new(BufWriter::new(f))
            .map_err(|e| format!("初始化 TIFF 失败：{}", e))?
            .with_compression(Compression::Deflate(Default::default()));
        let mut image = enc
            .new_image::<colortype::RGBA16>(img.width(), img.height())
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(Tag::Software, "MOMO Canvas")
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(
                Tag::XResolution,
                Rational {
                    n: dpi.max(1),
                    d: 1,
                },
            )
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(
                Tag::YResolution,
                Rational {
                    n: dpi.max(1),
                    d: 1,
                },
            )
            .map_err(|e| e.to_string())?;
        image
            .encoder()
            .write_tag(Tag::ResolutionUnit, 2u16)
            .map_err(|e| e.to_string())?;
        if let Some(profile) = icc {
            image
                .encoder()
                .write_tag(Tag::IccProfile, profile)
                .map_err(|e| e.to_string())?;
        }
        return image
            .write_data(img.as_raw())
            .map_err(|e| format!("编码 TIFF (16位) 失败：{}", e));
    }
    use image::ImageEncoder;
    let f = File::create(path).map_err(|e| format!("创建输出文件失败：{}", e))?;
    let w = BufWriter::new(f);
    let mut encoder = image::codecs::png::PngEncoder::new(w);
    if let Some(profile) = icc {
        encoder
            .set_icc_profile(profile.to_vec())
            .map_err(|e| format!("写入 PNG ICC 失败：{}", e))?;
    }
    let raw = bytemuck_u16_bytes(img.as_raw());
    encoder
        .write_image(
            raw.as_slice(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba16,
        )
        .map_err(|e| format!("编码 PNG (16位) 失败：{}", e))
}

fn bytemuck_u16_bytes(data: &[u16]) -> Vec<u8> {
    data.iter().flat_map(|value| value.to_ne_bytes()).collect()
}

pub fn run_core(
    task_id: &str,
    input_bytes: &[u8],
    out_path: &str,
    model_path: &str,
    cfg: &EnhanceConfig,
    progress: &dyn Fn(SrEvent),
) -> SResult<EnhanceResult> {
    let start = Instant::now();
    let cancel = register_task(task_id);
    struct Clean(String);
    impl Drop for Clean {
        fn drop(&mut self) {
            unregister_task(&self.0);
        }
    }
    let _clean = Clean(task_id.to_string());
    crate::model_cache::ensure_env();
    let input_icc = extract_icc(input_bytes);

    progress(SrEvent::Stage {
        stage: "解码输入".into(),
        pct: 0.05,
    });
    let img = image::load_from_memory(input_bytes).map_err(|e| format!("解码输入图失败：{}", e))?;
    let (iw, ih) = img.dimensions();
    let rgba: RgbaImage = img.to_rgba8();
    let qa = analyze(&rgba);
    // detail_weight<0 表示“自动”：前端只给保守基准，最终按本次输入的真实分析结果调节。
    // 显式内容模式/手动强度传正数，不在这里擅自改用户选择。
    let detail_weight = if cfg.detail_weight < 0.0 {
        let base = cfg.detail_weight.abs();
        let type_factor = match qa.content_type.as_str() {
            "photo" => 0.75,
            "illustration" => 1.15,
            _ => 1.0,
        };
        // 平色块与硬边越多，越应减少学习型细节贡献，避免给字体灌纹理或产生双描边。
        let flat_factor = if qa.flat_ratio > 0.72 { 0.72 } else { 1.0 };
        let hard_edge_factor = if qa.hard_edge_ratio > 0.04 { 0.68 } else { 1.0 };
        (base * type_factor * flat_factor * hard_edge_factor).clamp(0.05, 0.45)
    } else {
        cfg.detail_weight.clamp(0.0, 0.65)
    };

    // 额外资产：analysisMap(内容分析 JSON) + vectorGuide(保结构引导图)，供下游矢量化节点复用（文档 §5.3/§7）
    let (analysis_path, vector_guide_path) = if cfg.emit_assets {
        let ap = format!("{}.analysis.json", out_path);
        let gp = format!("{}.guide.png", out_path);
        let gj = format!("{}.guide.json", out_path);
        let analysis = match write_analysis_map(&qa, &rgba, &ap, task_id, iw, ih) {
            Ok(()) => Some(ap),
            Err(e) => {
                progress(SrEvent::Log {
                    msg: format!("analysisMap 生成失败，主任务继续：{}", e),
                });
                None
            }
        };
        let guide = match write_vector_guide(&rgba, &gp, &gj, task_id) {
            Ok(()) => Some(gp),
            Err(e) => {
                progress(SrEvent::Log {
                    msg: format!("vectorGuide 生成失败，主任务继续：{}", e),
                });
                None
            }
        };
        (analysis, guide)
    } else {
        (None, None)
    };

    let src_long = iw.max(ih);
    let scale = cfg.scale.max(1);
    /// 模型输出长边上限（融合的内存/时间预算）：>此值则预算下采样输入。
    /// 6144：4K 输出用 ~4K 融合（几秒），8K 输出用 ~6K 融合。5090 32GB 远够，且 CPU 侧融合不爆。
    const CAP: u32 = 6144;

    // 文档 §5：目标 ≤ 源长边 → 不跑超分，仅高质量重采样（可选修复留阶段三）
    if let Some(t) = cfg.target_long_edge {
        if t <= src_long {
            progress(SrEvent::Stage {
                stage: "精确缩放".into(),
                pct: 0.5,
            });
            let (tw, th) = target_dims(iw, ih, t);
            let out_img: RgbaImage = if (tw, th) == (iw, ih) {
                rgba.clone()
            } else {
                imageops::resize(&rgba, tw, th, imageops::FilterType::Lanczos3)
            };
            progress(SrEvent::Stage {
                stage: "编码输出".into(),
                pct: 0.97,
            });
            let tmp = format!("{}.tmp", out_path);
            save_image(
                &out_img,
                &tmp,
                &cfg.output_format,
                cfg.output_dpi.unwrap_or(72),
                input_icc.as_deref(),
            )?;
            std::fs::rename(&tmp, out_path).map_err(|e| format!("移动输出文件失败：{}", e))?;
            progress(SrEvent::Stage {
                stage: "完成".into(),
                pct: 1.0,
            });
            return Ok(EnhanceResult {
                out_path: out_path.to_string(),
                width: tw,
                height: th,
                elapsed_ms: start.elapsed().as_millis() as u64,
                tiles: 0,
                tile_size_used: 0,
                estimated_vram_mb: 0,
                backend: "cpu(重采样)".into(),
                pipeline: "目标≤原图，仅重采样(未跑超分)".into(),
                quality: Some(qa),
                fidelity: None,
                analysis_path,
                vector_guide_path,
                face_report: None,
            });
        }
    }

    // ---- 加载模型（走 Session 缓存：同路径复用，常驻 ≤2）----
    progress(SrEvent::Stage {
        stage: "加载主模型".into(),
        pct: 0.08,
    });
    let main_arc = crate::model_cache::get_or_load(model_path)?;
    let (main_in, main_out_name) = session_names(&main_arc);

    let mut detail_arc: Option<SharedSession> = None;
    let mut detail_names: Option<(String, String)> = None;
    if detail_weight > 0.0 {
        if let Some(p) = &cfg.detail_model_path {
            progress(SrEvent::Stage {
                stage: "加载细节模型".into(),
                pct: 0.12,
            });
            match crate::model_cache::get_or_load(p) {
                Ok(a) => {
                    detail_names = Some(session_names(&a));
                    detail_arc = Some(a);
                }
                Err(e) => {
                    progress(SrEvent::Log {
                        msg: format!("细节模型加载失败，降级单模型：{}", e),
                    });
                }
            }
        }
    }

    // ---- §5 + CAP：决定喂给模型的输入长边，使输出 ≈ min(目标, CAP)，不爆内存 ----
    let full_out = src_long.saturating_mul(scale);
    let model_in_long: u32 = if full_out <= CAP {
        src_long // 整图喂模型，质量最佳
    } else {
        // 预降输入使模型输出 ≈ min(target, CAP)
        let want_out = cfg.target_long_edge.unwrap_or(CAP).min(CAP);
        ((want_out as f32 / scale as f32).round() as u32).max(1)
    };
    let (miw, mih) = if model_in_long >= src_long {
        (iw, ih)
    } else {
        let r = model_in_long as f32 / src_long as f32;
        (
            (iw as f32 * r).round().max(1.0) as u32,
            (ih as f32 * r).round().max(1.0) as u32,
        )
    };
    let model_rgba: RgbaImage = if (miw, mih) == (iw, ih) {
        rgba.clone()
    } else {
        imageops::resize(&rgba, miw, mih, imageops::FilterType::Lanczos3)
    };

    // alpha plane（与模型输入同尺寸）
    let mut alpha: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::new(miw, mih);
    let mut has_transparency = false;
    for y in 0..mih {
        for x in 0..miw {
            let p = model_rgba.get_pixel(x, y);
            alpha.put_pixel(x, y, Luma([p.0[3]]));
            if p.0[3] < 255 {
                has_transparency = true;
            }
        }
    }

    let tile = if cfg.tile_size == 0 {
        miw.max(mih)
    } else {
        cfg.tile_size
    };
    let overlap = cfg.tile_overlap.min(tile.saturating_sub(1));

    // ---- 条件 DeJPG（1x 去压缩预处理；文档 §4.3：超分前，jpegScore 明显才跑）----
    let mut model_rgba = model_rgba;
    if should_dejpg(&cfg.dejpeg, qa.jpeg_score, cfg.dejpeg_model_path.is_some()) {
        if let Some(dp) = &cfg.dejpeg_model_path {
            progress(SrEvent::Stage {
                stage: "去压缩(DeJPG)".into(),
                pct: 0.13,
            });
            match crate::model_cache::get_or_load(dp) {
                Ok(da) => {
                    let (din, dout) = session_names(&da);
                    // 失败/尺寸异常仅记日志回退原图，不阻断主超分（文档：预处理不得拖垮主流程）
                    match upscale_tiled(
                        &mut da.lock().unwrap(),
                        &din,
                        &dout,
                        &model_rgba,
                        miw,
                        mih,
                        tile,
                        overlap,
                        1,
                        cancel.as_ref(),
                        progress,
                        0.13,
                        0.15,
                        None,
                        None,
                    ) {
                        Ok(rgb) if rgb.dim() == (mih as usize, miw as usize, 3) => {
                            model_rgba = array3_to_rgba(&rgb, &alpha);
                            progress(SrEvent::Log {
                                msg: "去压缩完成（JPEG 块效应已抑制）".into(),
                            });
                        }
                        Ok(_) => progress(SrEvent::Log {
                            msg: "去压缩输出尺寸异常，已跳过（继续原图超分）".into(),
                        }),
                        Err(e) => {
                            if e == "已取消" {
                                return Err(e);
                            }
                            progress(SrEvent::Log {
                                msg: format!("去压缩失败，已跳过：{}", e),
                            });
                        }
                    }
                }
                Err(e) => progress(SrEvent::Log {
                    msg: format!("DeJPG 模型加载失败，已跳过：{}", e),
                }),
            }
        }
    }

    // ---- 人脸检测（人像档；文档 §11。在 DeJPG 之后、主超分之前，检测坐标为模型输入空间）----
    let mut faces: Vec<crate::face::FaceBox> = Vec::new();
    if let Some(fp) = &cfg.face_detect_model_path {
        progress(SrEvent::Stage {
            stage: "人脸检测".into(),
            pct: 0.14,
        });
        match crate::model_cache::get_or_load(fp) {
            Ok(fa) => {
                match crate::face::detect_faces(&mut fa.lock().unwrap(), &model_rgba) {
                    Ok(f) => {
                        progress(SrEvent::Log {
                            msg: if f.is_empty() {
                                "未检测到人脸，按普通超分处理".into()
                            } else {
                                format!("检测到 {} 张人脸", f.len())
                            },
                        });
                        faces = f;
                    }
                    Err(e) => progress(SrEvent::Log {
                        msg: format!("人脸检测失败，按无人脸继续：{}", e),
                    }),
                }
                // SCRFD 仅 3MB 但用完即放——常驻位（≤2）留给主/细节大模型
                crate::model_cache::release(fp);
            }
            Err(e) => progress(SrEvent::Log {
                msg: format!("人脸检测模型加载失败，按无人脸继续：{}", e),
            }),
        }
    }

    // ---- 主放大（OOM/推理异常 → Tile 减半重试一次，文档 §21.6 OOM 降级链）----
    let has_detail = detail_arc.is_some();
    let (lo, hi) = if has_detail {
        (0.15, 0.5)
    } else {
        (0.15, 0.82)
    };
    let mut try_tile = tile;
    let main_up = loop {
        match upscale_tiled(
            &mut main_arc.lock().unwrap(),
            &main_in,
            &main_out_name,
            &model_rgba,
            miw,
            mih,
            try_tile,
            overlap.min(try_tile.saturating_sub(1)),
            scale,
            cancel.as_ref(),
            progress,
            lo,
            hi,
            None,
            None,
        ) {
            Ok(r) => break r,
            Err(e) => {
                if e == "已取消" {
                    return Err(e);
                }
                if try_tile > 256 {
                    try_tile /= 2;
                    progress(SrEvent::Log {
                        msg: format!(
                            "推理失败（疑似显存不足），Tile 降为 {} 重试：{}",
                            try_tile, e
                        ),
                    });
                    continue;
                }
                return Err(format!("主模型推理失败：{}", e));
            }
        }
    };

    // ---- 细节放大 + 双频段融合 ----
    let mut candidate_rejected_ratio = 0.0f32;
    let (mut fused, pipeline_desc): (Array3<f32>, &'static str) =
        if let (Some(da), Some((din, dout))) = (detail_arc.as_ref(), detail_names.as_ref()) {
            progress(SrEvent::Stage {
                stage: "细节放大".into(),
                pct: 0.52,
            });
            let edge_map = crate::enhance2::edge_density_map(&model_rgba);
            let mut detail_tile = try_tile;
            let detail_budget = if cfg
                .detail_model_path
                .as_deref()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .contains("dat2")
            {
                Duration::from_secs(240)
            } else {
                Duration::from_secs(180)
            };
            let detail_deadline = Some(Instant::now() + detail_budget);
            let detail_res = loop {
                match upscale_tiled(
                    &mut da.lock().unwrap(),
                    din,
                    dout,
                    &model_rgba,
                    miw,
                    mih,
                    detail_tile,
                    overlap.min(detail_tile.saturating_sub(1)),
                    scale,
                    cancel.as_ref(),
                    progress,
                    0.52,
                    0.78,
                    Some(&edge_map),
                    detail_deadline,
                ) {
                    Ok(r) => break Ok(r),
                    Err(e) if e == "已取消" => break Err(e),
                    Err(e) if e == DETAIL_TIMEOUT_MSG => break Err(e),
                    Err(e) if detail_tile > 256 => {
                        detail_tile /= 2;
                        progress(SrEvent::Log {
                            msg: format!("细节模型显存不足，Tile 降为 {} 重试：{}", detail_tile, e),
                        });
                    }
                    Err(e) => break Err(e),
                }
            };
            match detail_res {
                Ok(detail_up) => {
                    progress(SrEvent::Stage {
                        stage: "融合(细节掩膜)".into(),
                        pct: 0.82,
                    });
                    let mask = content_mask(&main_up);
                    let proposed = mask.mapv(|v| v * detail_weight);
                    let (mut w, rejected_ratio) =
                        gate_candidate_weight(&main_up, &detail_up, &proposed);
                    candidate_rejected_ratio = rejected_ratio;
                    // 人像档：皮肤区细节权重 ×0.6（文档 §11——别把皮肤纹理/毛孔灌成砂纸）
                    if !faces.is_empty() {
                        let (oh, ow, _) = main_up.dim();
                        let out_faces: Vec<crate::face::FaceBox> =
                            faces.iter().map(|f| scale_face(f, scale)).collect();
                        let fm = crate::face::face_mask(ow as u32, oh as u32, &out_faces, 24);
                        w = ndarray::Zip::from(&w)
                            .and(&fm)
                            .map_collect(|&wv, &fv| wv * (1.0 - 0.4 * fv));
                    }
                    progress(SrEvent::Stage {
                        stage: "融合(低频主色 + 高频细节)".into(),
                        pct: 0.84,
                    });
                    // 融合是全图单线程 CPU 重活（两轮三通道模糊 + 逐像素混合），按阶段回报——否则进度条长时间钉在一个值上像卡死
                    let mut fused = fuse_2band(&main_up, &detail_up, &w, &|f| {
                        progress(SrEvent::Progress {
                            pct: 0.84 + f * 0.04,
                        });
                    });
                    progress(SrEvent::Stage {
                        stage: "光晕抑制".into(),
                        pct: 0.88,
                    });
                    fused = suppress_halos(&fused, &main_up, &mask);
                    progress(SrEvent::Stage {
                        stage: "质量守卫".into(),
                        pct: 0.895,
                    });
                    fused = guard_detail_deviation(&fused, &main_up, &mask);
                    // 两个学习模型本身都带高频倾向，末端不再追加 USM；避免文字双边、皮肤砂纸和发丝假纹理。
                    progress(SrEvent::Progress { pct: 0.91 });
                    (fused, "主模型+细节模型(保守双频段融合+光晕抑制)")
                }
                Err(e) => {
                    if e == "已取消" {
                        return Err(e);
                    }
                    progress(SrEvent::Log {
                        msg: format!("细节放大失败，回退单模型：{}", e),
                    });
                    (main_up, "单模型直放大(细节失败回退)")
                }
            }
        } else {
            (main_up, "单模型直放大")
        };

    // 海报/扁平插画无论单模型还是融合，都把源图硬边轻量回注；学习模型不能重画字形骨架与规则几何。
    let poster_structure_protected = qa.content_type == "poster"
        || (qa.content_type == "illustration" && qa.flat_ratio > 0.45)
        || (qa.hard_edge_ratio > 0.055 && qa.flat_ratio > 0.50);
    if poster_structure_protected {
        protect_source_edges(&mut fused, &model_rgba, scale, 0.42);
    }

    // ---- 人脸 ROI 增强（人像档；文档 §11 脸宽路由。在融合之后、转 RGBA 之前贴回）----
    let protected_faces =
        if !faces.is_empty() && matches!(cfg.face_restore.as_str(), "identity" | "faceup") {
            // identity：全部人脸回注原图结构；faceup：仅保护不适合 FaceUpDAT 的小脸。
            protect_face_identity(
                &mut fused,
                &model_rgba,
                &faces,
                scale,
                cfg.face_restore == "faceup",
            )
        } else {
            0
        };
    let mut face_report: Option<String> = None;
    if !faces.is_empty() {
        match face_enhance(
            &mut fused,
            &model_rgba,
            &faces,
            scale,
            cfg,
            cancel.as_ref(),
            progress,
        ) {
            Ok(mut rep) => {
                if protected_faces > 0 {
                    rep.push_str(&format!("；{} 张已回注原图五官结构", protected_faces));
                }
                progress(SrEvent::Log { msg: rep.clone() });
                face_report = Some(rep);
            }
            Err(e) => {
                if e == "已取消" {
                    return Err(e);
                }
                progress(SrEvent::Log {
                    msg: format!("人脸增强失败，保留融合结果：{}", e),
                });
            }
        }
    }

    // 所有学习型分支（包括可选人脸修复）结束后再做低频反投影，报告才代表最终像素。
    // 每个 scale×scale 块只加同一残差，不会抹掉块内高频；海报/色块严格，照片更宽松。
    progress(SrEvent::Stage {
        stage: "保真一致性校验".into(),
        pct: 0.915,
    });
    let consistency_strength = match qa.content_type.as_str() {
        "poster" => 0.92,
        "illustration" => 0.82,
        _ => 0.68,
    };
    let fidelity = enforce_source_consistency(
        &mut fused,
        &model_rgba,
        scale,
        consistency_strength,
        candidate_rejected_ratio,
    );

    // ---- → RGBA（8 位或 16 位，专业印刷档可选 16 位无损）----
    let out_w = miw * scale;
    let out_h = mih * scale;
    progress(SrEvent::Stage {
        stage: "合并".into(),
        pct: 0.92,
    });
    let jpeg_out = matches!(
        cfg.output_format.to_ascii_lowercase().as_str(),
        "jpeg" | "jpg"
    );
    let use16 = cfg.bit_depth == 16 && !jpeg_out;
    if cfg.bit_depth == 16 && jpeg_out {
        progress(SrEvent::Log {
            msg: "JPEG 不支持 16 位，已按 8 位输出".into(),
        });
    }
    // alpha 放大（8/16 位路径共用）
    let a_big = if has_transparency {
        Some(imageops::resize(
            &alpha,
            out_w,
            out_h,
            imageops::FilterType::Lanczos3,
        ))
    } else {
        None
    };
    let (fw, fh) = match cfg.target_long_edge {
        Some(t) => target_dims(out_w, out_h, t),
        None => (out_w, out_h),
    };
    progress(SrEvent::Stage {
        stage: "精确缩放".into(),
        pct: 0.95,
    });
    progress(SrEvent::Stage {
        stage: "编码输出".into(),
        pct: 0.97,
    });
    let tmp = format!("{}.tmp", out_path);
    if use16 {
        let mut full16: ImageBuffer<Rgba<u16>, Vec<u16>> = ImageBuffer::new(out_w, out_h);
        for y in 0..out_h {
            for x in 0..out_w {
                let r = (fused[(y as usize, x as usize, 0)].clamp(0., 1.) * 65535.) as u16;
                let g = (fused[(y as usize, x as usize, 1)].clamp(0., 1.) * 65535.) as u16;
                let b = (fused[(y as usize, x as usize, 2)].clamp(0., 1.) * 65535.) as u16;
                let a = match &a_big {
                    Some(ab) => ab.get_pixel(x, y).0[0] as u16 * 257, // u8→u16 等比放大
                    None => 65535,
                };
                full16.put_pixel(x, y, Rgba([r, g, b, a]));
            }
        }
        let final16 = if (fw, fh) == (out_w, out_h) {
            full16
        } else {
            imageops::resize(&full16, fw, fh, imageops::FilterType::Lanczos3)
        };
        save_image_16(
            &final16,
            &tmp,
            &cfg.output_format,
            cfg.output_dpi.unwrap_or(72),
            input_icc.as_deref(),
        )?;
    } else {
        let mut full: RgbaImage = ImageBuffer::new(out_w, out_h);
        for y in 0..out_h {
            for x in 0..out_w {
                let r = fused[(y as usize, x as usize, 0)].clamp(0., 1.) * 255.;
                let g = fused[(y as usize, x as usize, 1)].clamp(0., 1.) * 255.;
                let b = fused[(y as usize, x as usize, 2)].clamp(0., 1.) * 255.;
                full.put_pixel(x, y, Rgba([r as u8, g as u8, b as u8, 255]));
            }
        }
        if let Some(ab) = &a_big {
            for y in 0..out_h {
                for x in 0..out_w {
                    full.get_pixel_mut(x, y).0[3] = ab.get_pixel(x, y).0[0];
                }
            }
        }
        let final_img: RgbaImage = if (fw, fh) == (out_w, out_h) {
            full
        } else {
            imageops::resize(&full, fw, fh, imageops::FilterType::Lanczos3)
        };
        save_image(
            &final_img,
            &tmp,
            &cfg.output_format,
            cfg.output_dpi.unwrap_or(72),
            input_icc.as_deref(),
        )?;
    }
    std::fs::rename(&tmp, out_path).map_err(|e| format!("移动输出文件失败：{}", e))?;

    progress(SrEvent::Stage {
        stage: "完成".into(),
        pct: 1.0,
    });
    let mut final_pipeline = pipeline_desc.to_string();
    if poster_structure_protected {
        final_pipeline.push_str("；已回注原图文字/几何边缘");
    }
    if fw > out_w || fh > out_h {
        final_pipeline.push_str(&format!(
            "；神经超分至 {}×{}，再以 Lanczos 精确扩展至 {}×{}",
            out_w, out_h, fw, fh
        ));
    }
    if use16 {
        final_pipeline.push_str("；16位输出容器（模型管线为8位源采样）");
    }
    if input_icc.is_some() {
        final_pipeline.push_str("；已保留输入 ICC 色彩配置");
    }
    final_pipeline.push_str(&format!(
        "；保真守卫 {:.0}分(缩回误差 {:.2}%→{:.2}%，校正 {:.0}%，候选拒绝 {:.0}%)",
        fidelity.score * 100.0,
        fidelity.source_mae_before * 100.0,
        fidelity.source_mae_after * 100.0,
        fidelity.corrected_block_ratio * 100.0,
        fidelity.candidate_rejected_ratio * 100.0,
    ));
    let fusion_used = pipeline_desc.contains("细节模型");
    let estimated_vram_mb = estimate_vram_mb(try_tile, fusion_used, model_path);
    Ok(EnhanceResult {
        out_path: out_path.to_string(),
        width: fw,
        height: fh,
        elapsed_ms: start.elapsed().as_millis() as u64,
        tiles: tiles_count(miw, mih, try_tile, overlap.min(try_tile.saturating_sub(1))),
        tile_size_used: try_tile,
        estimated_vram_mb,
        backend: "directml".into(),
        pipeline: final_pipeline,
        quality: Some(qa),
        fidelity: Some(fidelity),
        analysis_path,
        vector_guide_path,
        face_report,
    })
}

fn tiles_count(iw: u32, ih: u32, tile: u32, overlap: u32) -> u32 {
    (tile_starts(iw, tile, overlap).len() * tile_starts(ih, tile, overlap).len()) as u32
}

fn estimate_vram_mb(tile: u32, fusion: bool, model_path: &str) -> u32 {
    let is_span = model_path.to_ascii_lowercase().contains("span");
    let factor = if fusion {
        13.5
    } else if is_span {
        5.2
    } else {
        10.5
    };
    let resident = if fusion {
        420.0
    } else if is_span {
        120.0
    } else {
        260.0
    };
    (resident + (tile as f32 * tile as f32 * factor) / 1024.0).ceil() as u32
}

/// 固定形状 Tile 起点：尾块向前对齐到边界，不生成 64px 之类的动态小尾块。
/// DirectML 对固定输入形状能做更多预处理和图优化，也避免不同尾块形状反复准备内核。
fn tile_starts(len: u32, tile: u32, overlap: u32) -> Vec<u32> {
    if tile == 0 || tile >= len {
        return vec![0];
    }
    let step = tile.saturating_sub(overlap.min(tile - 1)).max(1);
    let tail = len - tile;
    let intervals = tail.div_ceil(step).max(1);
    let mut out = Vec::with_capacity((intervals + 1) as usize);
    // 固定块数量下均匀铺满首尾，避免“倒数第二块 + 贴尾块”出现接近整块的重复区；
    // 既不复制大段边缘像素，也不增加 Tile 数量，是质量与吞吐的稳定折中。
    for i in 0..=intervals {
        out.push(((tail as u64 * i as u64 + intervals as u64 / 2) / intervals as u64) as u32);
    }
    out
}

/// 读取缓存 Session 的输入/输出节点名（锁内快速拷贝，不持锁推理）
fn session_names(s: &SharedSession) -> (String, String) {
    let g = s.lock().unwrap();
    (
        g.inputs()[0].name().to_string(),
        g.outputs()[0].name().to_string(),
    )
}

/// f32 RGB(0..1) + alpha 平面 → RgbaImage（DeJPG 等 1x 预处理回写用，透明度不动）
fn array3_to_rgba(rgb: &Array3<f32>, alpha: &ImageBuffer<Luma<u8>, Vec<u8>>) -> RgbaImage {
    let (h, w, _) = rgb.dim();
    let mut img: RgbaImage = ImageBuffer::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let r = (rgb[(y, x, 0)].clamp(0., 1.) * 255.) as u8;
            let g = (rgb[(y, x, 1)].clamp(0., 1.) * 255.) as u8;
            let b = (rgb[(y, x, 2)].clamp(0., 1.) * 255.) as u8;
            let a = alpha.get_pixel(x as u32, y as u32).0[0];
            img.put_pixel(x as u32, y as u32, Rgba([r, g, b, a]));
        }
    }
    img
}

/* ---------------- 人脸分支（人像档，文档 §11） ---------------- */

/// 输入空间人脸框 → 输出空间（×scale）
fn scale_face(f: &crate::face::FaceBox, scale: u32) -> crate::face::FaceBox {
    let s = scale as f32;
    crate::face::FaceBox {
        x1: f.x1 * s,
        y1: f.y1 * s,
        x2: f.x2 * s,
        y2: f.y2 * s,
        score: f.score,
    }
}

/// Array3<f32>(0..1) → u8 RGBA（ROI 重采样中转，精度损失可接受）
fn array3_to_img8(a: &Array3<f32>) -> RgbaImage {
    let (h, w, _) = a.dim();
    let mut img: RgbaImage = ImageBuffer::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let r = (a[(y, x, 0)].clamp(0., 1.) * 255.) as u8;
            let g = (a[(y, x, 1)].clamp(0., 1.) * 255.) as u8;
            let b = (a[(y, x, 2)].clamp(0., 1.) * 255.) as u8;
            img.put_pixel(x as u32, y as u32, Rgba([r, g, b, 255]));
        }
    }
    img
}

/// 把 ROI 结果重采样到目标尺寸（scale≠4 或生成式模型固定 512² 输出时对齐用）
fn fit_array3(a: &Array3<f32>, tw: u32, th: u32) -> Array3<f32> {
    let (h, w, _) = a.dim();
    if w == tw as usize && h == th as usize {
        return a.clone();
    }
    crate::face::rgba_to_array3(&imageops::resize(
        &array3_to_img8(a),
        tw,
        th,
        imageops::FilterType::Lanczos3,
    ))
}

/// 海报结构保护：仅在原图已有的高对比边缘回注一部分 Lanczos 基线。
/// 学习模型仍负责放大，但不能轻易重画字形骨架、细线和规则几何边界。
fn protect_source_edges(fused: &mut Array3<f32>, input: &RgbaImage, scale: u32, amount: f32) {
    let (oh, ow, _) = fused.dim();
    let expected_w = input.width().saturating_mul(scale);
    let expected_h = input.height().saturating_mul(scale);
    if ow as u32 != expected_w || oh as u32 != expected_h {
        return;
    }
    let base_img = imageops::resize(input, ow as u32, oh as u32, imageops::FilterType::Lanczos3);
    let base = crate::face::rgba_to_array3(&base_img);
    let edge = hard_edge_mask(&base);
    for y in 0..oh {
        for x in 0..ow {
            let w = (edge[(y, x)] * amount).clamp(0.0, 0.35);
            for c in 0..3 {
                fused[(y, x, c)] = fused[(y, x, c)] * (1.0 - w) + base[(y, x, c)] * w;
            }
        }
    }
}

/// 人脸原貌保护：把 Lanczos 放大的原始五官低频结构回注到神经超分结果。
/// 这不是人脸生成，不会凭空补眼睫毛/毛孔；输入越小回注越强，优先避免身份和五官漂移。
fn protect_face_identity(
    fused: &mut Array3<f32>,
    input: &RgbaImage,
    faces: &[crate::face::FaceBox],
    scale: u32,
    tiny_only: bool,
) -> usize {
    let (oh, ow, _) = fused.dim();
    let base_img = imageops::resize(input, ow as u32, oh as u32, imageops::FilterType::Lanczos3);
    let base = crate::face::rgba_to_array3(&base_img);
    let mut weight = Array2::<f32>::zeros((oh, ow));
    let mut count = 0usize;
    for face in faces {
        if tiny_only && face.w() >= 128.0 {
            continue;
        }
        let amount = if face.w() < 128.0 {
            0.52
        } else if face.w() < 256.0 {
            0.38
        } else {
            0.22
        };
        let fm = crate::face::face_mask(ow as u32, oh as u32, &[scale_face(face, scale)], 24);
        ndarray::Zip::from(&mut weight)
            .and(&fm)
            .for_each(|w, &m| *w = (*w).max(m * amount));
        count += 1;
    }
    if count == 0 {
        return 0;
    }
    for y in 0..oh {
        for x in 0..ow {
            let w = weight[(y, x)].clamp(0.0, 0.65);
            for c in 0..3 {
                fused[(y, x, c)] = fused[(y, x, c)] * (1.0 - w) + base[(y, x, c)] * w;
            }
        }
    }
    count
}

/// 人脸 ROI 增强主流程：按输入空间脸宽路由（文档 §11）
/// >256px 大脸：主超分已足够；128–256px：FaceUpDAT ROI 4x 贴回；<128px 小脸：生成式修复（可选模型在时）或警告
fn face_enhance(
    fused: &mut Array3<f32>,
    input: &RgbaImage,
    faces: &[crate::face::FaceBox],
    scale: u32,
    cfg: &EnhanceConfig,
    cancel: &AtomicBool,
    progress: &dyn Fn(SrEvent),
) -> SResult<String> {
    let mut roi_n = 0u32;
    let mut gen_n = 0u32;
    let mut big_n = 0u32;
    let mut tiny_n = 0u32;
    for (i, f) in faces.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".into());
        }
        progress(SrEvent::Stage {
            stage: format!("人脸增强 {}/{}", i + 1, faces.len()),
            pct: 0.91,
        });
        let fw = f.w();
        if fw > 256.0 {
            big_n += 1;
            continue;
        }
        if fw >= 128.0 {
            match &cfg.face_upscale_model_path {
                Some(p) => match face_up_roi(fused, input, f, scale, p) {
                    Ok(()) => roi_n += 1,
                    Err(e) => progress(SrEvent::Log {
                        msg: format!(
                            "第 {} 张人脸 FaceUpDAT 增强失败，保留超分结果：{}",
                            i + 1,
                            e
                        ),
                    }),
                },
                None => progress(SrEvent::Log {
                    msg: "FaceUpDAT 未下载，中等人脸保持主超分结果".into(),
                }),
            }
        } else {
            tiny_n += 1;
            if matches!(cfg.face_restore.as_str(), "gfpgan" | "codeformer") {
                match &cfg.face_restore_model_path {
                    Some(p) => match face_restore_roi(fused, input, f, scale, p) {
                        Ok(()) => gen_n += 1,
                        Err(e) => progress(SrEvent::Log {
                            msg: format!("第 {} 张小脸生成式修复失败，保留超分结果：{}", i + 1, e),
                        }),
                    },
                    None => progress(SrEvent::Log {
                        msg: format!(
                            "{} 模型未下载（设置→本地模型里可下），小脸保持超分结果",
                            cfg.face_restore
                        ),
                    }),
                }
            }
        }
    }
    let mut parts = vec![format!("人脸 {} 张", faces.len())];
    if big_n > 0 {
        parts.push(format!("{} 张大脸随主超分", big_n));
    }
    if roi_n > 0 {
        parts.push(format!("{} 张经 FaceUpDAT 增强", roi_n));
    }
    if gen_n > 0 {
        parts.push(format!("{} 张经 {} 生成式修复", gen_n, cfg.face_restore));
    }
    let tiny_unfixed = tiny_n.saturating_sub(gen_n);
    if tiny_unfixed > 0 && matches!(cfg.face_restore.as_str(), "gfpgan" | "codeformer") {
        parts.push(format!(
            "⚠ {} 张脸过小(<128px)未修复，可在面板开「人脸修复」",
            tiny_unfixed
        ));
    }
    Ok(parts.join("；"))
}

/// FaceUpDAT ROI：裁脸（1.4x context）→ 4x 增强 → 羽化贴回融合图（输出空间）
fn face_up_roi(
    fused: &mut Array3<f32>,
    input: &RgbaImage,
    f: &crate::face::FaceBox,
    scale: u32,
    model_path: &str,
) -> SResult<()> {
    let (iw, ih) = (input.width(), input.height());
    let (x1, y1, x2, y2) = crate::face::expand_box(f, 1.4, iw, ih);
    let (cw, ch) = (x2 - x1, y2 - y1);
    let crop = imageops::crop_imm(input, x1, y1, cw, ch).to_image();
    let arc = crate::model_cache::get_or_load(model_path)?;
    let (in_n, out_n) = session_names(&arc);
    let out = run_tile(
        &mut arc.lock().unwrap(),
        &in_n,
        &out_n,
        &crate::face::rgba_to_array3(&crop),
    )?;
    let fitted = fit_array3(&out, cw * scale, ch * scale);
    crate::face::paste_feathered(fused, &fitted, x1 * scale, y1 * scale, 16);
    Ok(())
}

/// 生成式人脸修复（GFPGAN / CodeFormer）：裁脸 → 512² [-1,1] → 推理 → 羽化贴回。
/// CodeFormer 的第二输入是 fidelity 权重 w=0.7，按输入个数探测（f32 / f64 标量逐个试）。
fn face_restore_roi(
    fused: &mut Array3<f32>,
    input: &RgbaImage,
    f: &crate::face::FaceBox,
    scale: u32,
    model_path: &str,
) -> SResult<()> {
    const GS: u32 = 512;
    let (iw, ih) = (input.width(), input.height());
    let (x1, y1, x2, y2) = crate::face::expand_box(f, 1.4, iw, ih);
    let (cw, ch) = (x2 - x1, y2 - y1);
    let crop = imageops::crop_imm(input, x1, y1, cw, ch).to_image();
    let sq = imageops::resize(&crop, GS, GS, imageops::FilterType::Lanczos3);
    // NCHW RGB [-1,1]
    let mut t: Array4<f32> = Array4::zeros((1, 3, GS as usize, GS as usize));
    for y in 0..GS {
        for x in 0..GS {
            let p = sq.get_pixel(x, y);
            for c in 0..3 {
                t[[0, c, y as usize, x as usize]] = p.0[c] as f32 / 127.5 - 1.0;
            }
        }
    }
    let arc = crate::model_cache::get_or_load(model_path)?;
    let (in_names, out_name) = {
        let g = arc.lock().unwrap();
        (
            g.inputs()
                .iter()
                .map(|i| i.name().to_string())
                .collect::<Vec<_>>(),
            g.outputs()[0].name().to_string(),
        )
    };
    let out: Array4<f32> = {
        let mut g = arc.lock().unwrap();
        // 每次尝试都在同一语句内提取成拥有所有权的 Array4，释放对 Session 的借用（否则 Err 分支无法二次推理）
        let extract = |outputs: &ort::session::SessionOutputs<'_>| -> SResult<Array4<f32>> {
            Ok(outputs[out_name.as_str()]
                .try_extract_array::<f32>()
                .map_err(es)?
                .into_dimensionality::<Ix4>()
                .map_err(es)?
                .to_owned())
        };
        if in_names.len() >= 2 {
            let w32 = ndarray::arr1(&[0.7f32]);
            let first: SResult<Array4<f32>> = g
                .run(ort::inputs![
                    in_names[0].clone() => TensorRef::from_array_view(&t).map_err(es)?,
                    in_names[1].clone() => TensorRef::from_array_view(&w32).map_err(es)?
                ])
                .map_err(es)
                .and_then(|o| extract(&o));
            match first {
                Ok(a) => a,
                Err(_) => {
                    let w64 = ndarray::arr1(&[0.7f64]);
                    let outputs = g
                        .run(ort::inputs![
                            in_names[0].clone() => TensorRef::from_array_view(&t).map_err(es)?,
                            in_names[1].clone() => TensorRef::from_array_view(&w64).map_err(es)?
                        ])
                        .map_err(|e| format!("生成式人脸修复推理失败：{}", e))?;
                    extract(&outputs)?
                }
            }
        } else {
            let outputs = g
                .run(ort::inputs![in_names[0].clone() => TensorRef::from_array_view(&t).map_err(es)?])
                .map_err(|e| format!("生成式人脸修复推理失败：{}", e))?;
            extract(&outputs)?
        }
    };
    // 可选模型（各 ~350MB）用完即放，不挤常驻位（文档 §21.5）
    crate::model_cache::release(model_path);
    let (_, _, oh, ow) = out.dim();
    let mut arr = Array3::<f32>::zeros((oh, ow, 3));
    for c in 0..3 {
        for y in 0..oh {
            for x in 0..ow {
                // [-1,1] → [0,1]
                arr[(y, x, c)] = ((out[[0, c, y, x]] + 1.0) / 2.0).clamp(0., 1.);
            }
        }
    }
    let fitted = fit_array3(&arr, cw * scale, ch * scale);
    crate::face::paste_feathered(fused, &fitted, x1 * scale, y1 * scale, 16);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upscale_tiled(
    session: &mut Session,
    in_name: &str,
    out_name: &str,
    rgba: &RgbaImage,
    iw: u32,
    ih: u32,
    tile: u32,
    overlap: u32,
    scale: u32,
    cancel: &AtomicBool,
    progress: &dyn Fn(SrEvent),
    pct_lo: f32,
    pct_hi: f32,
    skip_mask: Option<&Array2<f32>>,
    deadline: Option<Instant>,
) -> SResult<Array3<f32>> {
    let out_w = iw * scale;
    let out_h = ih * scale;
    let mut acc: Array3<f32> = Array3::zeros((out_h as usize, out_w as usize, 3));
    let mut wsum: Array2<f32> = Array2::zeros((out_h as usize, out_w as usize));
    let xs = tile_starts(iw, tile, overlap);
    let ys = tile_starts(ih, tile, overlap);
    // 同一次任务所有边缘块也使用同一模型输入形状；越界部分复制最外像素填充，输出写回时再裁掉。
    let model_tw = tile.min(iw).max(1);
    let model_th = tile.min(ih).max(1);
    let total = (xs.len() * ys.len()) as u32;
    let mut done = 0u32;
    for &ty in &ys {
        for &tx in &xs {
            if cancel.load(Ordering::SeqCst) {
                return Err("已取消".into());
            }
            if deadline_expired(deadline) {
                return Err(DETAIL_TIMEOUT_MSG.into());
            }
            let tw = model_tw.min(iw - tx);
            let th = model_th.min(ih - ty);
            // ROI（文档 §21.4）：细节模型跳过平坦 tile，不往色块灌纹理
            if let Some(mask) = skip_mask {
                let (mh, mw) = mask.dim();
                let mut sum = 0.0f32;
                let mut n = 0.0f32;
                for yy in ty..ty + th {
                    for xx in tx..tx + tw {
                        if (yy as usize) < mh && (xx as usize) < mw {
                            sum += mask[[yy as usize, xx as usize]];
                            n += 1.0;
                        }
                    }
                }
                if n > 0.0 && sum / n < 0.06 {
                    done += 1;
                    let pct = pct_lo + (pct_hi - pct_lo) * (done as f32) / (total as f32);
                    progress(SrEvent::Progress { pct });
                    continue;
                }
            }
            let rgb = crop_rgb_padded(rgba, tx, ty, model_tw, model_th);
            let out = run_tile(session, in_name, out_name, &rgb)?;
            place_tile(
                &mut acc,
                &mut wsum,
                &out,
                tx * scale,
                ty * scale,
                out_w,
                out_h,
                overlap * scale,
            );
            done += 1;
            let pct = pct_lo + (pct_hi - pct_lo) * (done as f32) / (total as f32);
            progress(SrEvent::Progress { pct });
        }
    }
    let mut out_rgb = Array3::<f32>::zeros((out_h as usize, out_w as usize, 3));
    for y in 0..out_h {
        for x in 0..out_w {
            let w = wsum[(y as usize, x as usize)];
            for c in 0..3 {
                out_rgb[(y as usize, x as usize, c)] = if w > 0.0 {
                    (acc[(y as usize, x as usize, c)] / w).clamp(0., 1.)
                } else {
                    0.0
                };
            }
        }
    }
    Ok(out_rgb)
}

fn crop_rgb_padded(rgba: &RgbaImage, tx: u32, ty: u32, tw: u32, th: u32) -> Array3<f32> {
    let (iw, ih) = rgba.dimensions();
    let mut a = Array3::zeros((th as usize, tw as usize, 3));
    for y in 0..th {
        for x in 0..tw {
            let sx = (tx + x).min(iw.saturating_sub(1));
            let sy = (ty + y).min(ih.saturating_sub(1));
            let p = rgba.get_pixel(sx, sy);
            a[(y as usize, x as usize, 0)] = p.0[0] as f32 / 255.;
            a[(y as usize, x as usize, 1)] = p.0[1] as f32 / 255.;
            a[(y as usize, x as usize, 2)] = p.0[2] as f32 / 255.;
        }
    }
    a
}

fn run_tile(
    session: &mut Session,
    in_name: &str,
    out_name: &str,
    rgb: &Array3<f32>,
) -> SResult<Array3<f32>> {
    let (h, w, _) = rgb.dim();
    let mut input: Array4<f32> = Array4::zeros((1, 3, h, w));
    for c in 0..3 {
        for y in 0..h {
            for x in 0..w {
                input[[0, c, y, x]] = rgb[(y, x, c)];
            }
        }
    }
    let outputs = session
        .run(ort::inputs![in_name.to_string() => TensorRef::from_array_view(&input).map_err(es)?])
        .map_err(es)?;
    let out: Array4<f32> = outputs[out_name]
        .try_extract_array::<f32>()
        .map_err(es)?
        .into_dimensionality::<Ix4>()
        .map_err(es)?
        .to_owned();
    let (_, _, h2, w2) = out.dim();
    let mut rgb_out = Array3::<f32>::zeros((h2, w2, 3));
    for c in 0..3 {
        for y in 0..h2 {
            for x in 0..w2 {
                rgb_out[(y, x, c)] = out[[0, c, y, x]];
            }
        }
    }
    Ok(rgb_out)
}

fn place_tile(
    acc: &mut Array3<f32>,
    wsum: &mut Array2<f32>,
    tile_out: &Array3<f32>,
    ox: u32,
    oy: u32,
    out_w: u32,
    out_h: u32,
    overlap_out: u32,
) {
    let (th, tw, _) = tile_out.dim();
    let th = th as u32;
    let tw = tw as u32;
    let ox1 = (ox + tw).min(out_w);
    let oy1 = (oy + th).min(out_h);
    let wx: Vec<f32> = (0..tw)
        .map(|lx| {
            let mut w = 1.0;
            if ox > 0 && lx < overlap_out {
                w *= (lx as f32 + 1.0) / overlap_out as f32;
            }
            if ox1 < out_w {
                let dr = tw - 1 - lx;
                if dr < overlap_out {
                    w *= (dr as f32 + 1.0) / overlap_out as f32;
                }
            }
            w
        })
        .collect();
    let wy: Vec<f32> = (0..th)
        .map(|ly| {
            let mut w = 1.0;
            if oy > 0 && ly < overlap_out {
                w *= (ly as f32 + 1.0) / overlap_out as f32;
            }
            if oy1 < out_h {
                let dr = th - 1 - ly;
                if dr < overlap_out {
                    w *= (dr as f32 + 1.0) / overlap_out as f32;
                }
            }
            w
        })
        .collect();
    for ly in 0..th {
        let gy = oy + ly;
        if gy >= out_h {
            break;
        }
        for lx in 0..tw {
            let gx = ox + lx;
            if gx >= out_w {
                break;
            }
            let w = wx[lx as usize] * wy[ly as usize];
            for c in 0..3 {
                acc[(gy as usize, gx as usize, c)] += tile_out[(ly as usize, lx as usize, c)] * w;
            }
            wsum[(gy as usize, gx as usize)] += w;
        }
    }
}

/* ---------------- 单测 ---------------- */
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn model(p: &str) -> String {
        format!("{}/../models/sr/{}", env!("CARGO_MANIFEST_DIR"), p)
    }
    fn main_model() -> String {
        model("4xNomosWebPhoto_esrgan_fp32_opset17.onnx")
    }
    fn detail_model() -> String {
        model("4x-UltraSharpV2_Lite_fp32_op17.onnx")
    }
    fn production_detail_model() -> String {
        model("4xNomosUni_span_multijpg_fp32_opset17.onnx")
    }

    fn synthetic_png(w: u32, h: u32) -> Vec<u8> {
        let mut img: RgbaImage = ImageBuffer::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let r = ((x as f32 / w as f32) * 255.0) as u8;
                let g = ((y as f32 / h as f32) * 255.0) as u8;
                let b = (((x + y) as f32 / (w + h) as f32) * 255.0) as u8;
                img.put_pixel(x, y, Rgba([r, g, b, 255]));
            }
        }
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn detail_deadline_and_failed_output_cleanup_work() {
        assert!(deadline_expired(Some(
            Instant::now() - Duration::from_millis(1)
        )));
        assert!(!deadline_expired(Some(
            Instant::now() + Duration::from_secs(30)
        )));
        assert!(!deadline_expired(None));

        let out = format!("{}/cleanup-probe.png", env!("OUT_DIR"));
        let sidecars = [
            format!("{}.tmp", out),
            format!("{}.guide.png.tmp.png", out),
            format!("{}.analysis.json", out),
            format!("{}.guide.png", out),
            format!("{}.guide.json", out),
            format!("{}.mask.flat.png", out),
            format!("{}.mask.edge.png", out),
        ];
        for path in &sidecars {
            std::fs::write(path, b"probe").unwrap();
        }

        cleanup_failed_outputs(&out);
        assert!(sidecars
            .iter()
            .all(|path| !std::path::Path::new(path).exists()));
    }

    fn decode_base64_fixture(encoded: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(encoded.len() * 3 / 4);
        let mut bits = 0u32;
        let mut count = 0u32;
        for ch in encoded.bytes() {
            let value = match ch {
                b'A'..=b'Z' => ch - b'A',
                b'a'..=b'z' => ch - b'a' + 26,
                b'0'..=b'9' => ch - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => break,
                _ if ch.is_ascii_whitespace() => continue,
                _ => panic!("真实样本不是有效的 Base64 data URL"),
            } as u32;
            bits = (bits << 6) | value;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
                bits &= (1u32 << count).saturating_sub(1);
            }
        }
        out
    }

    fn read_real_fixture(path: &str) -> Vec<u8> {
        let raw = std::fs::read(path).expect("无法读取 MOMO_SR_SAMPLE");
        if raw.starts_with(b"data:") {
            let text = std::str::from_utf8(&raw).expect("data URL 必须是 UTF-8");
            let (_, encoded) = text.split_once(',').expect("data URL 缺少逗号");
            decode_base64_fixture(encoded)
        } else {
            raw
        }
    }

    #[test]
    fn single_model_runs_twice() {
        let bytes = synthetic_png(96, 64);
        assert!(std::path::Path::new(&detail_model()).exists(), "模型缺失");
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: None,
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: false,
        };
        let r1 = run_core(
            "t1",
            &bytes,
            &format!("{}/s1.png", env!("OUT_DIR")),
            &detail_model(),
            &cfg,
            &|_| {},
        )
        .unwrap();
        let r2 = run_core(
            "t2",
            &bytes,
            &format!("{}/s2.png", env!("OUT_DIR")),
            &detail_model(),
            &cfg,
            &|_| {},
        )
        .unwrap();
        assert_eq!((r1.width, r1.height), (384, 256));
        assert_eq!((r1.width, r1.height), (r2.width, r2.height));
        let fidelity = r1.fidelity.as_ref().expect("超分结果必须带保真报告");
        assert!(
            fidelity.source_mae_after <= fidelity.source_mae_before + 1e-6,
            "一致性反投影不能增加缩回误差"
        );
        assert!((0.0..=1.0).contains(&fidelity.score));
        eprintln!("单模型两遍：{}×{}，{}", r1.width, r1.height, r1.pipeline);
    }

    #[test]
    fn fusion_pipeline_runs_twice() {
        let bytes = synthetic_png(96, 64);
        assert!(std::path::Path::new(&main_model()).exists(), "主模型缺失");
        assert!(
            std::path::Path::new(&production_detail_model()).exists(),
            "生产候选模型缺失"
        );
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: None,
            detail_model_path: Some(production_detail_model()),
            detail_weight: -0.14,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: false,
        };
        let r1 = run_core(
            "t3",
            &bytes,
            &format!("{}/f1.png", env!("OUT_DIR")),
            &main_model(),
            &cfg,
            &|_| {},
        )
        .unwrap();
        let mut base_cfg = cfg.clone();
        base_cfg.detail_model_path = None;
        base_cfg.detail_weight = 0.0;
        let base = run_core(
            "t4-base",
            &bytes,
            &format!("{}/f-base.png", env!("OUT_DIR")),
            &main_model(),
            &base_cfg,
            &|_| {},
        )
        .unwrap();
        let _r2 = run_core(
            "t4",
            &bytes,
            &format!("{}/f2.png", env!("OUT_DIR")),
            &main_model(),
            &cfg,
            &|_| {},
        )
        .unwrap();
        assert_eq!((r1.width, r1.height), (384, 256));
        assert!(
            r1.pipeline.contains("融合"),
            "应为融合路径：{}",
            r1.pipeline
        );
        let fidelity = r1.fidelity.as_ref().expect("融合结果必须带保真报告");
        let base_fidelity = base.fidelity.as_ref().expect("主模型必须带保真报告");
        assert!(
            fidelity.source_mae_after <= fidelity.source_mae_before + 1e-6,
            "候选融合后必须通过源图一致性门禁"
        );
        assert!(
            fidelity.source_mae_after <= base_fidelity.source_mae_after + 0.012,
            "候选融合相对主模型的源一致性退化必须受限"
        );
        assert!((0.0..=1.0).contains(&fidelity.candidate_rejected_ratio));
        eprintln!(
            "融合两遍：{}×{}，{}，{}ms",
            r1.width, r1.height, r1.pipeline, r1.elapsed_ms
        );
    }

    #[test]
    #[ignore = "设置 MOMO_SR_SAMPLE=图片路径或 momoblob data URL 文件后运行"]
    fn real_sample_production_fidelity_regression() {
        let sample = std::env::var("MOMO_SR_SAMPLE").expect("必须设置 MOMO_SR_SAMPLE");
        let bytes = read_real_fixture(&sample);
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 320,
            tile_overlap: 48,
            target_long_edge: Some(3840),
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: Some(72),
            emit_assets: false,
        };
        let out = format!("{}/real-production.png", env!("OUT_DIR"));
        let result = run_core("real-production", &bytes, &out, &main_model(), &cfg, &|e| {
            if let SrEvent::Stage { stage, pct } = e {
                eprintln!("{:.0}% {}", pct * 100.0, stage);
            }
        })
        .expect("真实样本生产管线必须完成");
        let fidelity = result.fidelity.expect("真实样本必须有保真报告");
        assert!(fidelity.source_mae_after <= fidelity.source_mae_before + 1e-6);
        assert!(fidelity.score >= 0.80, "真实样本保真分过低: {fidelity:?}");
        assert!(fidelity.max_correction <= 0.11);
        eprintln!("真实样本输出: {out}\n{}", result.pipeline);
    }

    #[test]
    fn target_scaling_completes() {
        // §5 倍率策略：给较大输入 + 4K 目标，必须快速完成（不卡 82%）；输出长边=目标或模型4x取小
        let bytes = synthetic_png(512, 512);
        assert!(std::path::Path::new(&detail_model()).exists());
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 256,
            tile_overlap: 32,
            target_long_edge: Some(3840),
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: false,
        };
        let t0 = Instant::now();
        let r = run_core(
            "t5",
            &bytes,
            &format!("{}/tk.png", env!("OUT_DIR")),
            &detail_model(),
            &cfg,
            &|_| {},
        )
        .expect("§5 缩放应完成");
        let dur = t0.elapsed().as_secs();
        // 512×4=2048 < 3840 目标 → 精确缩放到 3840（上采）；长边应为 3840
        assert_eq!(r.width, 3840);
        assert_eq!(r.height, 3840);
        // 不应长时间卡住（单模型 512→2048→3840，4K 融合已规避；给 120s 余量）
        assert!(dur < 120, "§5 路径耗时 {}s 过长（疑似卡住）", dur);
        eprintln!(
            "§5 目标缩放：{}×{}，{}，{}s",
            r.width, r.height, r.pipeline, dur
        );
    }

    #[test]
    fn tile_starts_keep_tail_shape_fixed() {
        // 尾块向前贴边，不能从 960 开始后复制 448px 边缘像素，否则右/下边会形成拖影。
        assert_eq!(tile_starts(1024, 512, 32), vec![0, 256, 512]);
        assert_eq!(tile_starts(500, 512, 32), vec![0]);
        assert_eq!(tiles_count(1024, 1024, 512, 32), 9);
    }

    #[test]
    fn ultra_wide_analysis_and_guide_are_bounded() {
        let bytes = synthetic_png(5000, 400);
        let out = format!("{}/wide.png", env!("OUT_DIR"));
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: Some(4000),
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: true,
        };
        let r = run_core("wide", &bytes, &out, "", &cfg, &|_| {}).expect("超宽图不应 panic");
        let guide = image::open(r.vector_guide_path.expect("应有引导图")).unwrap();
        assert!(
            guide.width().max(guide.height()) <= 4096,
            "引导图长边必须封顶 4096"
        );
    }

    #[test]
    fn tiff_output() {
        // 阶段三：TIFF 输出（印刷工作流），文件头校验
        let bytes = synthetic_png(64, 64);
        assert!(std::path::Path::new(&detail_model()).exists());
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: None,
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "tiff".into(),
            output_dpi: Some(300),
            emit_assets: false,
        };
        let out = format!("{}/tiff_out.tif", env!("OUT_DIR"));
        let r =
            run_core("tt", &bytes, &out, &detail_model(), &cfg, &|_| {}).expect("TIFF 输出应成功");
        assert!(std::path::Path::new(&out).exists(), "TIFF 文件应落盘");
        let head = std::fs::read(&out).unwrap();
        // TIFF 文件头：小端 II*\0 或大端 MM\0*
        assert!(
            head.starts_with(&[0x49, 0x49, 0x2a, 0]) || head.starts_with(&[0x4d, 0x4d, 0, 0x2a]),
            "应为 TIFF 文件头"
        );
        let mut decoder = tiff::decoder::Decoder::new(std::fs::File::open(&out).unwrap()).unwrap();
        let dpi = match decoder.get_tag(tiff::tags::Tag::XResolution).unwrap() {
            tiff::decoder::ifd::Value::Rational(n, d) if d > 0 => n as f32 / d as f32,
            other => panic!("XResolution 应为有理数，实际为 {other:?}"),
        };
        assert!((dpi - 300.0).abs() < 0.01, "应写入 300 DPI");
        eprintln!("TIFF 输出：{} 字节，{}×{}", head.len(), r.width, r.height);
    }

    #[test]
    fn png_preserves_input_icc_profile() {
        let image = ImageBuffer::from_pixel(12, 8, Rgba([30, 90, 160, 255]));
        let mut profile = vec![0u8; 128];
        profile[0..4].copy_from_slice(&128u32.to_be_bytes());
        profile[36..40].copy_from_slice(b"acsp");
        let path = format!("{}/icc_roundtrip.png", env!("OUT_DIR"));
        save_image(&image, &path, "png", 72, Some(&profile)).expect("应写入 ICC");
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(extract_icc(&bytes).as_deref(), Some(profile.as_slice()));
    }

    #[test]
    fn identity_protection_moves_tiny_face_toward_source_structure() {
        let input = ImageBuffer::from_fn(40, 40, |x, y| {
            let v = ((x + y) * 3).min(255) as u8;
            Rgba([v, 90, 150, 255])
        });
        let mut fused = Array3::<f32>::ones((160, 160, 3));
        let before = fused[(80, 80, 0)];
        let faces = vec![crate::face::FaceBox {
            x1: 8.0,
            y1: 8.0,
            x2: 32.0,
            y2: 34.0,
            score: 0.99,
        }];
        let count = protect_face_identity(&mut fused, &input, &faces, 4, false);
        let base = crate::face::rgba_to_array3(&imageops::resize(
            &input,
            160,
            160,
            imageops::FilterType::Lanczos3,
        ));
        assert_eq!(count, 1);
        assert!(
            (fused[(80, 80, 0)] - base[(80, 80, 0)]).abs() < (before - base[(80, 80, 0)]).abs()
        );
    }

    #[test]
    fn poster_protection_changes_only_hard_edge_neighborhood() {
        let input = ImageBuffer::from_fn(40, 24, |x, _| {
            if x < 20 {
                Rgba([8, 8, 8, 255])
            } else {
                Rgba([245, 245, 245, 255])
            }
        });
        let mut fused = Array3::<f32>::ones((96, 160, 3));
        protect_source_edges(&mut fused, &input, 4, 0.42);
        assert!(
            (fused[(48, 8, 0)] - 1.0).abs() < 1e-5,
            "平坦区不能被整片回注"
        );
        assert!(fused[(48, 79, 0)] < 0.98, "字形/色块交界应回注源结构");
    }

    #[test]
    fn emits_assets_contract() {
        // 阶段三契约：emit_assets=true 时输出 analysisMap(JSON) + vectorGuide(PNG)，供矢量化节点复用
        let bytes = synthetic_png(96, 64);
        let out = format!("{}/asset_out.png", env!("OUT_DIR"));
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: None,
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: true,
        };
        let r = run_core("tA", &bytes, &out, &detail_model(), &cfg, &|_| {}).expect("应成功");
        let ap = r.analysis_path.expect("应输出 analysisMap");
        let gp = r.vector_guide_path.expect("应输出 vectorGuide");
        assert!(
            std::path::Path::new(&ap).exists(),
            "analysisMap JSON 应落盘"
        );
        assert!(std::path::Path::new(&gp).exists(), "vectorGuide PNG 应落盘");
        let json = std::fs::read_to_string(&ap).unwrap();
        assert!(
            json.contains("schemaVersion")
                && json.contains("flatRatio")
                && json.contains("sourceAssetId")
                && json.contains("masks"),
            "analysisMap 应含契约字段+掩膜引用"
        );
        // 掩膜 PNG 应落盘
        assert!(
            std::path::Path::new(&format!("{}.mask.flat.png", out)).exists(),
            "flat 掩膜应落盘"
        );
        assert!(
            std::path::Path::new(&format!("{}.mask.edge.png", out)).exists(),
            "edge 掩膜应落盘"
        );
        // guide 元数据 JSON 也应在
        assert!(
            std::path::Path::new(&format!("{}.json", gp.trim_end_matches(".png"))).exists()
                || std::path::Path::new(&(gp.clone() + ".json")).exists()
                || std::path::Path::new(&format!("{}.guide.json", out)).exists(),
            "guide 元数据应落盘"
        );
        eprintln!("资产契约 OK：analysis {} 字节", json.len());
    }

    #[test]
    fn png_16bit_output() {
        // 专业印刷档：16 位 PNG —— IHDR 位深应为 16、颜色类型 6(RGBA)
        let bytes = synthetic_png(64, 64);
        let cfg = EnhanceConfig {
            bit_depth: 16,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: None,
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: false,
        };
        let out = format!("{}/out16.png", env!("OUT_DIR"));
        let r =
            run_core("t16", &bytes, &out, &detail_model(), &cfg, &|_| {}).expect("16 位输出应成功");
        let head = std::fs::read(&out).unwrap();
        assert!(
            head.starts_with(&[0x89, 0x50, 0x4e, 0x47]),
            "应为 PNG 文件头"
        );
        assert_eq!(head[24], 16, "PNG 位深应为 16（IHDR 位深字节）");
        assert_eq!(head[25], 6, "颜色类型应为 6（RGBA）");
        eprintln!("16 位 PNG：{}×{}", r.width, r.height);
    }

    #[test]
    fn dejpg_trigger_logic() {
        assert!(should_dejpg("on", 0.0, true));
        assert!(!should_dejpg("off", 0.9, true));
        assert!(should_dejpg("auto", 0.31, true));
        assert!(!should_dejpg("auto", 0.3, true));
        assert!(!should_dejpg("auto", 0.9, false));
    }

    #[test]
    fn dejpg_prepass_runs_and_preserves_dims() {
        // 条件 DeJPG：强制开启时跑 1x 预处理，主超分输出尺寸不变
        let bytes = synthetic_png(96, 64);
        let dejpg = model("1xDeJPG_realplksr_otf_60_fp32_opset17.onnx");
        assert!(std::path::Path::new(&dejpg).exists(), "DeJPG 模型缺失");
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: None,
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "on".into(),
            dejpeg_model_path: Some(dejpg),
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: false,
        };
        let r = run_core(
            "td",
            &bytes,
            &format!("{}/dejpg.png", env!("OUT_DIR")),
            &detail_model(),
            &cfg,
            &|_| {},
        )
        .expect("DeJPG 预处理应成功");
        assert_eq!(
            (r.width, r.height),
            (384, 256),
            "DeJPG 不改变最终 4x 输出尺寸"
        );
        eprintln!("DeJPG 预处理：{}×{}，{}", r.width, r.height, r.pipeline);
    }

    #[test]
    fn target_not_larger_than_source_skips_sr() {
        // 目标 ≤ 源 → 不跑超分（快速路径）
        let bytes = synthetic_png(256, 128);
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: Some(200),
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: None,
            face_upscale_model_path: None,
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: false,
        };
        let r = run_core(
            "t6",
            &bytes,
            &format!("{}/skip.png", env!("OUT_DIR")),
            &detail_model(),
            &cfg,
            &|_| {},
        )
        .unwrap();
        assert!(
            r.pipeline.contains("未跑超分"),
            "应跳过超分：{}",
            r.pipeline
        );
        assert_eq!(r.width, 200); // 长边 200
        eprintln!("跳过超分路径：{}×{}，{}", r.width, r.height, r.pipeline);
    }

    fn scrfd_model() -> String {
        model("scrfd_2.5g_bnkps.onnx")
    }
    fn faceup_model() -> String {
        model("4xFaceUpDAT_fp32_opset17.onnx")
    }

    #[test]
    fn scrfd_detect_runs_and_portrait_pipeline_completes() {
        // 人像档端到端：SCRFD 真实推理跑通（DirectML 兼容）→ 无论检出与否管线都须正常完成。
        // 渐变图是 OOD 输入，检出数不定，但必须被 MAX_FACES(64) 限流。
        let bytes = synthetic_png(192, 128);
        assert!(
            std::path::Path::new(&scrfd_model()).exists(),
            "SCRFD 模型缺失"
        );
        let cfg = EnhanceConfig {
            bit_depth: 8,
            scale: 4,
            tile_size: 64,
            tile_overlap: 16,
            target_long_edge: None,
            detail_model_path: None,
            detail_weight: 0.0,
            dejpeg: "off".into(),
            dejpeg_model_path: None,
            face_detect_model_path: Some(scrfd_model()),
            face_upscale_model_path: Some(faceup_model()),
            face_restore: "identity".into(),
            face_restore_model_path: None,
            output_format: "png".into(),
            output_dpi: None,
            emit_assets: false,
        };
        let r = run_core(
            "tf0",
            &bytes,
            &format!("{}/face0.png", env!("OUT_DIR")),
            &detail_model(),
            &cfg,
            &|_| {},
        )
        .expect("人像档管线应完成（无论检出几张脸）");
        assert_eq!((r.width, r.height), (768, 512));
        if let Some(rep) = &r.face_report {
            // 「人脸 N 张」的 N 不得超过硬上限
            let n: u32 = rep
                .trim_start_matches("人脸 ")
                .split(' ')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            assert!(n <= 64, "人脸数应被限流 ≤64，报告：{}", rep);
        }
        eprintln!(
            "人像档端到端：{}×{}，{}，报告 {:?}",
            r.width, r.height, r.pipeline, r.face_report
        );
    }

    #[test]
    fn faceup_roi_pastes_into_fused() {
        // FaceUpDAT ROI：合成脸框直接走 ROI 增强，验证 DirectML 兼容 + 羽化贴回
        assert!(
            std::path::Path::new(&faceup_model()).exists(),
            "FaceUpDAT 模型缺失"
        );
        let input = image::load_from_memory(&synthetic_png(320, 320))
            .unwrap()
            .to_rgba8();
        // 输入空间脸宽 160px（128–256 档），居中
        let f = crate::face::FaceBox {
            x1: 80.0,
            y1: 60.0,
            x2: 240.0,
            y2: 220.0,
            score: 0.9,
        };
        let mut fused = Array3::<f32>::zeros((1280, 1280, 3)); // 4x 输出空间
        face_up_roi(&mut fused, &input, &f, 4, &faceup_model()).expect("FaceUpDAT ROI 应成功");
        // ROI 中心（输出空间 640,560 附近）应非全零（被贴入了增强结果）
        let mut nonzero = 0u32;
        for y in 400..800 {
            for x in 500..900 {
                if fused[(y, x, 0)].abs() > 1e-6 || fused[(y, x, 1)].abs() > 1e-6 {
                    nonzero += 1;
                }
            }
        }
        assert!(nonzero > 10000, "ROI 中心应有大量非零像素，得 {}", nonzero);
        // ROI 远外应保持 0
        assert!(fused[(10, 10, 0)].abs() < 1e-6, "ROI 外不应被改动");
        eprintln!("FaceUpDAT ROI：中心非零像素 {}", nonzero);
    }

    #[test]
    fn codeformer_restore_runs_with_fidelity_probe() {
        // 生成式修复：CodeFormer 双输入（fidelity w=0.7 探测）真实推理。
        // 可选模型不进测试模型目录 → 指 AppData；不存在则跳过（不强制 377MB 进仓库）。
        let appdata = format!(
            "{}/site.jinpengi.momo/models/codeformer.onnx",
            std::env::var("APPDATA").unwrap_or_default()
        );
        if !std::path::Path::new(&appdata).exists() {
            eprintln!("跳过：CodeFormer 未下载（{}）", appdata);
            return;
        }
        let input = image::load_from_memory(&synthetic_png(200, 200))
            .unwrap()
            .to_rgba8();
        let f = crate::face::FaceBox {
            x1: 40.0,
            y1: 30.0,
            x2: 120.0,
            y2: 110.0,
            score: 0.9,
        }; // 小脸 80px <128
        let mut fused = Array3::<f32>::zeros((800, 800, 3));
        face_restore_roi(&mut fused, &input, &f, 4, &appdata)
            .expect("CodeFormer 修复应成功（fidelity 探测不炸）");
        let mut nonzero = 0u32;
        for y in 200..600 {
            for x in 200..600 {
                if fused[(y, x, 0)].abs() > 1e-6 {
                    nonzero += 1;
                }
            }
        }
        assert!(nonzero > 5000, "修复结果应贴回 ROI，得 {}", nonzero);
        eprintln!("CodeFormer 修复：ROI 非零像素 {}", nonzero);
    }
}
