//! 阶段二算法：质量分析 + 内容掩膜 + 拉普拉斯金字塔多频段融合（文档 §4.2 / §4.6）
//!
//! 全部是确定性的像素/数值运算，不碰 ort、不碰 IO，便于 `cargo test` 独立验证。
//! sr.rs 在「标准/专业」预设下调用这些函数做主模型(NomosWebPhoto)+细节模型(UltraSharp)融合。
use image::{ImageBuffer, Luma, RgbaImage};
use ndarray::{Array2, Array3};
use serde::Serialize;

/* ============================ 质量分析（§4.2）============================ */

/// 质量分析报告。决定是否跳过去 JPEG、用何种融合权重。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReport {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    /// JPEG 块效应评分 0..1（>0.3 视为明显压缩 → 阶段三接条件 DeJPG）
    pub jpeg_score: f32,
    /// 噪声估计 0..1
    pub noise: f32,
    /// 边缘密度 0..1（高 → 纹理/插画/线条，细节分支权重大）
    pub edge_density: f32,
    /// 高对比硬边占比 0..1：文字、Logo、规则几何边界的结构保护信号
    pub hard_edge_ratio: f32,
    /// 模糊度 0..1（越大约糊）
    pub blur: f32,
    /// 平坦色块占比 0..1（analysisMap 的 flatColor 信号：海报/文化墙高、照片低；矢量化参考）
    pub flat_ratio: f32,
    /// 平均亮度 0..1
    pub brightness: f32,
    /// 内容类型推断（文档要求的内容感知路由）
    pub content_type: String,
}

/// 最终输出的保真守卫报告。所有数值都在 0..1 浮点色域内统计，
/// 用于判断学习模型是否偏离原图，而不是宣称恢复了原图中已经不存在的信息。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FidelityReport {
    /// 质量守卫前，把高清结果按模型倍率缩回源尺寸后的平均绝对误差。
    pub source_mae_before: f32,
    /// 低频残差回投后的平均绝对误差。
    pub source_mae_after: f32,
    /// 实际进行低频校正的源像素块比例。
    pub corrected_block_ratio: f32,
    /// 细节候选因色偏、反相边缘或异常高频而被削弱的像素比例。
    pub candidate_rejected_ratio: f32,
    /// 单通道最大低频校正量。
    pub max_correction: f32,
    /// 面向 UI 的保真评分；只反映缩回源尺寸的一致性，不等同于主观清晰度。
    pub score: f32,
}

/// 在缩略图上做轻量分析（原图解码后即可，无需推理结果）
pub fn analyze(rgba: &RgbaImage) -> QualityReport {
    let (w, h) = rgba.dimensions();
    // 缩到最长边 256 加速（质量分析不需要全分辨率）
    let thumb = downsample_rgba(rgba, 256);
    let (tw, th) = thumb.dimensions();
    let mut lum: Array2<f32> = Array2::zeros((th as usize, tw as usize));
    let mut sum_b = 0f64;
    for y in 0..th {
        for x in 0..tw {
            let p = thumb.get_pixel(x, y);
            let r = p.0[0] as f32 / 255.;
            let g = p.0[1] as f32 / 255.;
            let b = p.0[2] as f32 / 255.;
            let l = 0.299 * r + 0.587 * g + 0.114 * b;
            lum[[y as usize, x as usize]] = l;
            sum_b += l as f64;
        }
    }
    let brightness = (sum_b / (tw * th) as f64) as f32;

    let jpeg_score = jpeg_block_score(&lum);
    let (edge_density, blur, hard_edge_ratio) = edge_and_blur(&lum);
    let noise = noise_estimate(&lum);
    let flat_ratio = flat_color_ratio(&lum);

    let has_alpha = rgba.as_raw().iter().step_by(4).any(|&a| a < 255);
    let content_type = classify(edge_density, jpeg_score, flat_ratio, hard_edge_ratio);
    QualityReport {
        width: w,
        height: h,
        has_alpha,
        jpeg_score,
        noise,
        edge_density,
        hard_edge_ratio,
        blur,
        flat_ratio,
        brightness,
        content_type,
    }
}

fn downsample_rgba(rgba: &RgbaImage, max_side: u32) -> RgbaImage {
    use image::imageops;
    let longest = rgba.width().max(rgba.height());
    if longest <= max_side {
        return rgba.clone();
    }
    let r = max_side as f32 / longest as f32;
    let nw = (rgba.width() as f32 * r).round().max(1.0) as u32;
    let nh = (rgba.height() as f32 * r).round().max(1.0) as u32;
    imageops::resize(rgba, nw, nh, imageops::FilterType::Nearest)
}

/// 8×8 块边界不连续性（JPEG 痕迹）：相邻 8px 块的边界处灰度跳变均值
fn jpeg_block_score(lum: &Array2<f32>) -> f32 {
    let (h, w) = lum.dim();
    // 超宽横幅/超长竖条缩到分析图后，短边可能不足 16px。usize 的 h-8/w-8
    // 会在 debug 直接下溢 panic；这种尺寸也没有足够的 8×8 块可可靠判断 JPEG 痕迹。
    if h <= 16 || w <= 16 {
        return 0.0;
    }
    let mut acc = 0f64;
    let mut n = 0u64;
    for y in (8..h - 8).step_by(8) {
        for x in 0..w {
            acc += (lum[[y, x]] - lum[[y - 1, x]]).abs() as f64;
            n += 1;
        }
    }
    for x in (8..w - 8).step_by(8) {
        for y in 0..h {
            acc += (lum[[y, x]] - lum[[y, x - 1]]).abs() as f64;
            n += 1;
        }
    }
    if n == 0 {
        return 0.0;
    }
    // 归一化到 0..1：典型干净图 <0.03，重度 JPEG ~0.1+
    ((acc / n as f64) * 6.0).min(1.0) as f32
}

