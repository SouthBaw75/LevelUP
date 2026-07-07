#!/usr/bin/env python3
"""Optimize source art for the web: resize + convert PNG/JPG to WebP.

Card art masters are large PNGs (~2-3 MB, ~1500 px). Cards never display
larger than the 250 px hover preview, so shipping full-res PNG makes clients
download 20-30x more than they render — the cause of multi-second art pops
online. This produces WebP at a resolution that still covers 3x-retina at the
largest on-screen size, then removes the source PNG/JPG (masters live on the
artist's machine + git history).

Run from client/assets/:  python3 optimize-art.py
Re-runnable: files already WebP are skipped, so dropping a new PNG and
re-running only converts the newcomer.
"""
import os, sys, io
from PIL import Image

# dir -> (max long edge px, webp quality, keep_alpha)
# Sizes cover 3x-retina at each asset's largest on-screen box; see the CSS
# boxes referenced in the README. Alpha kept only where transparency is the
# point (circular faction badges).
JOBS = {
    'card-art':      (768,  85, False),
    'ceo-art':       (900,  86, False),
    'faction-icons': (512,  88, True),
    'splash-screen': (1536, 88, False),  # logo: don't downscale, just compress
}
SRC_EXTS = ('.png', '.jpg', '.jpeg')


def convert(path, max_edge, quality, keep_alpha):
    im = Image.open(path)
    if keep_alpha:
        im = im.convert('RGBA')
    else:
        im = im.convert('RGB')
    scale = max_edge / max(im.size)
    if scale < 1:
        im = im.resize((round(im.size[0] * scale), round(im.size[1] * scale)), Image.LANCZOS)
    out = os.path.splitext(path)[0] + '.webp'
    im.save(out, format='WEBP', quality=quality, method=6)
    return out, os.path.getsize(path), os.path.getsize(out)


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    total_before = total_after = 0
    for d, (max_edge, quality, keep_alpha) in JOBS.items():
        dir_path = os.path.join(root, d)
        if not os.path.isdir(dir_path):
            continue
        files = sorted(f for f in os.listdir(dir_path) if f.lower().endswith(SRC_EXTS))
        if not files:
            continue
        print(f'\n{d}/  ({len(files)} file(s), max {max_edge}px q{quality}'
              f'{" +alpha" if keep_alpha else ""})')
        for f in files:
            src = os.path.join(dir_path, f)
            out, before, after = convert(src, max_edge, quality, keep_alpha)
            os.remove(src)
            total_before += before
            total_after += after
            print(f'  {f:22s} {before//1024:6d}KB -> {os.path.basename(out):22s} {after//1024:5d}KB')
    if total_before:
        print(f'\nTotal: {total_before/1e6:.1f}MB -> {total_after/1e6:.1f}MB '
              f'({total_before/total_after:.0f}x smaller)')
    else:
        print('Nothing to convert (all art already WebP).')


if __name__ == '__main__':
    main()
