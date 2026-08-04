//! 矢量候选评分（批次5，文档 §9 多候选选优）：
//! 候选 SVG 经 resvg 渲染成 ≤512 位图，与原图缩略图（白底合成）比
//! **颜色 RMSE + Sobel 边缘重合度**，再扣**复杂度惩罚**（锚点数/预算比），总分高者胜出。
//!
//! - 纯 Rust（resvg/tiny-skia），无系统依赖；fast 档不评分（单候选直出）。
//! - 锚点数近似 = path `d` 属性里的命令字母数（M/L/C/Q…每个≈一个锚点或控制点）。
use image::{imageops, RgbaImage};

type SResult<T> = Result<T, String>;

/// 单项评分拆解（total 高 = 更优；分项供测试/日志诊断用）
#[allow(dead_code)] // 分项在非 test 构建里只被 total 使用
#[derive(Debug, Clone, Copy)]
pub struct Score {
    pub total: f64,
    /// 颜色 RMSE（0..1，越小越像）
    pub rmse: f64,
    /// 边缘 IoU（0..1，越大越像）
    pub edge_iou: f64,
    /// 透明轮廓 IoU 0..1；不透明源图固定为 1
    pub alpha_iou: f64,
    /// 锚点数（复杂度）
    pub anchors: usize,
}

/// 评分渲染的最大边长（候选间一致即可，不放大）
// 512 对大幅中文笔画、小圆角和细描边过于宽松；1024 仍可控，但能显著减少“缩略图看着像、原尺寸边缘错”的假阳性。
pub const SCORE_SIDE: u32 = 1024;

/// 数 SVG 锚点：只扫 path 的 d="..." 属性内的命令字母（避开 hex 颜色里的 a-f 字母）
pub fn count_anchors(svg: &str) -> usize {
    let b = svg.as_bytes();
    let mut n = 0usize;
    let mut i = 0usize;
    while i + 3 < b.len() {
        // 找 d=" 或 d='
        if b[i] == b'd' && b[i + 1] == b'=' && (b[i + 2] == b'"' || b[i + 2] == b'\'') {
            let quote = b[i + 2];
            i += 3;
            while i < b.len() && b[i] != quote {
                let c = b[i];
                if c.is_ascii_alphabetic() {
                    n += 1;
                }
                i += 1;
            }
        }
        i += 1;
    }
    n
}

/// SVG → RGBA 位图（等比缩到 ≤max_side；tiny-skia 预乘 alpha 先解预乘）
pub fn render_svg(svg: &str, max_side: u32) -> SResult<RgbaImage> {
    let opt = resvg::usvg::Options::default();
    let tree =
        resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| format!("解析候选 SVG 失败：{}", e))?;
    let size = tree.size();
    let (w, h) = (size.width().max(1.0), size.height().max(1.0));
    let scale = (max_side as f32 / w.max(h)).min(1.0);
    let pw = ((w * scale).round().max(1.0)) as u32;
    let ph = ((h * scale).round().max(1.0)) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(pw, ph).ok_or("创建评分位图失败")?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let mut img = RgbaImage::new(pw, ph);
    for (i, px) in pixmap.pixels().iter().enumerate() {
        let (x, y) = (i as u32 % pw, i as u32 / pw);
        let a = px.alpha();
        // 预乘 → 直乘（透明像素按白底 RGB，反正 alpha=0 合成后就是白）
        let (r, g, b) = if a == 0 || a == 255 {
            (px.red(), px.green(), px.blue())
        } else {
            (
                ((px.red() as u16 * 255 + a as u16 / 2) / a as u16).min(255) as u8,
                ((px.green() as u16 * 255 + a as u16 / 2) / a as u16).min(255) as u8,
                ((px.blue() as u16 * 255 + a as u16 / 2) / a as u16).min(255) as u8,
            )
        };
        img.put_pixel(x, y, image::Rgba([r, g, b, a]));
    }
    Ok(img)
}

/// 白底合成（RGBA → RGB u8 三元组），对比双方口径一致
fn flatten_over_white(img: &RgbaImage) -> Vec<(u16, u16, u16)> {
    img.pixels()
        .map(|p| {
            let a = p.0[3] as u16;
            let ia = 255 - a;
            (
                (p.0[0] as u16 * a + 255 * ia) / 255,
                (p.0[1] as u16 * a + 255 * ia) / 255,
                (p.0[2] as u16 * a + 255 * ia) / 255,
            )
        })
        .collect()
}

fn luma(c: (u16, u16, u16)) -> u16 {
    // u32 中间量：255×299=76245 超 u16，debug 构建会 panic
    ((c.0 as u32 * 299 + c.1 as u32 * 587 + c.2 as u32 * 114) / 1000) as u16
}