/// Sobel 边缘密度 + 高频能量（模糊度的反指）
fn edge_and_blur(lum: &Array2<f32>) -> (f32, f32, f32) {
    let (h, w) = lum.dim();
    if h < 4 || w < 4 {
        return (0.0, 0.0, 0.0);
    }
    let mut mag_sum = 0f64;
    let mut hf_sum = 0f64;
    let mut hard = 0u64;
    let mut n = 0u64;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let gx = -lum[[y - 1, x - 1]] - 2.0 * lum[[y, x - 1]] - lum[[y + 1, x - 1]]
                + lum[[y - 1, x + 1]]
                + 2.0 * lum[[y, x + 1]]
                + lum[[y + 1, x + 1]];
            let gy = -lum[[y - 1, x - 1]] - 2.0 * lum[[y - 1, x]] - lum[[y - 1, x + 1]]
                + lum[[y + 1, x - 1]]
                + 2.0 * lum[[y + 1, x]]
                + lum[[y + 1, x + 1]];
            let mag = (gx * gx + gy * gy).sqrt();
            mag_sum += mag as f64;
            // Sobel 的理论范围约 0..5.66；0.72 能稳定抓到字边/Logo 边，
            // 又不会把照片里的轻纹理、胶片颗粒都当成需锁定的结构。
            if mag >= 0.72 {
                hard += 1;
            }
            // 拉普拉斯高频：|中心 - 4邻|
            let c = lum[[y, x]];
            let lap =
                (4.0 * c - lum[[y - 1, x]] - lum[[y + 1, x]] - lum[[y, x - 1]] - lum[[y, x + 1]])
                    .abs();
            hf_sum += lap as f64;
            n += 1;
        }
    }
    let mean_mag = (mag_sum / n as f64) as f32;
    let mean_hf = (hf_sum / n as f64) as f32;
    // 边缘密度归一：典型 0.05~0.4
    let edge_density = (mean_mag * 3.0).min(1.0);
    // 模糊度：高频越低越糊
    let blur = (1.0 - mean_hf * 4.0).max(0.0).min(1.0);
    let hard_edge_ratio = hard as f32 / n.max(1) as f32;
    (edge_density, blur, hard_edge_ratio)
}

/// 平滑区局部方差均值（噪声估计）
fn noise_estimate(lum: &Array2<f32>) -> f32 {
    let (h, w) = lum.dim();
    if h < 4 || w < 4 {
        return 0.0;
    }
    let mut acc = 0f64;
    let mut n = 0u64;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let c = lum[[y, x]];
            let mean =
                (lum[[y - 1, x]] + lum[[y + 1, x]] + lum[[y, x - 1]] + lum[[y, x + 1]] + c) / 5.0;
            let var = ((lum[[y - 1, x]] - mean).powi(2)
                + (lum[[y + 1, x]] - mean).powi(2)
                + (lum[[y, x - 1]] - mean).powi(2)
                + (lum[[y, x + 1]] - mean).powi(2)
                + (c - mean).powi(2))
                / 5.0;
            acc += var as f64;
            n += 1;
        }
    }
    ((acc / n as f64).sqrt() * 8.0).min(1.0) as f32
}

fn classify(edge_density: f32, jpeg_score: f32, flat_ratio: f32, hard_edge_ratio: f32) -> String {
    // 海报/文化墙的关键不是“边多”，而是大片平色中夹着高对比硬边；先识别这一组合，
    // 避免把密集小字海报误判成普通照片，也避免把草木纹理照片误判成插画。
    if flat_ratio > 0.58 && hard_edge_ratio > 0.018 {
        "poster".into()
    } else if edge_density > 0.55 {
        "illustration".into()
    } else if edge_density > 0.3 || jpeg_score > 0.4 {
        "poster".into()
    } else {
        "photo".into()
    }
}

/// 文字/Logo/规则几何的高对比硬边掩膜。与 `content_mask` 的相对归一不同，这里使用绝对阈值，
/// 不会因为一张低对比照片里“最强的那条边”而误触发整图结构回注。
pub fn hard_edge_mask(rgb: &Array3<f32>) -> Array2<f32> {
    let (h, w, _) = rgb.dim();
    let mut lum = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            lum[(y, x)] = 0.299 * rgb[(y, x, 0)] + 0.587 * rgb[(y, x, 1)] + 0.114 * rgb[(y, x, 2)];
        }
    }
    let mut mask = Array2::<f32>::zeros((h, w));
    if h > 2 && w > 2 {
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let gx = (lum[(y, x + 1)] - lum[(y, x - 1)]).abs();
                let gy = (lum[(y + 1, x)] - lum[(y - 1, x)]).abs();
                let mag = (gx * gx + gy * gy).sqrt();
                mask[(y, x)] = ((mag - 0.055) / 0.22).clamp(0.0, 1.0);
            }
        }
    }
    blur2d(&mask, 1)
}

/// 平坦色块占比：局部 3×3 灰度标准差 < 阈值 的像素比例（色块内部平滑 → 高；纹理/照片 → 低）
fn flat_color_ratio(lum: &Array2<f32>) -> f32 {
    let (h, w) = lum.dim();
    if h < 4 || w < 4 {
        return 0.0;
    }
    let mut flat = 0u64;
    let mut n = 0u64;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let c = lum[[y, x]];
            let m =
                (lum[[y - 1, x]] + lum[[y + 1, x]] + lum[[y, x - 1]] + lum[[y, x + 1]] + c) / 5.0;
            let v = ((lum[[y - 1, x]] - m).powi(2)
                + (lum[[y + 1, x]] - m).powi(2)
                + (lum[[y, x - 1]] - m).powi(2)
                + (lum[[y, x + 1]] - m).powi(2)
                + (c - m).powi(2))
                / 5.0;
            if v.sqrt() < 0.02 {
                flat += 1;
            }
            n += 1;
        }
    }
    if n > 0 {
        flat as f32 / n as f32
    } else {
        0.0
    }
}

