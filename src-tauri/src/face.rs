//! 人脸检测（SCRFD）与人脸 ROI 工具 —— 人像档专用（文档 §11）。
//!
//! - SCRFD 2.5G：640² 输入，3 个 stride（8/16/32）输出 score/bbox(/kps)，anchor-free points 解码 + NMS。
//! - 输出张量不按名称而按形状分类（末维 1=score / 4=bbox / 10=kps；N=12800/3200/800 → stride 8/16/32），
//!   兼容不同导出的排序差异。
//! - 纯解码逻辑与 ort 解耦（`decode_raw` 直接吃 Vec<f32>），便于合成张量单测。
use image::{imageops, RgbaImage};
use ndarray::{Array2, Array3, Array4};
use ort::{session::Session, value::TensorRef};

/// 人脸框（原图像素坐标）
#[derive(Debug, Clone, Copy)]
pub struct FaceBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub score: f32,
}

impl FaceBox {
    pub fn w(&self) -> f32 {
        (self.x2 - self.x1).max(0.0)
    }
    pub fn h(&self) -> f32 {
        (self.y2 - self.y1).max(0.0)
    }
}

/// SCRFD 输入边长 / 每格点数（2.5G：num_anchors=2）
const IN: u32 = 640;
const NUM_ANCHORS: usize = 2;
/// 检出阈值：与 InsightFace 一致直接卡在**原始 logit** 0.5 上（不做 sigmoid——sigmoid(0)=0.5 会让
/// 零分背景恰好过线，异常输入下瞬间爆出上万个假脸）
const SCORE_THRESH: f32 = 0.5;
const NMS_IOU: f32 = 0.4;
/// 单张图人脸数硬上限：OOD 输入（非照片）可能骗过检测器，限流保护后续 ROI 循环
const MAX_FACES: usize = 64;

/// 跑 SCRFD：letterbox 640 → 推理 → 解码 + NMS → 原图坐标人脸框（按分数截断到 MAX_FACES）
pub fn detect_faces(session: &mut Session, img: &RgbaImage) -> Result<Vec<FaceBox>, String> {
    let (tensor, scale, pad_x, pad_y) = letterbox(img);
    let in_name = session.inputs()[0].name().to_string();
    let outputs = session
        .run(ort::inputs![in_name => TensorRef::from_array_view(&tensor).map_err(|e| e.to_string())?])
        .map_err(|e| format!("SCRFD 推理失败：{}", e))?;
    // 按形状分类输出张量（兼容 6/9 输出与排序差异）
    let mut parts: Vec<(Vec<usize>, Vec<f32>)> = Vec::new();
    for (_, v) in outputs.iter() {
        let arr = v.try_extract_array::<f32>().map_err(|e| e.to_string())?;
        let shape: Vec<usize> = arr.shape().to_vec();
        let flat: Vec<f32> = arr.iter().cloned().collect();
        parts.push((shape, flat));
    }
    let mut faces = decode_raw(&parts, SCORE_THRESH)?;
    // 640 letterbox 坐标 → 原图坐标
    for f in &mut faces {
        f.x1 = ((f.x1 - pad_x) / scale).clamp(0.0, img.width() as f32);
        f.y1 = ((f.y1 - pad_y) / scale).clamp(0.0, img.height() as f32);
        f.x2 = ((f.x2 - pad_x) / scale).clamp(0.0, img.width() as f32);
        f.y2 = ((f.y2 - pad_y) / scale).clamp(0.0, img.height() as f32);
    }
    let mut kept = nms(faces, NMS_IOU);
    kept.truncate(MAX_FACES);
    Ok(kept)
}

/// letterbox 到 640²（保比例，114 灰填充），返回 (NCHW 张量 0..1, scale, pad_x, pad_y)
fn letterbox(img: &RgbaImage) -> (Array4<f32>, f32, f32, f32) {
    let (w, h) = (img.width(), img.height());
    let scale = (IN as f32 / w.max(h) as f32).min(1.0);
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    let resized = imageops::resize(img, nw, nh, imageops::FilterType::Triangle);
    let pad_x = (IN - nw) as f32 / 2.0;
    let pad_y = (IN - nh) as f32 / 2.0;
    let mut t: Array4<f32> = Array4::from_elem((1, 3, IN as usize, IN as usize), 114.0 / 255.0);
    for y in 0..nh {
        for x in 0..nw {
            let p = resized.get_pixel(x, y);
            let tx = (x as f32 + pad_x) as usize;
            let ty = (y as f32 + pad_y) as usize;
            for c in 0..3 {
                t[[0, c, ty, tx]] = p.0[c] as f32 / 255.0;
            }
        }
    }
    (t, scale, pad_x, pad_y)
}