/// Sobel 边缘二值图（阈值 = 均值 + 0.5×标准差，自适应不同内容）
fn edge_map(px: &[(u16, u16, u16)], w: usize, h: usize) -> Vec<bool> {
    let lum: Vec<u16> = px.iter().map(|&c| luma(c)).collect();
    let mut mag = vec![0u32; w * h];
    let mut sum = 0u64;
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = y * w + x;
            let gx = lum[i - w + 1] as i32 + 2 * lum[i + 1] as i32 + lum[i + w + 1] as i32
                - lum[i - w - 1] as i32
                - 2 * lum[i - 1] as i32
                - lum[i + w - 1] as i32;
            let gy = lum[i + w - 1] as i32 + 2 * lum[i + w] as i32 + lum[i + w + 1] as i32
                - lum[i - w - 1] as i32
                - 2 * lum[i - w] as i32
                - lum[i - w + 1] as i32;
            let m = (gx * gx + gy * gy) as u32;
            mag[i] = m;
            sum += m as u64;
        }
    }
    let n = ((w.saturating_sub(2)) * (h.saturating_sub(2))).max(1) as u64;
    let mean = sum / n;
    let mut var = 0u64;
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let d = mag[y * w + x] as i64 - mean as i64;
            var += (d * d) as u64;
        }
    }
    let std = ((var / n) as f64).sqrt() as u64;
    let thresh = mean + std / 2;
    mag.iter().map(|&m| (m as u64) > thresh).collect()
}

/// 3x3 膨胀（边缘 IoU 给 1px 对齐鲁棒性——矢量化边缘常有亚像素偏移）
fn dilate(mask: &[bool], w: usize, h: usize) -> Vec<bool> {
    let mut out = mask.to_vec();
    for y in 0..h {
        for x in 0..w {
            if !mask[y * w + x] {
                continue;
            }
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                        out[ny as usize * w + nx as usize] = true;
                    }
                }
            }
        }
    }
    out
}