/* ============================ 内容掩膜（§4.4 ROI 路由）============================ */

/// 由主模型放大结果计算「细节分支贡献掩膜」：高边缘/纹理区 → 1（细节模型补高频），
/// 平滑区（皮肤/天空/渐变）→ 0（主模型保色与结构，避免塑料化）。
pub fn content_mask(rgb: &Array3<f32>) -> Array2<f32> {
    let (h, w, _) = rgb.dim();
    let mut lum: Array2<f32> = Array2::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            lum[[y, x]] = 0.299 * rgb[(y, x, 0)] + 0.587 * rgb[(y, x, 1)] + 0.114 * rgb[(y, x, 2)];
        }
    }
    let mut mag = Array2::zeros((h, w));
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let gx = lum[[y, x + 1]] - lum[[y, x - 1]];
            let gy = lum[[y + 1, x]] - lum[[y - 1, x]];
            mag[[y, x]] = (gx * gx + gy * gy).sqrt();
        }
    }
    // 软归一 + 模糊羽化（避免拼接/斑块）
    let maxm = mag.iter().cloned().fold(0.0f32, f32::max).max(1e-6);
    let mut m = mag.mapv(|v| (v / maxm).clamp(0.0, 1.0));
    // 软阈值：低于 0.08 的边缘压制到 0（平滑区彻底不给细节模型权重）
    m.mapv_inplace(|v| {
        if v < 0.08 {
            0.0
        } else {
            ((v - 0.08) / 0.92).clamp(0.0, 1.0)
        }
    });
    blur2d(&m, 2)
}

/* ============================ 拉普拉斯金字塔多频段融合（§4.6）============================ */

/// 三层拉普拉斯金字塔融合：低频/颜色来自 main，高频细节按 weight 掺入 detail。
/// `weight` 形状与 main/detail 相同（已 ×detail_weight 缩放），值域 0..1。
/// 融合结果与 main 同尺寸。
pub fn pyramid_fuse(
    main: &Array3<f32>,
    detail: &Array3<f32>,
    weight: &Array2<f32>,
    levels: usize,
) -> Array3<f32> {
    assert_eq!(main.dim(), detail.dim());
    let lv = levels.max(1).min(4);
    // 各层构建（对 main/detail 的每通道做 2D 金字塔）
    let g_main = gauss_pyramid3(main, lv);
    let g_detail = gauss_pyramid3(detail, lv);
    let w_pyr = gauss_pyramid2(weight, lv);
    // 拉普拉斯层 = G_i - up(G_{i+1})；最顶层保留 G_last
    let mut lap_main: Vec<Array3<f32>> = Vec::with_capacity(lv);
    let mut lap_det: Vec<Array3<f32>> = Vec::with_capacity(lv);
    for i in 0..lv - 1 {
        let up = up3(&g_main[i + 1], g_main[i].dim());
        lap_main.push(&g_main[i] - &up);
        let upd = up3(&g_detail[i + 1], g_detail[i].dim());
        lap_det.push(&g_detail[i] - &upd);
    }
    // 最顶层（基带）直接做加权平均（颜色/结构来自 main，detail 少掺）
    let base_w = w_pyr[lv - 1].mapv(|v| (v * 0.25).clamp(0.0, 1.0)); // 基带细节权重压到 1/4，保色
    let mut cur = mix3(&g_main[lv - 1], &g_detail[lv - 1], &base_w);
    // 自顶向下重建：每层把 detail 的拉普拉斯按权重掺进 main 的拉普拉斯
    for i in (0..lv - 1).rev() {
        let w = &w_pyr[i];
        let fused_lap = mix3(&lap_main[i], &lap_det[i], w);
        let up = up3(&cur, fused_lap.dim());
        cur = &fused_lap + &up;
    }
    cur
}

fn mix3(a: &Array3<f32>, b: &Array3<f32>, w: &Array2<f32>) -> Array3<f32> {
    let (h, ww, c) = a.dim();
    let mut out = Array3::zeros((h, ww, c));
    for y in 0..h {
        for x in 0..ww {
            let wi = w[[y, x]].clamp(0.0, 1.0);
            for ch in 0..c {
                out[(y, x, ch)] = a[(y, x, ch)] * (1.0 - wi) + b[(y, x, ch)] * wi;
            }
        }
    }
    out
}

/* ---- 金字塔下采样 / 上采样工具 ---- */

fn gauss_pyramid3(img: &Array3<f32>, levels: usize) -> Vec<Array3<f32>> {
    let mut pyr = Vec::with_capacity(levels);
    pyr.push(img.clone());
    for _ in 1..levels {
        let last = pyr.last().unwrap();
        pyr.push(down3(last));
    }
    pyr
}
fn gauss_pyramid2(img: &Array2<f32>, levels: usize) -> Vec<Array2<f32>> {
    let mut pyr = Vec::with_capacity(levels);
    pyr.push(img.clone());
    for _ in 1..levels {
        let last = pyr.last().unwrap();
        pyr.push(down2(last));
    }
    pyr
}

fn down3(a: &Array3<f32>) -> Array3<f32> {
    let (h, w, c) = a.dim();
    let nh = ((h + 1) / 2).max(1);
    let nw = ((w + 1) / 2).max(1);
    let mut out = Array3::zeros((nh, nw, c));
    for ch in 0..c {
        let ch2 = a.slice(ndarray::s![.., .., ch]).to_owned();
        let r = resize2(&blur2d(&ch2, 1), nh, nw);
        for y in 0..nh {
            for x in 0..nw {
                out[(y, x, ch)] = r[[y, x]];
            }
        }
    }
    out
}
fn down2(a: &Array2<f32>) -> Array2<f32> {
    let (h, w) = a.dim();
    let nh = ((h + 1) / 2).max(1);
    let nw = ((w + 1) / 2).max(1);
    resize2(&blur2d(a, 1), nh, nw)
}
fn up3(a: &Array3<f32>, target: (usize, usize, usize)) -> Array3<f32> {
    let (th, tw, c) = target;
    let mut out = Array3::zeros((th, tw, c));
    for ch in 0..c {
        let ch2 = a.slice(ndarray::s![.., .., ch]).to_owned();
        let r = blur2d(&resize2(&ch2, th, tw), 1);
        for y in 0..th {
            for x in 0..tw {
                out[(y, x, ch)] = r[[y, x]];
            }
        }
    }
    out
}