/// 纯解码（单测友好）：把 SCRFD 输出张量集解码为 640 坐标系人脸框（未 NMS、未还原）。
/// `parts` = [(shape, flat)]；末维 1→score（原始 logit，不过 sigmoid）、4→bbox（距离 l,t,r,b）、10→kps（忽略）。
fn decode_raw(parts: &[(Vec<usize>, Vec<f32>)], thresh: f32) -> Result<Vec<FaceBox>, String> {
    // stride → (scores, bboxes)
    let mut by_stride: std::collections::HashMap<u32, (Option<&Vec<f32>>, Option<&Vec<f32>>)> =
        std::collections::HashMap::new();
    for (shape, flat) in parts {
        if shape.len() < 2 {
            continue;
        }
        let n = shape[shape.len() - 2];
        let d = shape[shape.len() - 1];
        let stride = match n {
            12800 => 8,
            3200 => 16,
            800 => 32,
            _ => continue,
        };
        let entry = by_stride.entry(stride).or_insert((None, None));
        match d {
            1 => entry.0 = Some(flat),
            4 => entry.1 = Some(flat),
            _ => {} // kps(10)：v1 不用关键点，框足够路由
        }
    }
    if by_stride.is_empty() {
        return Err("SCRFD 输出形状无法识别（未找到 12800/3200/800 锚点层）".into());
    }
    let mut out = Vec::new();
    for (stride, (scores, bboxes)) in &by_stride {
        let (Some(sc), Some(bb)) = (scores, bboxes) else {
            continue;
        };
        let fw = (IN / stride) as usize; // 特征图边长
        for i in 0..sc.len() {
            let s = sc[i]; // 原始 logit 阈值（对齐 InsightFace det_thresh）
            if s < thresh {
                continue;
            }
            let cell = i / NUM_ANCHORS;
            let gx = (cell % fw) as f32;
            let gy = (cell / fw) as f32;
            let cx = gx * *stride as f32;
            let cy = gy * *stride as f32;
            let l = bb[i * 4] * *stride as f32;
            let t = bb[i * 4 + 1] * *stride as f32;
            let r = bb[i * 4 + 2] * *stride as f32;
            let b = bb[i * 4 + 3] * *stride as f32;
            out.push(FaceBox {
                x1: cx - l,
                y1: cy - t,
                x2: cx + r,
                y2: cy + b,
                score: s,
            });
        }
    }
    Ok(out)
}

