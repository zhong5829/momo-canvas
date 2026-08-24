//! 分层文件导出：把透明 PNG 图层写入多页 TIFF。
//! TIFF 没有跨软件统一的“图层”标准，因此每个图层对应一个同尺寸 IFD 页面；ImageDescription 保存图层名。
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;
use tiff::encoder::{colortype, Compression, Rational, TiffEncoder};
use tiff::tags::Tag;

type SResult<T> = Result<T, String>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerFileInput {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerExportResult {
    pub path: String,
    pub bytes: u64,
    pub layers: usize,
    pub width: u32,
    pub height: u32,
}

pub fn export_tiff(
    layers: &[LayerFileInput],
    out_path: &str,
    dpi: u32,
) -> SResult<LayerExportResult> {
    if layers.is_empty() {
        return Err("没有可导出的图层".into());
    }
    let first = image::open(&layers[0].path)
        .map_err(|e| format!("读取图层失败：{}", e))?
        .to_rgba8();
    let (width, height) = first.dimensions();
    let file = File::create(out_path).map_err(|e| format!("创建 TIFF 失败：{}", e))?;
    let mut encoder = TiffEncoder::new(BufWriter::new(file))
        .map_err(|e| format!("初始化 TIFF 失败：{}", e))?
        .with_compression(Compression::Deflate(Default::default()));

    for (index, layer) in layers.iter().enumerate() {
        let rgba = image::open(&layer.path)
            .map_err(|e| format!("读取图层「{}」失败：{}", layer.name, e))?
            .to_rgba8();
        if rgba.dimensions() != (width, height) {
            return Err(format!(
                "图层「{}」尺寸不一致，期望 {}×{}",
                layer.name, width, height
            ));
        }
        let mut image = encoder
            .new_image::<colortype::RGBA8>(width, height)
            .map_err(|e| format!("创建 TIFF 图层失败：{}", e))?;
        // TIFF 6.0 的 ImageDescription 是 7-bit ASCII；中文名在 PSD 中完整保留，TIFF 使用稳定页号避免非法标签。
        let page_name = if layer.name.is_ascii() {
            layer.name.clone()
        } else {
            format!("MOMO Layer {}", index + 1)
        };
        image
            .encoder()
            .write_tag(Tag::ImageDescription, page_name.as_str())
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
        image
            .write_data(rgba.as_raw())
            .map_err(|e| format!("写入 TIFF 图层失败：{}", e))?;
    }
    let bytes = std::fs::metadata(out_path)
        .map_err(|e| e.to_string())?
        .len();
    Ok(LayerExportResult {
        path: out_path.into(),
        bytes,
        layers: layers.len(),
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn writes_multipage_tiff_with_names() {
        let dir = std::env::temp_dir().join("momo_layer_export_test");
        std::fs::create_dir_all(&dir).unwrap();
        let mut inputs = Vec::new();
        for (i, name) in ["背景", "标题"].iter().enumerate() {
            let path = dir.join(format!("{}.png", i));
            let image = ImageBuffer::from_pixel(24, 16, Rgba([20 + i as u8 * 80, 40, 90, 255]));
            image.save(&path).unwrap();
            inputs.push(LayerFileInput {
                name: (*name).into(),
                path: path.to_string_lossy().into(),
            });
        }
        let out = dir.join("layers.tif");
        let result =
            export_tiff(&inputs, &out.to_string_lossy(), 300).expect("应成功导出多页 TIFF");
        assert_eq!(result.layers, 2);
        assert_eq!((result.width, result.height), (24, 16));
        assert!(result.bytes > 100);
        let file = File::open(out).unwrap();
        let mut decoder = tiff::decoder::Decoder::new(file).unwrap();
        assert_eq!(
            decoder.get_tag_ascii_string(Tag::ImageDescription).unwrap(),
            "MOMO Layer 1"
        );
        decoder.next_image().unwrap();
        assert_eq!(
            decoder.get_tag_ascii_string(Tag::ImageDescription).unwrap(),
            "MOMO Layer 2"
        );
    }
}