/// [1,4,6,4,1]/16 可分离模糊；radius 控制迭代次数
fn blur2d(a: &Array2<f32>, radius: usize) -> Array2<f32> {
    let mut cur = a.clone();
    for _ in 0..radius.max(1) {
        cur = blur_once(&cur);
    }
    cur
}
fn blur_once(a: &Array2<f32>) -> Array2<f32> {
    let (h, w) = a.dim();
    let k = [1f32, 4.0, 6.0, 4.0, 1.0];
    let div = 16.0;
    // 水平通
    let mut tmp = Array2::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (i, &kv) in k.iter().enumerate() {
                let xx = (x as isize + (i as isize - 2)).clamp(0, w as isize - 1) as usize;
                acc += a[[y, xx]] * kv;
            }
            tmp[[y, x]] = acc / div;
        }
    }
    // 垂直通
    let mut out = Array2::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (i, &kv) in k.iter().enumerate() {
                let yy = (y as isize + (i as isize - 2)).clamp(0, h as isize - 1) as usize;
                acc += tmp[[yy, x]] * kv;
            }
            out[[y, x]] = acc / div;
        }
    }
    out
}

/// 双线性 resize
fn resize2(a: &Array2<f32>, th: usize, tw: usize) -> Array2<f32> {
    let (h, w) = a.dim();
    if h == th && w == tw {
        return a.clone();
    }
    let mut out = Array2::zeros((th, tw));
    let sy = if th > 1 {
        (h - 1) as f32 / (th - 1).max(1) as f32
    } else {
        0.0
    };
    let sx = if tw > 1 {
        (w - 1) as f32 / (tw - 1).max(1) as f32
    } else {
        0.0
    };
    for y in 0..th {
        let gy = sy * y as f32;
        let y0 = gy.floor() as usize;
        let y1 = (y0 + 1).min(h - 1);
        let fy = gy - y0 as f32;
        for x in 0..tw {
            let gx = sx * x as f32;
            let x0 = gx.floor() as usize;
            let x1 = (x0 + 1).min(w - 1);
            let fx = gx - x0 as f32;
            let v = a[[y0, x0]] * (1.0 - fx) * (1.0 - fy)
                + a[[y0, x1]] * fx * (1.0 - fy)
                + a[[y1, x0]] * (1.0 - fx) * fy
                + a[[y1, x1]] * fx * fy;
            out[[y, x]] = v;
        }
    }
    out
}

/// 边缘密度图（0..1，Sobel 归一 + 羽化）：细节模型 ROI 用——平坦区 → 0，跳过细节推理（文档 §21.4）。
/// 取 RgbaImage 直接算（避免外部转换）。
pub fn edge_density_map(rgba: &RgbaImage) -> Array2<f32> {
    let (w, h) = rgba.dimensions();
    let mut lum: Array2<f32> = Array2::zeros((h as usize, w as usize));
    for y in 0..h {
        for x in 0..w {
            let p = rgba.get_pixel(x, y);
            lum[[y as usize, x as usize]] =
                (0.299 * p.0[0] as f32 + 0.587 * p.0[1] as f32 + 0.114 * p.0[2] as f32) / 255.0;
        }
    }
    let mut mag: Array2<f32> = Array2::zeros((h as usize, w as usize));
    if h > 2 && w > 2 {
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let gx = lum[[y as usize, (x + 1) as usize]] - lum[[y as usize, (x - 1) as usize]];
                let gy = lum[((y + 1) as usize, x as usize)] - lum[((y - 1) as usize, x as usize)];
                mag[[y as usize, x as usize]] = (gx * gx + gy * gy).sqrt();
            }
        }
    }
    let maxm = mag.iter().cloned().fold(0.0f32, f32::max).max(1e-6);
    blur2d(&mag.mapv(|v| (v / maxm).clamp(0.0, 1.0)), 1)
}

/// 生成 analysisMap 的像素级掩膜 PNG（flat 色块掩膜 + edge 边缘掩膜），≤256 分辨率。
/// 返回掩膜尺寸（供 analysisMap 记录 analysisWidth/Height + 坐标变换）。
pub fn write_analysis_masks(
    rgba: &RgbaImage,
    flat_path: &str,
    edge_path: &str,
) -> Result<(u32, u32), String> {
    let (w, h) = (rgba.width(), rgba.height());
    let longest = w.max(h).max(1);
    let scale = if longest > 256 {
        256.0 / longest as f32
    } else {
        1.0
    };
    let (tw, th) = (
        ((w as f32 * scale).round() as u32).max(1),
        ((h as f32 * scale).round() as u32).max(1),
    );
    let thumb = if scale < 1.0 {
        image::imageops::resize(rgba, tw, th, image::imageops::FilterType::Nearest)
    } else {
        rgba.clone()
    };
    let mut lum = Array2::zeros((th as usize, tw as usize));
    for y in 0..th {
        for x in 0..tw {
            let p = thumb.get_pixel(x, y);
            lum[[y as usize, x as usize]] =
                (0.299 * p.0[0] as f32 + 0.587 * p.0[1] as f32 + 0.114 * p.0[2] as f32) / 255.0;
        }
    }
    let mut flat: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::new(tw, th);
    let mut edge: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::new(tw, th);
    for y in 0..th {
        for x in 0..tw {
            // edge：Sobel 幅度
            let gx = if x > 0 && x + 1 < tw {
                lum[[y as usize, (x + 1) as usize]] - lum[[y as usize, (x - 1) as usize]]
            } else {
                0.0
            };
            let gy = if y > 0 && y + 1 < th {
                lum[[(y + 1) as usize, x as usize]] - lum[[(y - 1) as usize, x as usize]]
            } else {
                0.0
            };
            let e = (gx * gx + gy * gy).sqrt().min(1.0);
            edge.put_pixel(x, y, Luma([(e * 255.0) as u8]));
            // flat：3×3 局部方差低 → 白（色块内部）
            let (mut s, mut ss, mut n) = (0.0f32, 0.0f32, 0.0f32);
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let yy = (y as i32 + dy).clamp(0, th as i32 - 1) as usize;
                    let xx = (x as i32 + dx).clamp(0, tw as i32 - 1) as usize;
                    let v = lum[[yy, xx]];
                    s += v;
                    ss += v * v;
                    n += 1.0;
                }
            }
            let mean = s / n;
            let var = (ss / n - mean * mean).max(0.0);
            let f = 1.0 - (var * 60.0).min(1.0);
            flat.put_pixel(x, y, Luma([(f * 255.0) as u8]));
        }
    }
    flat.save(flat_path)
        .map_err(|e| format!("写 flat mask 失败：{}", e))?;
    edge.save(edge_path)
        .map_err(|e| format!("写 edge mask 失败：{}", e))?;
    Ok((tw, th))
}

