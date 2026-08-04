//! 几何图元识别（文档 §10.3/§14）：在扁平色块里检测填充圆/矩形/椭圆/圆角矩形，
//! 矢量化时拟合为真图元 `<circle>`/`<rect>`/`<ellipse>`，而非高节点锯齿 path。
//! 纯 Rust（量化色 + 4 邻 BFS 连通域 + 填充率/圆度/角部曲率抽样判定），无外部 CV 依赖。
use image::RgbaImage;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum Shape {
    #[serde(rename = "circle")]
    Circle {
        cx: f64,
        cy: f64,
        r: f64,
        fill: String,
    },
    #[serde(rename = "rect")]
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: String,
    },
    #[serde(rename = "ellipse")]
    Ellipse {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
        fill: String,
    },
    #[serde(rename = "rounded-rect")]
    RoundedRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        rx: f64,
        fill: String,
    },
}

/// 检测显著的填充圆/矩形（打卡框边条、文化墙色块/圆盘、Logo 形）。在 ≤256 缩略图上做，结果映射回原图坐标。
pub fn detect_shapes(rgba: &RgbaImage) -> Vec<Shape> {
    let (w0, h0) = (rgba.width(), rgba.height());
    let longest = w0.max(h0).max(1);
    let scale = if longest > 256 {
        256.0 / longest as f32
    } else {
        1.0
    };
    let (tw, th) = (
        ((w0 as f32 * scale).round() as u32).max(1),
        ((h0 as f32 * scale).round() as u32).max(1),
    );
    let thumb = if scale < 1.0 {
        image::imageops::resize(rgba, tw, th, image::imageops::FilterType::Nearest)
    } else {
        rgba.clone()
    };
    // 量化颜色（每通道高 4 位 → 4096 色），同色相邻归一组
    let mut quant = Vec::with_capacity((tw * th) as usize);
    for y in 0..th {
        for x in 0..tw {
            let p = thumb.get_pixel(x, y);
            quant.push(
                ((p.0[0] as u32 >> 4) << 8) | ((p.0[1] as u32 >> 4) << 4) | (p.0[2] as u32 >> 4),
            );
        }
    }
    let mut visited = vec![false; (tw * th) as usize];
    let min_area = ((tw * th) as f32 * 0.03) as u32; // ≥3% 画面才算
    let inv = 1.0 / scale;
    let mut shapes = Vec::new();

    for sy in 0..th {
        for sx in 0..tw {
            let i0 = (sy * tw + sx) as usize;
            if visited[i0] {
                continue;
            }
            let c0 = quant[i0];
            let mut stack: Vec<(u32, u32)> = vec![(sx, sy)];
            visited[i0] = true;
            let mut x0 = sx;
            let mut x1 = sx;
            let mut y0 = sy;
            let mut y1 = sy;
            let mut area = 0u32;
            let mut sumx = 0u64;
            let mut sumy = 0u64;
            let mut fr = 0u32;
            let mut fg = 0u32;
            let mut fb = 0u32;
            while let Some((x, y)) = stack.pop() {
                area += 1;
                sumx += x as u64;
                sumy += y as u64;
                let p = thumb.get_pixel(x, y);
                fr += p.0[0] as u32;
                fg += p.0[1] as u32;
                fb += p.0[2] as u32;
                if x < x0 {
                    x0 = x;
                }
                if x > x1 {
                    x1 = x;
                }
                if y < y0 {
                    y0 = y;
                }
                if y > y1 {
                    y1 = y;
                }
                let neighbors = [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ];
                for (nx, ny) in neighbors {
                    if nx >= tw || ny >= th {
                        continue;
                    }
                    let ni = (ny * tw + nx) as usize;
                    if !visited[ni] && quant[ni] == c0 {
                        visited[ni] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            if area < min_area {
                continue;
            }
            // 跳过贴边的连通域（白底/透明底通常铺满画布到边，是背景，不该当形状——否则带洞的背景会被误判成大圆）
            if x0 == 0 || y0 == 0 || x1 + 1 == tw || y1 + 1 == th {
                continue;
            }
            let bw = (x1 - x0 + 1) as f32;
            let bh = (y1 - y0 + 1) as f32;
            let bbox_area = bw * bh;
            let fill_rate = area as f32 / bbox_area;
            let cx = sumx as f32 / area as f32;
            let cy = sumy as f32 / area as f32;
            let fr8 = (fr / area) as u8;
            let fg8 = (fg / area) as u8;
            let fb8 = (fb / area) as u8;
            let fill = format!("#{:02x}{:02x}{:02x}", fr8, fg8, fb8);

            // 圆角矩形判定（0.80–0.92 填充带）：角半径估计 + 角部曲率抽样，Some(rx) 即成立
            let rr = if (0.80..=0.92).contains(&fill_rate) {
                is_rounded_rect(&quant, tw, c0, x0, y0, x1, y1, fill_rate)
            } else {
                None
            };
            if fill_rate > 0.92 {
                // 填充率极高 → 矩形（含细条=边框条；打卡框四条边各自是一个矩形）
                if bw.max(bh) >= 3.0 {
                    shapes.push(Shape::Rect {
                        x: ((x0 as f32) * inv) as f64,
                        y: ((y0 as f32) * inv) as f64,
                        w: (bw * inv) as f64,
                        h: (bh * inv) as f64,
                        fill,
                    });
                }
            } else if let Some(rx) = rr {
                shapes.push(Shape::RoundedRect {
                    x: ((x0 as f32) * inv) as f64,
                    y: ((y0 as f32) * inv) as f64,
                    w: (bw * inv) as f64,
                    h: (bh * inv) as f64,
                    rx: (rx * inv) as f64,
                    fill,
                });
            } else {
                // 圆度判定：接近正方形 + 面积接近 πr² + 圆心近 bbox 中心
                let ratio = bw.max(bh) / bw.min(bh).max(1.0);
                let bcx = x0 as f32 + bw / 2.0;
                let bcy = y0 as f32 + bh / 2.0;
                let center_off = ((cx - bcx).abs() + (cy - bcy).abs()) / bw.max(bh);
                if ratio < 1.3 {
                    let r = bw.min(bh) / 2.0;
                    let circle_area = std::f32::consts::PI * r * r;
                    let area_err = (area as f32 - circle_area).abs() / circle_area.max(1.0);
                    // 真圆盘 fill_rate≈π/4≈0.785；星爆/尖刺低于此 → 不误判为大圆（否则会把整块黄当成圆盖住尖刺）
                    if area_err < 0.20 && center_off < 0.15 && fill_rate > 0.68 && fill_rate < 0.86
                    {
                        shapes.push(Shape::Circle {
                            cx: (bcx * inv) as f64,
                            cy: (bcy * inv) as f64,
                            r: (r * inv) as f64,
                            fill,
                        });
                    }
                } else if ratio < 2.6 {
                    // 椭圆（批次5）：bbox 内接椭圆面积同为 π·a·b（fill≈π/4），轴比放宽到 2.6
                    let a = bw / 2.0;
                    let b = bh / 2.0;
                    let ell_area = std::f32::consts::PI * a * b;
                    let area_err = (area as f32 - ell_area).abs() / ell_area.max(1.0);
                    if area_err < 0.22 && center_off < 0.18 && fill_rate > 0.66 && fill_rate < 0.88
                    {
                        shapes.push(Shape::Ellipse {
                            cx: (bcx * inv) as f64,
                            cy: (bcy * inv) as f64,
                            rx: (a * inv) as f64,
                            ry: (b * inv) as f64,
                            fill,
                        });
                    }
                }
            }
        }
    }
    // 去掉明显被更大形状包住的（粗略：按面积降序保留前 32 个）
    shapes.truncate(64);
    shapes
}

/// 圆角矩形判定：四角在形外 + 估计角半径不太大 + 四边留有直线段，成立则返回角半径（缩略图坐标）。
/// - 角半径估计 r_est = √((1−fill)·w·h/(4−π))：圆/椭圆的 r_est ≈ 短边一半（>45%），据此排除；
/// - 直线段：bbox 顶/底/左/右各边在形内像素数 ≥ 边长/5（圆/椭圆顶行只剩弧顶一小段）。
fn is_rounded_rect(
    quant: &[u32],
    tw: u32,
    c0: u32,
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    fill_rate: f32,
) -> Option<f32> {
    let at = |x: u32, y: u32| -> bool { quant[(y * tw + x) as usize] == c0 };
    // 四角必须在形外（被圆角削掉）
    if at(x0, y0) || at(x1, y0) || at(x0, y1) || at(x1, y1) {
        return None;
    }
    let bw = (x1 - x0 + 1) as f32;
    let bh = (y1 - y0 + 1) as f32;
    let r_est = ((1.0 - fill_rate) * bw * bh / (4.0 - std::f32::consts::PI)).sqrt();
    if r_est < 2.0 || r_est > bw.min(bh) * 0.45 {
        return None; // 太小→按矩形走；太大→圆/椭圆域
    }
    let row_run = |y: u32| -> u32 { (x0..=x1).filter(|&x| at(x, y)).count() as u32 };
    let col_run = |x: u32| -> u32 { (y0..=y1).filter(|&y| at(x, y)).count() as u32 };
    let min_h = ((bw / 5.0) as u32).max(3);
    let min_v = ((bh / 5.0) as u32).max(3);
    if row_run(y0) >= min_h && row_run(y1) >= min_h && col_run(x0) >= min_v && col_run(x1) >= min_v
    {
        Some(r_est)
    } else {
        None
    }
}

/// 把检测到的形状渲染成 SVG 片段（叠在 VTracer 结果之上，作为干净图元层）
pub fn shapes_to_svg(shapes: &[Shape]) -> String {
    let mut s = String::new();
    for sh in shapes {
        match sh {
            Shape::Circle { cx, cy, r, fill } => {
                s.push_str(&format!(
                    "<circle cx=\"{:.1}\" cy=\"{:.1}\" r=\"{:.1}\" fill=\"{}\"/>\n",
                    cx, cy, r, fill
                ));
            }
            Shape::Rect { x, y, w, h, fill } => {
                s.push_str(&format!("<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" fill=\"{}\"/>\n", x, y, w, h, fill));
            }
            Shape::Ellipse {
                cx,
                cy,
                rx,
                ry,
                fill,
            } => {
                s.push_str(&format!(
                    "<ellipse cx=\"{:.1}\" cy=\"{:.1}\" rx=\"{:.1}\" ry=\"{:.1}\" fill=\"{}\"/>\n",
                    cx, cy, rx, ry, fill
                ));
            }
            Shape::RoundedRect {
                x,
                y,
                w,
                h,
                rx,
                fill,
            } => {
                s.push_str(&format!("<rect x=\"{:.1}\" y=\"{:.1}\" width=\"{:.1}\" height=\"{:.1}\" rx=\"{:.1}\" fill=\"{}\"/>\n", x, y, w, h, rx, fill));
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn blank(w: u32, h: u32, bg: [u8; 4]) -> RgbaImage {
        ImageBuffer::from_fn(w, h, |_, _| Rgba(bg))
    }

    #[test]
    fn detects_filled_circle() {
        let mut img = blank(128, 128, [255, 255, 255, 255]);
        // 中心红圆
        for y in 0..128 {
            for x in 0..128 {
                if ((x as i32 - 64).pow(2) + (y as i32 - 64).pow(2)) < 40 * 40 {
                    img.put_pixel(x, y, Rgba([220, 30, 30, 255]));
                }
            }
        }
        let shapes = detect_shapes(&img);
        assert!(
            shapes.iter().any(|s| matches!(s, Shape::Circle { .. })),
            "应检测到圆，得 {:?}",
            shapes
        );
    }

    #[test]
    fn rejects_low_fill_as_circle() {
        // 菱形 fill_rate≈0.5（真圆盘≈0.785）—— 不应被误判为圆（爆炸贴星爆同此理）
        let mut img = blank(128, 128, [255, 255, 255, 255]);
        for y in 0..128 {
            for x in 0..128 {
                let dx = (x as i32 - 64).abs();
                let dy = (y as i32 - 64).abs();
                if dx + dy < 50 {
                    img.put_pixel(x, y, Rgba([30, 90, 200, 255]));
                }
            }
        }
        let shapes = detect_shapes(&img);
        assert!(
            !shapes.iter().any(|s| matches!(s, Shape::Circle { .. })),
            "菱形不应判为圆：{:?}",
            shapes
        );
    }

    #[test]
    fn detects_filled_rect() {
        let mut img = blank(128, 128, [255, 255, 255, 255]);
        for y in 30..100 {
            for x in 20..108 {
                img.put_pixel(x, y, Rgba([30, 90, 200, 255]));
            }
        }
        let shapes = detect_shapes(&img);
        assert!(
            shapes.iter().any(|s| matches!(s, Shape::Rect { .. })),
            "应检测到矩形，得 {:?}",
            shapes
        );
    }

    #[test]
    fn detects_ellipse() {
        // 宽椭圆 rx=45 ry=25（轴比 1.8，超出圆的 1.3 上限）
        let mut img = blank(128, 128, [255, 255, 255, 255]);
        for y in 0..128i32 {
            for x in 0..128i32 {
                let dx = (x - 64) as f32 / 45.0;
                let dy = (y - 64) as f32 / 25.0;
                if dx * dx + dy * dy < 1.0 {
                    img.put_pixel(x as u32, y as u32, Rgba([40, 160, 90, 255]));
                }
            }
        }
        let shapes = detect_shapes(&img);
        assert!(
            shapes.iter().any(|s| matches!(s, Shape::Ellipse { .. })),
            "应检测到椭圆，得 {:?}",
            shapes
        );
        assert!(
            !shapes.iter().any(|s| matches!(s, Shape::Circle { .. })),
            "宽椭圆不应判为圆：{:?}",
            shapes
        );
    }

    #[test]
    fn detects_rounded_rect() {
        // 圆角矩形 24..104 × 34..94，角半径 24（fill≈0.897 落在 0.80–0.92 带；顶边直线段 32px 足够长）
        let mut img = blank(128, 128, [255, 255, 255, 255]);
        let (x0, y0, x1, y1, r) = (24i32, 34i32, 104i32, 94i32, 24i32);
        for y in y0..y1 {
            for x in x0..x1 {
                // 角部：距最近内角点超过 r 的出形
                let ix = x.clamp(x0 + r, x1 - r);
                let iy = y.clamp(y0 + r, y1 - r);
                let dx = x - ix;
                let dy = y - iy;
                if dx * dx + dy * dy <= r * r {
                    img.put_pixel(x as u32, y as u32, Rgba([200, 80, 160, 255]));
                }
            }
        }
        let shapes = detect_shapes(&img);
        assert!(
            shapes
                .iter()
                .any(|s| matches!(s, Shape::RoundedRect { .. })),
            "应检测到圆角矩形，得 {:?}",
            shapes
        );
        assert!(
            !shapes.iter().any(|s| matches!(s, Shape::Circle { .. })),
            "圆角矩形不应判为圆：{:?}",
            shapes
        );
    }

    #[test]
    fn circle_not_misclassified_as_rounded_rect() {
        // 回归：真圆的四边 1/3 采样出界，不得误判为圆角矩形
        let mut img = blank(128, 128, [255, 255, 255, 255]);
        for y in 0..128 {
            for x in 0..128 {
                if ((x as i32 - 64).pow(2) + (y as i32 - 64).pow(2)) < 40 * 40 {
                    img.put_pixel(x, y, Rgba([220, 30, 30, 255]));
                }
            }
        }
        let shapes = detect_shapes(&img);
        assert!(
            shapes.iter().any(|s| matches!(s, Shape::Circle { .. })),
            "应检测到圆"
        );
        assert!(
            !shapes
                .iter()
                .any(|s| matches!(s, Shape::RoundedRect { .. })),
            "真圆不应判为圆角矩形：{:?}",
            shapes
        );
    }
}