/// 给候选打分：与源图（白底合成、同尺寸）比 RMSE + 边缘 IoU，复杂度按预算折算。
/// total = (1−cb)×[0.55×(1−RMSE) + 0.45×IoU] + cb×预算余量 − 0.3×超预算部分
/// `complexity_bias`：少节点档给 0.5（复杂度与质量并重，否则简化候选赢不了），其余档 0.1。
pub fn score_candidate(
    svg: &str,
    src: &RgbaImage,
    anchor_budget: usize,
    complexity_bias: f64,
) -> SResult<Score> {
    let anchors = count_anchors(svg);
    let rendered = render_svg(svg, SCORE_SIDE)?;
    let (w, h) = (rendered.width(), rendered.height());
    let src_thumb = imageops::resize(src, w, h, imageops::FilterType::Triangle);
    let a = flatten_over_white(&rendered);
    let b = flatten_over_white(&src_thumb);
    // 颜色 RMSE（0..1）
    let mut se = 0f64;
    for (pa, pb) in a.iter().zip(b.iter()) {
        let dr = pa.0 as f64 - pb.0 as f64;
        let dg = pa.1 as f64 - pb.1 as f64;
        let db = pa.2 as f64 - pb.2 as f64;
        se += (dr * dr + dg * dg + db * db) / 3.0;
    }
    let rmse = (se / (a.len().max(1) as f64)).sqrt() / 255.0;
    // 边缘 IoU（双方各膨胀 1px 容差——矢量化/resvg 抗锯齿边缘常有亚像素偏移）
    let (wus, hus) = (w as usize, h as usize);
    let ea = dilate(&edge_map(&a, wus, hus), wus, hus);
    let eb = dilate(&edge_map(&b, wus, hus), wus, hus);
    let (mut inter, mut union) = (0u64, 0u64);
    for i in 0..(wus * hus) {
        let (x, y) = (ea[i], eb[i]);
        if x && y {
            inter += 1;
        }
        if x || y {
            union += 1;
        }
    }
    let iou = if union == 0 {
        1.0
    } else {
        inter as f64 / union as f64
    };
    // 透明 Logo/贴纸的外轮廓是生产交付的一部分，不能被白底合成掩盖。
    let src_has_alpha = src_thumb.pixels().any(|p| p.0[3] < 250);
    let alpha_iou = if src_has_alpha {
        let mut inter = 0u64;
        let mut union = 0u64;
        for (pa, pb) in rendered.pixels().zip(src_thumb.pixels()) {
            let aa = pa.0[3] > 16;
            let ab = pb.0[3] > 16;
            if aa && ab {
                inter += 1;
            }
            if aa || ab {
                union += 1;
            }
        }
        if union == 0 {
            1.0
        } else {
            inter as f64 / union as f64
        }
    } else {
        1.0
    };
    let budget = anchor_budget.max(1) as f64;
    let ratio = anchors as f64 / budget;
    let cb = complexity_bias.clamp(0.0, 1.0);
    let quality = if src_has_alpha {
        0.45 * (1.0 - rmse.min(1.0)) + 0.40 * iou + 0.15 * alpha_iou
    } else {
        0.55 * (1.0 - rmse.min(1.0)) + 0.45 * iou
    };
    let total = (1.0 - cb) * quality + cb * (1.0 - ratio.min(1.0)) - 0.3 * (ratio - 1.0).max(0.0);
    Ok(Score {
        total,
        rmse,
        edge_iou: iou,
        alpha_iou,
        anchors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    /// 三色块 + 圆的合成 Logo（与 vec.rs 单测同款）
    pub fn synth_logo_img(w: u32, h: u32) -> RgbaImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let dx = x as i32 - (w / 2) as i32;
            let dy = y as i32 - (h / 2) as i32;
            if dx * dx + dy * dy < (h as i32 / 3) * (h as i32 / 3) {
                Rgba([220, 30, 30, 255])
            } else if x < w / 2 {
                Rgba([30, 120, 220, 255])
            } else {
                Rgba([240, 220, 40, 255])
            }
        })
    }

    #[test]
    fn identical_svg_scores_near_one() {
        // 用真 SVG 手画同一张 Logo：渲染==源图（近似），RMSE≈0、IoU 高 → 总分应接近 1
        let src = synth_logo_img(240, 240);
        let svg = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"240\">\
             <rect x=\"0\" y=\"0\" width=\"120\" height=\"240\" fill=\"#1e78dc\"/>\
             <rect x=\"120\" y=\"0\" width=\"120\" height=\"240\" fill=\"#f0dc28\"/>\
             <circle cx=\"120\" cy=\"120\" r=\"80\" fill=\"#dc1e1e\"/></svg>"
        );
        let s = score_candidate(&svg, &src, 25000, 0.1).expect("评分应成功");
        assert!(s.rmse < 0.05, "颜色应几乎一致，RMSE={}", s.rmse);
        assert!(s.edge_iou > 0.6, "边缘应高度重合，IoU={}", s.edge_iou);
        assert!(
            (s.alpha_iou - 1.0).abs() < 1e-9,
            "不透明源图 alpha 门禁应为 1"
        );
        assert!(s.total > 0.8, "相同图总分应 ≈1，得 {}", s.total);
        eprintln!(
            "相同 SVG 评分：total={} rmse={} iou={} anchors={}",
            s.total, s.rmse, s.edge_iou, s.anchors
        );
    }

    #[test]
    fn wrong_color_scores_worse() {
        let src = synth_logo_img(240, 240);
        let good = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"240\">\
             <rect x=\"0\" y=\"0\" width=\"120\" height=\"240\" fill=\"#1e78dc\"/>\
             <rect x=\"120\" y=\"0\" width=\"120\" height=\"240\" fill=\"#f0dc28\"/>\
             <circle cx=\"120\" cy=\"120\" r=\"80\" fill=\"#dc1e1e\"/></svg>";
        let bad = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"240\">\
             <rect x=\"0\" y=\"0\" width=\"240\" height=\"240\" fill=\"#202020\"/></svg>";
        let sg = score_candidate(good, &src, 25000, 0.1).unwrap();
        let sb = score_candidate(bad, &src, 25000, 0.1).unwrap();
        assert!(
            sg.total > sb.total + 0.2,
            "好候选应显著优于坏候选：{} vs {}",
            sg.total,
            sb.total
        );
    }

    #[test]
    fn anchor_count_only_reads_d_attrs() {
        // hex 颜色里的 a-f 字母不得计入锚点
        let svg =
            "<svg><rect fill=\"#abcdef\"/><path d=\"M0 0 L10 10 C20 20 30 30 40 40 Z\"/></svg>";
        assert_eq!(count_anchors(svg), 4, "M/L/C/Z 共 4 个命令字母");
    }

    #[test]
    fn over_budget_penalized() {
        let src = synth_logo_img(120, 120);
        // 必须带 path 才有锚点（rect/circle 图元不计 d 命令）
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"120\" height=\"120\">\
             <path d=\"M0 0 L120 0 L120 120 L0 120 Z\" fill=\"#1e78dc\"/></svg>";
        let rich = score_candidate(svg, &src, 25000, 0.1).unwrap();
        let poor = score_candidate(svg, &src, 1, 0.1).unwrap(); // 预算 1 → 4 锚点必超
        assert!(
            poor.total < rich.total,
            "超预算应扣分：{} vs {}",
            poor.total,
            rich.total
        );
    }

    #[test]
    fn transparent_outline_is_scored_separately() {
        let src: RgbaImage = ImageBuffer::from_fn(100, 100, |x, y| {
            if (20..80).contains(&x) && (20..80).contains(&y) {
                Rgba([220, 40, 40, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        });
        let good = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><rect x=\"20\" y=\"20\" width=\"60\" height=\"60\" fill=\"#dc2828\"/></svg>";
        let bad = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\"><rect width=\"100\" height=\"100\" fill=\"#dc2828\"/></svg>";
        let sg = score_candidate(good, &src, 1000, 0.1).unwrap();
        let sb = score_candidate(bad, &src, 1000, 0.1).unwrap();
        assert!(
            sg.alpha_iou > 0.95,
            "正确透明轮廓应通过，得 {}",
            sg.alpha_iou
        );
        assert!(
            sb.alpha_iou < 0.5,
            "铺满画布不应被白底合成掩盖，得 {}",
            sb.alpha_iou
        );
    }
}