/* ============================ 双频段融合（大图用，更快）============================ */
/// 低频(颜色/结构)来自 main 的强模糊；高频按 weight 在 main/detail 间取。
/// 比 pyramid_fuse 快约 3x（只 2 次全图模糊），大图（4K+）用它避免融合阶段长时间卡顿。
/// 文档 §4.6 允许「或等价多频段融合」——这是其轻量版。
/// `prog` 按阶段回报 0..1（两次三通道模糊各占 ~40%，逐像素混合占 ~20%）——
/// 融合是超分全程最重的单线程 CPU 段，没有它进度条会长时间钉住不动。
pub fn fuse_2band(
    main: &Array3<f32>,
    detail: &Array3<f32>,
    weight: &Array2<f32>,
    prog: &dyn Fn(f32),
) -> Array3<f32> {
    let (h, w, c) = main.dim();
    prog(0.0);
    let low_main = blur3d(main, 2);
    prog(0.4);
    let low_det = blur3d(detail, 2);
    prog(0.8);
    let mut out = Array3::zeros((h, w, c));
    for y in 0..h {
        for x in 0..w {
            let wi = weight[[y, x]].clamp(0.0, 1.0);
            for ch in 0..c {
                let lm = low_main[(y, x, ch)];
                let hm = main[(y, x, ch)] - lm;
                let hd = detail[(y, x, ch)] - low_det[(y, x, ch)];
                out[(y, x, ch)] = (lm + hm * (1.0 - wi) + hd * wi).clamp(0.0, 1.0);
            }
        }
    }
    prog(1.0);
    out
}

fn blur3d(a: &Array3<f32>, radius: usize) -> Array3<f32> {
    let (h, w, c) = a.dim();
    let mut out = Array3::zeros((h, w, c));
    for ch in 0..c {
        let ch2 = a.slice(ndarray::s![.., .., ch]).to_owned();
        let b = blur2d(&ch2, radius);
        for y in 0..h {
            for x in 0..w {
                out[(y, x, ch)] = b[[y, x]];
            }
        }
    }
    out
}

/// 光晕抑制（文档 §16.3）：在强边处把融合结果向结构基带回收 30%，压掉边缘过冲/振铃；
/// 平滑与纹理区不动（不误伤合法高频）。保守默认，不改变整体观感。
pub fn suppress_halos(fused: &Array3<f32>, base: &Array3<f32>, edge: &Array2<f32>) -> Array3<f32> {
    let (h, w, c) = fused.dim();
    let mut out = fused.clone();
    for y in 0..h {
        for x in 0..w {
            if edge[[y, x]] > 0.4 {
                for ch in 0..c {
                    let d = fused[(y, x, ch)] - base[(y, x, ch)];
                    out[(y, x, ch)] = base[(y, x, ch)] + d * 0.7;
                }
            }
        }
    }
    out
}

/// 生产质量守卫：限制细节分支相对主模型的逐像素偏移。
///
/// 双模型在渐变/平坦色块上最容易注入棋盘纹、彩边和假纹理；这些区域允许的偏移应很小，
/// 真正强边缘处再逐渐放宽。守卫不改变主模型，只约束附加细节，因此异常时天然退回稳定基带。
pub fn guard_detail_deviation(
    fused: &Array3<f32>,
    base: &Array3<f32>,
    edge: &Array2<f32>,
) -> Array3<f32> {
    let (h, w, c) = fused.dim();
    let mut out = fused.clone();
    for y in 0..h {
        for x in 0..w {
            let g = edge[[y, x]].clamp(0.0, 1.0);
            // 平坦区最多约 1.5/255；强边缘最多约 17/255。细节模型只补可信高频，不重画文字、发丝和皮肤。
            let limit = 0.006 + 0.060 * g;
            for ch in 0..c {
                let b = base[(y, x, ch)];
                out[(y, x, ch)] = fused[(y, x, ch)]
                    .clamp(b - limit, b + limit)
                    .clamp(0.0, 1.0);
            }
        }
    }
    out
}

