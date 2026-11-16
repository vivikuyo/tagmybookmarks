#!/usr/bin/env python3
"""生成扩展图标（不依赖 Pillow，纯 zlib 手写 PNG）。
用法：python3 tools/make-icons.py
"""
import os, struct, zlib

BG = (33, 40, 58, 255)        # #21283a
PILLS = [
    ((76, 125, 255, 255), 0.16, 0.24, 0.56),   # 蓝
    ((214, 64, 159, 255), 0.24, 0.43, 0.42),   # 粉
    ((52, 168, 106, 255), 0.16, 0.62, 0.50),   # 绿
]
SS = 8  # 超采样倍数


def inside_round_rect(x, y, rx, ry, rw, rh, r):
    if x < rx or y < ry or x > rx + rw or y > ry + rh:
        return False
    cx = min(max(x, rx + r), rx + rw - r)
    cy = min(max(y, ry + r), ry + rh - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def render(size):
    big = size * SS
    buf = [[(0, 0, 0, 0)] * big for _ in range(big)]

    # 背景圆角方块
    r = int(big * 0.2)
    for y in range(big):
        for x in range(big):
            if inside_round_rect(x + .5, y + .5, 0, 0, big, big, r):
                buf[y][x] = BG

    # 三颗胶囊
    for color, x0, y0, w0 in PILLS:
        h = int(big * 0.15)
        rx = int(big * x0)
        ry = int(big * y0)
        rw = int(big * w0)
        rad = h // 2
        for y in range(ry, ry + h):
            for x in range(rx, rx + rw):
                if inside_round_rect(x + .5, y + .5, rx, ry, rw, h, rad):
                    buf[y][x] = color

    # 降采样
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            rr = gg = bb = aa = 0
            for j in range(SS):
                for i in range(SS):
                    p = buf[y * SS + j][x * SS + i]
                    rr += p[0]; gg += p[1]; bb += p[2]; aa += p[3]
            n = SS * SS
            row.append((rr // n, gg // n, bb // n, aa // n))
        out.append(row)
    return out


def write_png(path, pixels):
    h = len(pixels); w = len(pixels[0])
    raw = b''
    for row in pixels:
        raw += b'\x00' + b''.join(struct.pack('BBBB', *p) for p in row)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(os.path.join(out, f'icon{size}.png'), render(size))
        print('写入', f'icons/icon{size}.png')


if __name__ == '__main__':
    main()