fn iou(a: &FaceBox, b: &FaceBox) -> f32 {
    let ix1 = a.x1.max(b.x1);
    let iy1 = a.y1.max(b.y1);
    let ix2 = a.x2.min(b.x2);
    let iy2 = a.y2.min(b.y2);
    let iw = (ix2 - ix1).max(0.0);
    let ih = (iy2 - iy1).max(0.0);
    let inter = iw * ih;
    let union = a.w() * a.h() + b.w() * b.h() - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn nms(mut boxes: Vec<FaceBox>, iou_thresh: f32) -> Vec<FaceBox> {
    boxes.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut keep: Vec<FaceBox> = Vec::new();
    for b in boxes {
        if keep.iter().all(|k| iou(k, &b) < iou_thresh) {
            keep.push(b);
        }
    }
    keep
}

/// 扩大人脸框（context 倍，正方形化可选），边界裁剪到 (w,h)
pub fn expand_box(f: &FaceBox, ctx: f32, w: u32, h: u32) -> (u32, u32, u32, u32) {
    let cx = (f.x1 + f.x2) / 2.0;
    let cy = (f.y1 + f.y2) / 2.0;
    let half = (f.w().max(f.h()) * ctx / 2.0).max(8.0);
    let x1 = (cx - half).max(0.0) as u32;
    let y1 = (cy - half).max(0.0) as u32;
    let x2 = ((cx + half).min(w as f32) as u32).max(x1 + 1);
    let y2 = ((cy + half).min(h as f32) as u32).max(y1 + 1);
    (x1, y1, x2, y2)
}

/// 椭圆人脸掩膜（输出空间）：框内椭圆=1，外部=0，edge 像素线性羽化。人像档皮肤降权用。
pub fn face_mask(w: u32, h: u32, faces: &[FaceBox], edge: u32) -> Array2<f32> {
    let mut m: Array2<f32> = Array2::zeros((h as usize, w as usize));
    for f in faces {
        let cx = (f.x1 + f.x2) / 2.0;
        let cy = (f.y1 + f.y2) / 2.0;
        let rx = (f.w() * 0.62).max(1.0); // 椭圆略大于检测框，覆盖全脸与发际
        let ry = (f.h() * 0.72).max(1.0);
        let x1 = (cx - rx - edge as f32).max(0.0) as u32;
        let y1 = (cy - ry - edge as f32).max(0.0) as u32;
        let x2 = ((cx + rx + edge as f32).min(w as f32)) as u32;
        let y2 = ((cy + ry + edge as f32).min(h as f32)) as u32;
        for y in y1..y2 {
            for x in x1..x2 {
                let dx = (x as f32 - cx) / rx;
                let dy = (y as f32 - cy) / ry;
                let d = (dx * dx + dy * dy).sqrt(); // 到椭圆边界的归一化距离
                let v = if d <= 1.0 {
                    1.0
                } else if edge > 0 && d <= 1.0 + edge as f32 / rx.max(ry) {
                    // 羽化带：随距离线性衰减
                    1.0 - (d - 1.0) / (edge as f32 / rx.max(ry))
                } else {
                    0.0
                };
                let cur = m[(y as usize, x as usize)];
                if v > cur {
                    m[(y as usize, x as usize)] = v;
                }
            }
        }
    }
    m
}

/// 把 src（与 dst 同色彩约定 0..1 f32）羽化贴回 dst 的 (ox,oy) 处，feather 为边缘羽化像素
pub fn paste_feathered(dst: &mut Array3<f32>, src: &Array3<f32>, ox: u32, oy: u32, feather: u32) {
    let (sh, sw, _) = src.dim();
    let (dh, dw, _) = dst.dim();
    for y in 0..sh {
        let gy = oy as usize + y;
        if gy >= dh {
            break;
        }
        for x in 0..sw {
            let gx = ox as usize + x;
            if gx >= dw {
                break;
            }
            // 到四边的最小距离 → 羽化权重
            let dl = x.min(y).min(sw - 1 - x).min(sh - 1 - y) as f32;
            let wgt = if feather == 0 {
                1.0
            } else {
                (dl / feather as f32).min(1.0)
            };
            for c in 0..3 {
                let s = src[(y, x, c)].clamp(0.0, 1.0);
                dst[(gy, gx, c)] = dst[(gy, gx, c)] * (1.0 - wgt) + s * wgt;
            }
        }
    }
}

/// f32 RGB(0..1) ↔ RgbaImage（人脸 ROI 裁剪/贴回用；丢 alpha 无所谓，人脸区不透明）
pub fn rgba_to_array3(img: &RgbaImage) -> Array3<f32> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut a = Array3::zeros((h, w, 3));
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                a[(y, x, c)] = p.0[c] as f32 / 255.0;
            }
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个 stride=8 层的合成输出：在 (gx,gy) 格点放一张 96px 脸
    fn synthetic_scrfd(gx: usize, gy: usize, dists: [f32; 4]) -> Vec<(Vec<usize>, Vec<f32>)> {
        let n = 12800usize;
        let mut sc = vec![-100f32; n]; // sigmoid≈0
        let mut bb = vec![0f32; n * 4];
        let cell = gy * 80 + gx;
        let idx = cell * NUM_ANCHORS; // 第一个 anchor
        sc[idx] = 100.0; // sigmoid≈1
        for k in 0..4 {
            bb[idx * 4 + k] = dists[k];
        }
        vec![(vec![1, n, 1], sc), (vec![1, n, 4], bb)]
    }

    #[test]
    fn decode_synthetic_face() {
        // stride 8，格点 (20,30)，距离各 12（→ 96px 框，中心 (160,240)）
        let parts = synthetic_scrfd(20, 30, [12.0, 12.0, 12.0, 12.0]);
        let faces = decode_raw(&parts, 0.5).unwrap();
        assert_eq!(faces.len(), 1);
        let f = faces[0];
        assert!(
            (f.x1 - 64.0).abs() < 1.0 && (f.y1 - 144.0).abs() < 1.0,
            "框左上应为 (64,144)，得 ({},{})",
            f.x1,
            f.y1
        );
        assert!((f.x2 - 256.0).abs() < 1.0 && (f.y2 - 336.0).abs() < 1.0);
    }

    #[test]
    fn decode_rejects_zero_logit_background() {
        // 回归：score=0 的背景点不得过线（曾用 sigmoid 解码，sigmoid(0)=0.5 恰好过阈值 → 万级假脸）
        let mut parts = synthetic_scrfd(20, 30, [12.0, 12.0, 12.0, 12.0]);
        parts[0].1[5] = 0.0; // 另一个格点的 anchor 给 0 分
        parts[0].1[7] = 0.49; // 0.49 也不过
        let faces = decode_raw(&parts, 0.5).unwrap();
        assert_eq!(
            faces.len(),
            1,
            "只有 100 分锚点应过线，得 {} 个",
            faces.len()
        );
    }

    #[test]
    fn decode_unknown_shape_errors() {
        let parts: Vec<(Vec<usize>, Vec<f32>)> = vec![(vec![1, 999, 1], vec![0.0; 999])];
        assert!(
            decode_raw(&parts, 0.5).is_err(),
            "无法识别的输出应报错（上层降级）"
        );
    }

    #[test]
    fn nms_dedupes_overlap() {
        let a = FaceBox {
            x1: 0.0,
            y1: 0.0,
            x2: 100.0,
            y2: 100.0,
            score: 0.9,
        };
        let b = FaceBox {
            x1: 10.0,
            y1: 10.0,
            x2: 110.0,
            y2: 110.0,
            score: 0.8,
        };
        let c = FaceBox {
            x1: 300.0,
            y1: 300.0,
            x2: 400.0,
            y2: 400.0,
            score: 0.7,
        };
        let kept = nms(vec![a, b, c], 0.4);
        assert_eq!(kept.len(), 2, "高度重叠的 a/b 应只留一个");
        assert!((kept[0].score - 0.9).abs() < 1e-6, "应保高分框");
    }

    #[test]
    fn face_mask_ellipse_center_high_edge_fades() {
        let f = FaceBox {
            x1: 40.0,
            y1: 40.0,
            x2: 140.0,
            y2: 140.0,
            score: 0.9,
        };
        let m = face_mask(200, 200, &[f], 10);
        assert!(m[(90, 90)] > 0.99, "椭圆中心应为 1");
        assert!(m[(10, 10)] < 0.01, "远处应为 0");
        // 羽化带：边界外几像素处应介于 0..1
        let edge_v = m[(90, 155)];
        assert!(edge_v > 0.0 && edge_v < 1.0, "羽化带应渐变，得 {}", edge_v);
    }

    #[test]
    fn paste_feathered_blends_edges() {
        let mut dst = Array3::from_elem((100, 100, 3), 0.0f32);
        let src = Array3::from_elem((50, 50, 3), 1.0f32);
        paste_feathered(&mut dst, &src, 25, 25, 10);
        assert!((dst[(50, 50, 0)] - 1.0).abs() < 1e-6, "中心应完全覆盖");
        // 羽化带中点（ROI 内 5px，feather=10 → 权重 0.5）应介于 0..1
        let mid = dst[(30, 50, 0)];
        assert!(mid > 0.0 && mid < 1.0, "羽化带应渐变混合，得 {}", mid);
        assert!((dst[(25, 50, 0)]).abs() < 1e-6, "最外沿权重 0，保持原值");
        assert!((dst[(10, 10, 0)]).abs() < 1e-6, "ROI 外不动");
    }
}