/// 候选细节质量门控：在真正融合前逐像素检查候选模型。
///
/// - 大幅颜色漂移不作为“细节”注入；
/// - 与保真基底反相的强边会形成双描边，直接压低权重；
/// - 候选局部高频远高于基底时视为砂纸纹/振铃，只保留一小部分；
/// - 已经接近基底且边缘方向一致的高频不受影响。
///
/// 返回门控后的权重与被明显削弱（保留不足一半）的像素比例。
pub fn gate_candidate_weight(
    base: &Array3<f32>,
    candidate: &Array3<f32>,
    proposed: &Array2<f32>,
) -> (Array2<f32>, f32) {
    assert_eq!(base.dim(), candidate.dim());
    let (h, w, _) = base.dim();
    assert_eq!(proposed.dim(), (h, w));
    let mut out = proposed.clone();
    let mut considered = 0usize;
    let mut rejected = 0usize;

    for y in 0..h {
        for x in 0..w {
            let pw = proposed[(y, x)].clamp(0.0, 1.0);
            if pw <= 1e-5 {
                out[(y, x)] = 0.0;
                continue;
            }
            considered += 1;
            let bl = 0.299 * base[(y, x, 0)] + 0.587 * base[(y, x, 1)] + 0.114 * base[(y, x, 2)];
            let cl = 0.299 * candidate[(y, x, 0)]
                + 0.587 * candidate[(y, x, 1)]
                + 0.114 * candidate[(y, x, 2)];
            let mut rgb_delta = 0.0f32;
            let mut chroma_delta = 0.0f32;
            let mut clipped = false;
            for c in 0..3 {
                let b = base[(y, x, c)];
                let d = candidate[(y, x, c)];
                rgb_delta += (d - b).abs() / 3.0;
                chroma_delta += ((d - cl) - (b - bl)).abs() / 3.0;
                clipped |= (d < 0.003 || d > 0.997) && b > 0.02 && b < 0.98;
            }

            let smooth_reject = |v: f32, lo: f32, hi: f32| -> f32 {
                let t = ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
                1.0 - t * t * (3.0 - 2.0 * t)
            };
            let mut confidence =
                smooth_reject(rgb_delta, 0.025, 0.14) * smooth_reject(chroma_delta, 0.010, 0.055);
            if clipped {
                confidence *= 0.55;
            }

            if y > 0 && y + 1 < h && x > 0 && x + 1 < w {
                let lum = |img: &Array3<f32>, yy: usize, xx: usize| {
                    0.299 * img[(yy, xx, 0)] + 0.587 * img[(yy, xx, 1)] + 0.114 * img[(yy, xx, 2)]
                };
                let base_lap = bl
                    - (lum(base, y - 1, x)
                        + lum(base, y + 1, x)
                        + lum(base, y, x - 1)
                        + lum(base, y, x + 1))
                        * 0.25;
                let cand_lap = cl
                    - (lum(candidate, y - 1, x)
                        + lum(candidate, y + 1, x)
                        + lum(candidate, y, x - 1)
                        + lum(candidate, y, x + 1))
                        * 0.25;
                if base_lap.abs() > 0.012
                    && cand_lap.abs() > 0.018
                    && base_lap.signum() != cand_lap.signum()
                {
                    confidence *= 0.18;
                }
                let inflation = cand_lap.abs() / (base_lap.abs() + 0.012);
                if inflation > 3.0 {
                    confidence *= (3.0 / inflation).clamp(0.12, 1.0);
                }
            }

            if confidence < 0.5 {
                rejected += 1;
            }
            out[(y, x)] = pw * confidence.clamp(0.0, 1.0);
        }
    }
    let ratio = if considered == 0 {
        0.0
    } else {
        rejected as f32 / considered as f32
    };
    (out, ratio)
}

/// 一次轻量迭代反投影：把高清结果按整数倍率分块缩回源尺寸，
/// 将低频残差回投到对应高清块。块内所有像素加同一颜色残差，
/// 因而不会抹掉学习模型生成的可信高频，却能显著压低整体色偏与亮度漂移。
///
/// `strength` 由内容路由决定：文字/色块更严格，照片允许更多生成自由。
pub fn enforce_source_consistency(
    output: &mut Array3<f32>,
    source: &RgbaImage,
    scale: u32,
    strength: f32,
    candidate_rejected_ratio: f32,
) -> FidelityReport {
    let (h, w, c) = output.dim();
    if c != 3
        || scale == 0
        || w != source.width() as usize * scale as usize
        || h != source.height() as usize * scale as usize
    {
        return FidelityReport {
            candidate_rejected_ratio,
            score: 0.0,
            ..FidelityReport::default()
        };
    }

    let s = scale as usize;
    let gain = strength.clamp(0.0, 1.0);
    let mut before_sum = 0.0f64;
    let mut after_sum = 0.0f64;
    let mut corrected = 0usize;
    let mut max_correction = 0.0f32;
    let total = source.width() as usize * source.height() as usize;

    for sy in 0..source.height() as usize {
        for sx in 0..source.width() as usize {
            let mut mean = [0.0f32; 3];
            for oy in sy * s..(sy + 1) * s {
                for ox in sx * s..(sx + 1) * s {
                    for ch in 0..3 {
                        mean[ch] += output[(oy, ox, ch)];
                    }
                }
            }
            let inv = 1.0 / (s * s) as f32;
            for v in &mut mean {
                *v *= inv;
            }
            let p = source.get_pixel(sx as u32, sy as u32);
            let src = [
                p.0[0] as f32 / 255.0,
                p.0[1] as f32 / 255.0,
                p.0[2] as f32 / 255.0,
            ];
            let err =
                ((src[0] - mean[0]).abs() + (src[1] - mean[1]).abs() + (src[2] - mean[2]).abs())
                    / 3.0;
            before_sum += err as f64;

            // 源图强边处，分块均值天然受采样相位影响，适度放宽；平坦区则严格纠正色偏。
            let left = sx.saturating_sub(1) as u32;
            let right = (sx + 1).min(source.width() as usize - 1) as u32;
            let top = sy.saturating_sub(1) as u32;
            let bottom = (sy + 1).min(source.height() as usize - 1) as u32;
            let pl = source.get_pixel(left, sy as u32);
            let pr = source.get_pixel(right, sy as u32);
            let pt = source.get_pixel(sx as u32, top);
            let pb = source.get_pixel(sx as u32, bottom);
            let luma = |px: &image::Rgba<u8>| {
                (0.299 * px.0[0] as f32 + 0.587 * px.0[1] as f32 + 0.114 * px.0[2] as f32) / 255.0
            };
            let edge = ((luma(pr) - luma(pl)).powi(2) + (luma(pb) - luma(pt)).powi(2))
                .sqrt()
                .clamp(0.0, 1.0);
            let tolerance = 0.006 + 0.022 * edge;
            let trigger = ((err - tolerance) / 0.055).clamp(0.0, 1.0);
            let local_gain = gain * trigger * trigger * (3.0 - 2.0 * trigger);
            let limit = 0.035 + 0.070 * edge;
            let mut correction = [0.0f32; 3];
            let mut after_mean = mean;
            if local_gain > 1e-5 {
                corrected += 1;
                for ch in 0..3 {
                    correction[ch] = ((src[ch] - mean[ch]) * local_gain).clamp(-limit, limit);
                    max_correction = max_correction.max(correction[ch].abs());
                    after_mean[ch] = 0.0;
                }
                for oy in sy * s..(sy + 1) * s {
                    for ox in sx * s..(sx + 1) * s {
                        for ch in 0..3 {
                            output[(oy, ox, ch)] =
                                (output[(oy, ox, ch)] + correction[ch]).clamp(0.0, 1.0);
                            after_mean[ch] += output[(oy, ox, ch)];
                        }
                    }
                }
                for v in &mut after_mean {
                    *v *= inv;
                }
            }
            after_sum += (((src[0] - after_mean[0]).abs()
                + (src[1] - after_mean[1]).abs()
                + (src[2] - after_mean[2]).abs())
                / 3.0) as f64;
        }
    }

    let denom = total.max(1) as f64;
    let source_mae_before = (before_sum / denom) as f32;
    let source_mae_after = (after_sum / denom) as f32;
    FidelityReport {
        source_mae_before,
        source_mae_after,
        corrected_block_ratio: corrected as f32 / total.max(1) as f32,
        candidate_rejected_ratio,
        max_correction,
        score: (1.0 - source_mae_after * 12.0).clamp(0.0, 1.0),
    }
}

