#!/usr/bin/env python3
"""Gera uma cartela PNG do desenho procedural, sem Pillow nem ffmpeg."""
import argparse
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from notutil import pets as pet  # noqa: E402


def preview(path, expr=0, pet_name="antigravity", rows=42):
    frames = pet.frames_para(rows, expr, pet_name)
    gap = 8
    W = H = rows*2
    width, height = (W+gap)*6, (H+gap)*4
    pixels = bytearray(bytes((24, 28, 40))*width*height)
    for row, state in enumerate(pet.STATES):
        for frame in range(6):
            canvas = frames[state][frame]
            for y, line in enumerate(canvas):
                for x, color in enumerate(line):
                    if color is not None:
                        i = ((row*(H+gap)+y)*width+frame*(W+gap)+x)*3
                        pixels[i:i+3] = bytes(color)

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind+data)))

    scan = b"".join(b"\0"+pixels[y*width*3:(y+1)*width*3] for y in range(height))
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scan))
            + chunk(b"IEND", b""))
    Path(path).write_bytes(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="Caminho do PNG de saída")
    parser.add_argument("--pet", choices=pet.PETS, default="antigravity")
    parser.add_argument("--expression", type=int, choices=range(1, 5), default=1)
    parser.add_argument("--rows", type=int, default=42, help="Altura em linhas de terminal (1..120)")
    args = parser.parse_args()
    if not 1 <= args.rows <= 120:
        parser.error("--rows deve ficar entre 1 e 120")
    try:
        preview(args.output, args.expression-1, args.pet, args.rows)
    except OSError as error:
        parser.exit(1, f"Não foi possível salvar o preview: {error}\n")
