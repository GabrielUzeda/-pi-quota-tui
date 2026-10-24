#!/usr/bin/env python3
"""Exporta os sprites procedurais de notutil/pets.py para src/pets-data.ts.

O plugin pi desenha os pets em TypeScript a partir destes dados. Rode de novo
sempre que notutil/pets.py mudar:  python3 scripts/export_pets_data.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from notutil import pets  # noqa: E402

ROWS = 6  # linhas de terminal; cada linha vira 2 pixels verticais
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
TRANSPARENT = "."


def main() -> None:
    palette: dict[tuple[int, int, int], int] = {}
    pets_out: list[str] = []
    for name in pets.PETS:
        data = pets.frames_para(ROWS, 0, name)
        states_out = []
        for state in pets.STATES:
            frames_out = []
            for matrix in data[state]:
                rows = []
                for row in matrix:
                    chars = []
                    for cell in row:
                        if cell is None:
                            chars.append(TRANSPARENT)
                            continue
                        if cell not in palette:
                            palette[cell] = len(palette)
                        chars.append(ALPHABET[palette[cell]])
                    rows.append("".join(chars))
                frames_out.append("[" + ", ".join(f'"{r}"' for r in rows) + "]")
            states_out.append(f'    "{state}": [\n      ' + ",\n      ".join(frames_out) + ",\n    ]")
        pets_out.append(f'  "{name}": {{\n' + ",\n".join(states_out) + ",\n  }")

    if len(palette) > len(ALPHABET):
        raise SystemExit(f"paleta com {len(palette)} cores; o alfabeto cabe {len(ALPHABET)}")
    colors = sorted(palette, key=palette.__getitem__)
    palette_ts = ",\n  ".join(f"[{r}, {g}, {b}]" for r, g, b in colors)
    text = (
        "// Gerado por scripts/export_pets_data.py a partir de notutil/pets.py. Não editar à mão.\n"
        f"export const PET_ROWS = {ROWS};\n"
        f"export const PET_ALPHABET = \"{ALPHABET}\";\n"
        "export const PET_PALETTE: readonly (readonly [number, number, number])[] = [\n"
        f"  {palette_ts},\n];\n"
        "// Célula: \".\" transparente; demais caracteres indexam PET_PALETTE. Cada quadro tem 2*PET_ROWS linhas.\n"
        "export const PET_FRAMES: Record<string, Record<string, string[][]>> = {\n"
        + ",\n".join(pets_out) + ",\n};\n"
    )
    (ROOT / "src" / "pets-data.ts").write_text(text, encoding="utf-8")
    print(f"src/pets-data.ts: {len(pets.PETS)} pets, {len(palette)} cores")


if __name__ == "__main__":
    main()