/// 轻量输出锐化（文档 §17 USM）：仅在有边缘处增强高频，平坦色块内部不锐化（避免噪点/色带）。
pub fn unsharp(img: &Array3<f32>, edge: &Array2<f32>, amount: f32) -> Array3<f32> {
    let (h, w, c) = img.dim();
    let blur = blur3d(img, 1);
    let mut out = img.clone();
    for y in 0..h {
        for x in 0..w {
            let g = edge[[y, x]].clamp(0.0, 1.0);
            for ch in 0..c {
                let high = img[(y, x, ch)] - blur[(y, x, ch)];
                out[(y, x, ch)] = (img[(y, x, ch)] + amount * high * g).clamp(0.0, 1.0);
            }
        }
    }
    out
}

/* ============================ 单测 ============================ */
#[cfg(test)]
mod tests {
    use super::*;

    fn gradient_rgb(w: usize, h: usize) -> Array3<f32> {
        let mut a = Array3::zeros((h, w, 3));
        for y in 0..h {
            for x in 0..w {
                a[(y, x, 0)] = x as f32 / w as f32;
                a[(y, x, 1)] = y as f32 / h as f32;
                a[(y, x, 2)] = 0.5;
            }
        }
        a
    }

    #[test]
    fn fuse_identity() {
        // main == detail → 融合结果应 == main（任意权重）
        let m = gradient_rgb(64, 48);
        let w = Array2::from_shape_fn((48, 64), |(y, x)| ((x + y) % 7) as f32 / 7.0);
        let fused = pyramid_fuse(&m, &m, &w, 3);
        assert_eq!(fused.dim(), m.dim());
        let max_diff = fused
            .iter()
            .zip(m.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff < 1e-3,
            "main==detail 融合应等于 main，最大偏差 {} 应 < 1e-3",
            max_diff
        );
    }

    #[test]
    fn fuse_dims() {
        let m = gradient_rgb(80, 60);
        let d = gradient_rgb(80, 60);
        let w = Array2::ones((60, 80));
        let fused = pyramid_fuse(&m, &d, &w, 3);
        assert_eq!(fused.dim(), (60, 80, 3));
    }

    #[test]
    fn content_mask_shape() {
        let m = gradient_rgb(64, 48);
        let mask = content_mask(&m);
        assert_eq!(mask.dim(), (48, 64));
        // 渐变图边缘弱，掩膜整体偏低
        let mx = mask.iter().cloned().fold(0.0f32, f32::max);
        assert!(mx <= 1.0 + 1e-5);
    }

    #[test]
    fn suppress_halos_reduces_overshoot() {
        let base = gradient_rgb(64, 48);
        let mut fused = base.clone();
        fused.mapv_inplace(|v| (v + 0.4).min(1.0)); // 全图 +0.4（模拟边缘过冲）
        let edge = Array2::ones((48, 64)); // 全强边
        let out = suppress_halos(&fused, &base, &edge);
        let dev = (out[(0, 0, 0)] - base[(0, 0, 0)]).abs();
        assert!(dev < 0.35, "光晕抑制后偏移应减小到 ~0.28，得 {}", dev);
    }

