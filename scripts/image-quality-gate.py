#!/usr/bin/env python3
"""MOMO 图片生产质量门禁：比较固定参考图与候选图，输出 JSON/HTML/差异热力图并以退出码拦截退化。"""
from __future__ import annotations

import argparse
import html
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image


def load_rgba(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with Image.open(path) as image:
        rgba = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
        return rgba[..., :3], rgba[..., 3]


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    return 99.0 if mse <= 1e-12 else 10.0 * math.log10(1.0 / mse)


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    # 分块 SSIM，避免只算全局均值掩盖局部结构退化。
    ga = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    gb = b @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    values: list[float] = []
    block = 64
    c1, c2 = 0.01**2, 0.03**2
    for y in range(0, ga.shape[0], block):
        for x in range(0, ga.shape[1], block):
            aa = ga[y : y + block, x : x + block]
            bb = gb[y : y + block, x : x + block]
            ma, mb = float(aa.mean()), float(bb.mean())
            va, vb = float(aa.var()), float(bb.var())
            cov = float(((aa - ma) * (bb - mb)).mean())
            values.append(((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2)))
    return float(np.mean(values))


def edge_map(image: np.ndarray) -> np.ndarray:
    gray = image @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    mag = np.sqrt(gx * gx + gy * gy)
    threshold = max(0.035, float(np.percentile(mag, 82)))
    return mag >= threshold


def edge_iou(a: np.ndarray, b: np.ndarray) -> float:
    ea, eb = edge_map(a), edge_map(b)
    union = np.logical_or(ea, eb).sum()
    return 1.0 if union == 0 else float(np.logical_and(ea, eb).sum() / union)


def alpha_iou(a: np.ndarray, b: np.ndarray) -> float:
    aa, ab = a >= 0.5, b >= 0.5
    union = np.logical_or(aa, ab).sum()
    return 1.0 if union == 0 else float(np.logical_and(aa, ab).sum() / union)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = linear @ np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]], dtype=np.float32).T
    xyz /= np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    delta = 6 / 29
    f = np.where(xyz > delta**3, np.cbrt(xyz), xyz / (3 * delta * delta) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def mean_delta_e(a: np.ndarray, b: np.ndarray) -> float:
    # 门禁使用 CIE76 平均色差；绝对印刷验收仍应在目标 ICC 下做软打样。
    return float(np.sqrt(np.sum((rgb_to_lab(a) - rgb_to_lab(b)) ** 2, axis=-1)).mean())


def heatmap(a: np.ndarray, b: np.ndarray, path: Path) -> None:
    diff = np.mean(np.abs(a - b), axis=2)
    q = max(1e-6, float(np.percentile(diff, 99)))
    v = np.clip(diff / q, 0, 1)
    out = np.stack([v, np.sqrt(v) * 0.45, (1 - v) * 0.12], axis=-1)
    Image.fromarray(np.uint8(out * 255), "RGB").save(path)


def check(entry: dict, root: Path, artifacts: Path) -> dict:
    name = str(entry.get("name") or "未命名样本")
    reference = (root / entry["reference"]).resolve()
    candidate = (root / entry["candidate"]).resolve()
    started = time.perf_counter()
    a, alpha_a = load_rgba(reference)
    b, alpha_b = load_rgba(candidate)
    if a.shape != b.shape:
        return {"name": name, "ok": False, "error": f"尺寸不一致：参考 {a.shape[1]}×{a.shape[0]}，候选 {b.shape[1]}×{b.shape[0]}"}
    metrics = {
        "psnr": psnr(a, b),
        "ssim": ssim(a, b),
        "edgeIoU": edge_iou(a, b),
        "alphaIoU": alpha_iou(alpha_a, alpha_b),
        "alphaMae": float(np.mean(np.abs(alpha_a - alpha_b))),
        "meanDeltaE": mean_delta_e(a, b),
        "bytesRatio": candidate.stat().st_size / max(1, reference.stat().st_size),
        "metricMs": round((time.perf_counter() - started) * 1000),
    }
    thresholds = entry.get("thresholds", {})
    failures: list[str] = []
    minimums = {"psnr": "PSNR", "ssim": "SSIM", "edgeIoU": "边缘 IoU", "alphaIoU": "Alpha IoU"}
    maximums = {"meanDeltaE": "平均 ΔE", "bytesRatio": "体积倍率", "alphaMae": "Alpha MAE"}
    for key, label in minimums.items():
        if key in thresholds and metrics[key] < float(thresholds[key]):
            failures.append(f"{label} {metrics[key]:.4f} < {thresholds[key]}")
    for key, label in maximums.items():
        threshold_key = "max" + key[0].upper() + key[1:]
        if threshold_key in thresholds and metrics[key] > float(thresholds[threshold_key]):
            failures.append(f"{label} {metrics[key]:.4f} > {thresholds[threshold_key]}")
    if "maxTimeMs" in thresholds and entry.get("elapsedMs") is not None and float(entry["elapsedMs"]) > float(thresholds["maxTimeMs"]):
        failures.append(f"生成耗时 {entry['elapsedMs']}ms > {thresholds['maxTimeMs']}ms")
    heat = artifacts / f"{len(list(artifacts.glob('diff_*.png'))):03d}_diff.png"
    heatmap(a, b, heat)
    return {"name": name, "ok": not failures, "reference": str(reference), "candidate": str(candidate), "metrics": metrics, "failures": failures, "heatmap": heat.name}


def write_html(results: list[dict], out: Path, artifacts: Path) -> None:
    rows = []
    for result in results:
        metrics = result.get("metrics", {})
        rows.append(f"<tr class={'ok' if result.get('ok') else 'bad'}><td>{html.escape(result['name'])}</td><td>{'通过' if result.get('ok') else '失败'}</td>"
                    f"<td>{metrics.get('psnr', 0):.3f}</td><td>{metrics.get('ssim', 0):.4f}</td><td>{metrics.get('edgeIoU', 0):.4f}</td>"
                    f"<td>{metrics.get('alphaIoU', 0):.4f}</td><td>{metrics.get('alphaMae', 0):.4f}</td>"
                    f"<td>{metrics.get('meanDeltaE', 0):.3f}</td><td>{html.escape('; '.join(result.get('failures', [])) or result.get('error', ''))}</td>"
                    f"<td>{f'<img src="{artifacts.name}/{result["heatmap"]}">' if result.get('heatmap') else ''}</td></tr>")
    page = f"""<!doctype html><meta charset='utf-8'><title>MOMO 图片质量门禁</title><style>
body{{font:14px system-ui;margin:28px;background:#10131a;color:#e9edf5}}table{{border-collapse:collapse;width:100%}}th,td{{padding:9px;border:1px solid #343b49;text-align:left}}.ok{{background:#123226}}.bad{{background:#431d26}}img{{width:150px}}code{{color:#9dc1ff}}</style>
<h1>MOMO 图片质量门禁</h1><p>通过 {sum(1 for r in results if r.get('ok'))}/{len(results)} · 生成于 {time.strftime('%Y-%m-%d %H:%M:%S')}</p>
<table><thead><tr><th>样本</th><th>状态</th><th>PSNR</th><th>SSIM</th><th>边缘IoU</th><th>Alpha IoU</th><th>Alpha MAE</th><th>平均ΔE</th><th>原因</th><th>差异热图</th></tr></thead><tbody>{''.join(rows)}</tbody></table>"""
    out.write_text(page, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="MOMO 图片质量回归门禁")
    parser.add_argument("manifest", type=Path, help="质量样本 manifest.json")
    parser.add_argument("--out", type=Path, default=Path("quality-report.html"), help="HTML 报告路径")
    args = parser.parse_args()
    manifest = args.manifest.resolve()
    config = json.loads(manifest.read_text(encoding="utf-8"))
    entries = config.get("samples", [])
    if not entries:
        print("质量门禁没有样本，请在 manifest 的 samples 中登记参考图与候选图", file=sys.stderr)
        return 2
    args.out = args.out.resolve()
    artifacts = args.out.parent / f"{args.out.stem}_assets"
    artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    for entry in entries:
        try:
            results.append(check(entry, manifest.parent, artifacts))
        except Exception as exc:  # 单个坏样本不能中断其余报告
            results.append({"name": str(entry.get("name") or "未命名样本"), "ok": False, "error": str(exc)})
    write_html(results, args.out, artifacts)
    json_path = args.out.with_suffix(".json")
    json_path.write_text(json.dumps({"ok": all(r.get("ok") for r in results), "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"质量门禁：{sum(1 for r in results if r.get('ok'))}/{len(results)} 通过；报告 {args.out}")
    return 0 if all(r.get("ok") for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