    #[test]
    fn unsharp_preserves_flat() {
        let flat = Array3::from_shape_fn((10, 10, 3), |(_, _, _)| 0.5);
        let edge = Array2::ones((10, 10));
        let out = unsharp(&flat, &edge, 0.2);
        let maxdiff = out
            .iter()
            .zip(flat.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(maxdiff < 1e-4, "平坦图锐化应无变化，得 {}", maxdiff);
    }

    #[test]
    fn detail_guard_clamps_flat_artifacts_but_keeps_edges() {
        let base = Array3::<f32>::from_elem((8, 8, 3), 0.5);
        let bad = Array3::<f32>::from_elem((8, 8, 3), 0.8);
        let mut edge = Array2::<f32>::zeros((8, 8));
        edge[[4, 4]] = 1.0;
        let out = guard_detail_deviation(&bad, &base, &edge);
        assert!(
            (out[(0, 0, 0)] - 0.5).abs() <= 0.009,
            "平坦区应强约束假纹理"
        );
        // 生产阈值主动压低高反差细节，仍保留可见边缘，但不再要求
        // 旧版容易产生砂纸纹理的 0.09 以上增益。
        assert!(out[(4, 4, 0)] - 0.5 > 0.05, "真边缘仍应保留可见的细节贡献");
    }

    #[test]
    fn fuse_2band_identity() {
        // main == detail → 双频段融合应 == main（低频相同、高频相同 → 还原）
        let m = gradient_rgb(64, 48);
        let w = Array2::from_shape_fn((48, 64), |(y, x)| ((x + y) % 5) as f32 / 5.0);
        let fused = fuse_2band(&m, &m, &w, &|_| {});
        assert_eq!(fused.dim(), m.dim());
        let max_diff = fused
            .iter()
            .zip(m.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff < 1e-3,
            "双频段 main==detail 应等于 main，最大偏差 {}",
            max_diff
        );
    }

    #[test]
    fn analyze_sanity() {
        let img: RgbaImage =
            image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(64, 64, |x, y| {
                image::Rgb([(x * 4) as u8, (y * 4) as u8, 128])
            }))
            .to_rgba8();
        let q = analyze(&img);
        assert_eq!((q.width, q.height), (64, 64));
        assert!(q.jpeg_score >= 0.0 && q.jpeg_score <= 1.0);
        assert!(q.edge_density >= 0.0 && q.edge_density <= 1.0);
        assert!(q.hard_edge_ratio >= 0.0 && q.hard_edge_ratio <= 1.0);
        assert!(
            q.flat_ratio >= 0.0 && q.flat_ratio <= 1.0,
            "flat_ratio 应在 0..1"
        );
        assert!(matches!(
            q.content_type.as_str(),
            "photo" | "illustration" | "poster"
        ));
    }

    #[test]
    fn hard_edge_mask_distinguishes_logo_edge_from_gradient() {
        let gradient = gradient_rgb(96, 64);
        let mut logo = Array3::<f32>::zeros((64, 96, 3));
        for y in 0..64 {
            for x in 0..96 {
                let v = if x < 48 { 0.05 } else { 0.95 };
                for c in 0..3 {
                    logo[(y, x, c)] = v;
                }
            }
        }
        let gm = hard_edge_mask(&gradient);
        let lm = hard_edge_mask(&logo);
        let gmax = gm.iter().copied().fold(0.0f32, f32::max);
        let lmax = lm.iter().copied().fold(0.0f32, f32::max);
        assert!(gmax < 0.25, "平滑渐变不应触发强结构保护，得 {}", gmax);
        assert!(lmax > 0.55, "高对比 Logo 边应触发结构保护，得 {}", lmax);
    }

    #[test]
    fn candidate_gate_rejects_color_shift_and_reversed_edge() {
        let mut base = Array3::<f32>::from_elem((16, 16, 3), 0.2);
        let mut candidate = base.clone();
        for y in 0..16 {
            for x in 8..16 {
                for c in 0..3 {
                    base[(y, x, c)] = 0.8;
                    candidate[(y, x, c)] = 0.8;
                }
            }
        }
        // 左上区域制造明显色偏；边界两侧制造反相高频。
        for y in 0..8 {
            for x in 0..8 {
                candidate[(y, x, 0)] = 0.65;
                candidate[(y, x, 1)] = 0.05;
            }
        }
        for y in 0..16 {
            candidate[(y, 7, 0)] = 0.95;
            candidate[(y, 7, 1)] = 0.95;
            candidate[(y, 7, 2)] = 0.95;
            candidate[(y, 8, 0)] = 0.05;
            candidate[(y, 8, 1)] = 0.05;
            candidate[(y, 8, 2)] = 0.05;
        }
        let proposed = Array2::<f32>::ones((16, 16));
        let (gated, ratio) = gate_candidate_weight(&base, &candidate, &proposed);
        assert!(gated[(2, 2)] < 0.15, "明显色偏应被拒绝");
        assert!(gated[(10, 12)] > 0.95, "一致区域应完整保留");
        assert!(gated[(10, 7)] < 0.35, "反相边缘应被压低，避免双描边");
        assert!(ratio > 0.2, "应报告被拒绝候选区域");
    }

    #[test]
    fn source_consistency_back_projection_reduces_error_without_erasing_detail() {
        let src: RgbaImage = ImageBuffer::from_fn(4, 3, |x, y| {
            image::Rgba([(30 + x * 30) as u8, (50 + y * 35) as u8, 120, 255])
        });
        let mut out = Array3::<f32>::zeros((12, 16, 3));
        for y in 0..12 {
            for x in 0..16 {
                let p = src.get_pixel((x / 4) as u32, (y / 4) as u32);
                for c in 0..3 {
                    // 统一色偏 + 块内交替纹理；反投影应修正前者但保留后者。
                    let texture = if (x + y) % 2 == 0 { 0.025 } else { -0.025 };
                    out[(y, x, c)] = (p.0[c] as f32 / 255.0 + 0.08 + texture).clamp(0.0, 1.0);
                }
            }
        }
        let before_detail = out[(2, 2, 0)] - out[(2, 3, 0)];
        let rep = enforce_source_consistency(&mut out, &src, 4, 1.0, 0.25);
        let after_detail = out[(2, 2, 0)] - out[(2, 3, 0)];
        assert!(rep.source_mae_after < rep.source_mae_before * 0.7);
        assert!(rep.corrected_block_ratio > 0.9);
        assert!(
            (after_detail - before_detail).abs() < 1e-4,
            "块内高频应被保留"
        );
        assert_eq!(rep.candidate_rejected_ratio, 0.25);
    }
}
