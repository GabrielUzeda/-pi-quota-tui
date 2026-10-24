#!/usr/bin/env python3
"""Fraciona as cartelas do mascote em sprites de referência + manifest + README.

Uso: python3 scripts/fracionar-cartelas.py   (rodar na raiz do projeto)
"""
import json
import os
import shutil
import subprocess

ROWS = [(4, "comemorando", "COMEMORANDO"), (258, "triste", "TRISTE"),
        (513, "desesperado", "DESESPERADO"), (769, "concentrado", "CONCENTRADO")]
FRAME_X0, FRAME_W, FRAME_N = 286, 105.2, 6
EXPR_COLS = [(941, 83), (1026, 83)]
EXPR_ROWS = [(54, 94), (147, 94)]
ARM_X0, ARM_W = 1126, 80
ARM_LABELS = {
    "comemorando": [["-2,0", "-1,-1", "0,-2", "1,-1", "2,0"], ["-2,1", "-1,2", "0,2", "1,2", "2,1"]],
    "triste":      [["-2,1", "-1,1", "0,1", "1,1", "2,1"],    ["-2,2", "-1,2", "0,3", "1,2", "2,2"]],
    "desesperado": [["-2,-1", "-1,-2", "0,-2", "1,-2", "2,-1"], ["-2,0", "-1,1", "0,2", "1,1", "2,0"]],
    "concentrado": [["-2,0", "-1,-1", "0,-2", "1,-1", "2,0"],  ["-2,1", "-1,1", "0,2", "1,1", "2,1"]],
}

SHEETS = [
    {
        "src": "assets/references/Cartela de Animações do Mascote Arco-Íris.png",
        "out": "assets/mascote-arco-iris",
        "titulo": "Mascote Arco-Íris",
        "resumo": "Gota de corpo azul com topo em arco-íris, braços e pernas soltos.",
        "fundo": "claro",
        "paleta": {
            "corpo": "#0060f0",
            "contorno": "#0018d8",
            "arco_iris": ["#f01800", "#f06000", "#f0c000", "#f0d800", "#90c018", "#10c0b0", "#0078f0"],
            "fundo_painel": "#efeffb",
            "celula": "#f7f9fa",
            "header": "#1e2a5a",
        },
        "fundo_estado": {"comemorando": "#4cba6f", "triste": "#2fbdf7",
                         "desesperado": "#e8503f", "concentrado": "#7b4fe0"},
        "frames_descricao": {
            "comemorando": "F1 base sorrindo; F2 um braço sobe; F3 dois braços sobem; "
                           "F4 braços bem altos e boca aberta; F5 brilho aparece; F6 salto com brilhos.",
            "triste": "F1 cabeça baixa; F2–F3 ombros caem mais; F4 olhos fechados e inclinação; "
                      "F5 primeira lágrima; F6 lágrimas escorrendo até o chão.",
            "desesperado": "F1 mãos na cabeça com gotas; F2 pânico (olhos arregalados, faíscas); "
                           "F3 grito; F4 desânimo com gotas; F5 corpo encolhido; F6 suor e mãos na cabeça.",
            "concentrado": "F1 sobrancelhas franzidas e punhos; F2–F3 leve mudança de peso; "
                           "F4–F5 foco máximo; F6 estrela (ideia/foco) no topo.",
        },
        "notas": [
            "A sombra elíptica sob o mascote já vem dentro dos frames: se o personagem se\n"
            "  mover na cena, recorte/anime a sombra separadamente.",
            "O corpo é um \"sino\" com base reta e o topo em arco-íris; a altura do arco\n"
            "  cobre ~45% do sprite e é a âncora visual de todas as poses.",
        ],
    },
    {
        "src": "assets/references/Folha de Sprites Pixel Art_ Emoções.png",
        "out": "assets/mascote-pixel-emocoes",
        "titulo": "Mascote Pixel Art (Emoções)",
        "resumo": "Monitor quadrado branco com tela preta, braços e pés destacáveis.",
        "fundo": "escuro",
        "paleta": {
            "corpo": "#f4f2ee",
            "contorno": "#000000",
            "tela": "#000000",
            "fundo_painel": "#14141c",
            "celula": "#282830",
            "header": "#081820",
        },
        "fundo_estado": {"comemorando": "#28b050", "triste": "#00a8f0",
                         "desesperado": "#f84040", "concentrado": "#9848f8"},
        "frames_descricao": {
            "comemorando": "F1 base; F2 braços erguidos; F3 corpo inclina; F4 corpo deslocado; "
                           "F5 inclinação oposta com brilhos coloridos; F6 mesma pose com brilhos.",
            "triste": "F1 cabeça baixa e ombros caídos; F2–F4 corpo afunda; "
                      "F5 primeira lágrima no chão; F6 pingos de lágrima espalhados.",
            "desesperado": "F1 mãos na cabeça e gotas; F2 tremor (linhas de movimento); "
                           "F3 grito; F4 corpo tombando com rastro; F5 desânimo com gotas; F6 suor.",
            "concentrado": "F1–F3 braços junto ao corpo, base firme; F4–F5 olhos fechados na tela "
                           "e gota de suor; F6 volta à base parada.",
        },
        "notas": [
            "A tela é a área de maior contraste: use-a como âncora para sobrepor\n"
            "  expressões ou ícones sem redesenhar o corpo.",
            "O fundo das células é escuro e xadrezado em algumas áreas; para composição\n"
            "  em cena, recorte o sprite por limiar (corpo claro + contorno preto) em vez\n"
            "  de assumir um fundo chapado.",
        ],
    },
]


def run(args):
    try:
        subprocess.run(args, check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise SystemExit(f"ffmpeg falhou: {e}") from None


def crop(src, x, y, w, h, dst):
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
    except OSError as e:
        raise SystemExit(f"não foi possível criar {os.path.dirname(dst)}: {e}") from None
    run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", f"crop={w}:{h}:{x}:{y}", dst])


def grid(paths, cols, dst):
    lst = dst + ".txt"
    try:
        with open(lst, "w") as f:
            for p in paths:
                f.write(f"file '{os.path.abspath(p)}'\n")
    except OSError as e:
        raise SystemExit(f"não foi possível escrever {lst}: {e}") from None
    rows = (len(paths) + cols - 1) // cols
    run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
         "-filter_complex", f"tile={cols}x{rows}", dst])
    try:
        os.remove(lst)
    except OSError as e:
        raise SystemExit(f"não foi possível remover {lst}: {e}") from None


def fracionar(sheet):
    src, out = sheet["src"], sheet["out"]
    if not os.path.isfile(src):
        raise SystemExit(f"cartela não encontrada: {src}")
    try:
        if os.path.isdir(out):
            shutil.rmtree(out)
        os.makedirs(out + "/_fonte")
        shutil.copy2(src, f"{out}/_fonte/cartela-original.png")
        os.makedirs(f"{out}/_contato")
    except OSError as e:
        raise SystemExit(f"não foi possível preparar {out}: {e}") from None

    manifest = {"fonte": src, "tamanho_fonte": [1536, 1024],
                "paleta": sheet["paleta"], "estados": {}}
    frames, expressoes, bracos, heroes = [], [], [], []

    for y, estado, titulo in ROWS:
        st = {"titulo": titulo, "hero": None, "frames": [], "expressoes": [], "bracos": []}
        p = f"{out}/hero/{estado}.png"
        crop(src, 0, y, 277, 247, p)
        st["hero"] = {"arquivo": os.path.relpath(p, out), "bbox": [0, y, 277, 247]}
        heroes.append(p)

        for i in range(FRAME_N):
            x = FRAME_X0 + round(i * FRAME_W)
            p = f"{out}/frames/{estado}/f{i+1}.png"
            crop(src, x, y + 60, 106, 182, p)
            st["frames"].append({"arquivo": os.path.relpath(p, out),
                                 "bbox": [x, y + 60, 106, 182], "indice": i + 1})
            frames.append(p)

        n = 0
        for ex, ew in EXPR_COLS:
            for ry, rh in EXPR_ROWS:
                n += 1
                p = f"{out}/expressoes/{estado}/e{n}.png"
                crop(src, ex, y + ry, ew, rh, p)
                st["expressoes"].append({"arquivo": os.path.relpath(p, out),
                                         "bbox": [ex, y + ry, ew, rh], "indice": n})
                expressoes.append(p)

        for r in range(2):
            for c in range(5):
                label = ARM_LABELS[estado][r][c]
                dx, dy = (int(v) for v in label.split(","))
                p = f"{out}/bracos/{estado}/x{dx}_y{dy}.png"
                crop(src, ARM_X0 + c * ARM_W, y + 52 + r * 94, ARM_W, 94, p)
                st["bracos"].append({"arquivo": os.path.relpath(p, out),
                                     "bbox": [ARM_X0 + c * ARM_W, y + 52 + r * 94, ARM_W, 94],
                                     "deslocamento": [dx, dy], "rotulo_original": label})
                bracos.append(p)
        manifest["estados"][estado] = st

    try:
        with open(f"{out}/manifest.json", "w") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
    except OSError as e:
        raise SystemExit(f"não foi possível escrever o manifest: {e}") from None

    for nome, cols, paths in [("frames", 6, frames), ("expressoes", 4, expressoes),
                              ("bracos", 10, bracos), ("hero", 4, heroes)]:
        grid(paths, cols, f"{out}/_contato/{nome}.png")

    esperado = {"hero": 4, "frames": 24, "expressoes": 16, "bracos": 40}
    for k, v in esperado.items():
        n = sum(1 for dp, _, fns in os.walk(f"{out}/{k}") for fn in fns if fn.endswith(".png"))
        if n != v:
            raise SystemExit(f"{out}/{k}: {n} arquivos, esperado {v}")
        for dp, _, fns in os.walk(f"{out}/{k}"):
            for fn in fns:
                if os.path.getsize(os.path.join(dp, fn)) < 1000:
                    raise SystemExit(f"crop vazio: {fn}")
    escrever_readme(sheet)
    return sum(esperado.values())


def escrever_readme(sheet):
    out = sheet["out"]
    paleta = "\n".join(f"| {k} | `{v if isinstance(v, str) else ', '.join(v)}` |"
                       for k, v in sheet["paleta"].items())
    fundos = " · ".join(f"{k} `{v}`" for k, v in sheet["fundo_estado"].items())
    frames = "\n".join(f"- **{k}** — {v}" for k, v in sheet["frames_descricao"].items())
    bracos = "\n".join("| " + k + " | " + " ".join(f"({a},{b})" for a, b in
                        [tuple(int(v) for v in lbl.split(",")) for lbl in
                         ARM_LABELS[k][0] + ARM_LABELS[k][1]]) + " |" for k in ARM_LABELS)
    notas = "\n".join(f"- {n}" for n in sheet["notas"])
    alpha = ("Os PNGs são **opacos** (fundo de célula claro, não transparente). Para recortar\n"
             "  com alpha, aplique um limiar na cor de fundo ou use o `bbox` do manifest\n"
             "  sobre a cartela original." if sheet["fundo"] == "claro" else
             "Os PNGs são **opacos** (fundo de célula escuro/xadrezado). Recorte o sprite pelo\n"
             "  contorno preto + corpo claro (ou use o `bbox` do manifest sobre a cartela\n"
             "  original) antes de compor em cena.")
    txt = f"""# {sheet['titulo']} — referência visual fracionada

{sheet['resumo']}

Recorte da cartela `{sheet['src']}` em 84 sprites individuais + `manifest.json`
com as coordenadas originais de cada recorte.

Gerado por `scripts/fracionar-cartelas.py` (rode na raiz para regerar as duas
cartelas; apaga e recria esta pasta).

## Estrutura

```
{out}/
├── hero/<estado>.png                     4  ilustração do estado (com fundo colorido)
├── frames/<estado>/f1..f6.png           24  frames da animação
├── expressoes/<estado>/e1..e4.png       16  variações de rosto (TL, TR, BL, BR)
├── bracos/<estado>/x{{dx}}_y{{dy}}.png      40  poses de braço rotuladas por deslocamento
├── _contato/*.png                           folhas de contato para inspeção rápida
├── _fonte/cartela-original.png              cartela inteira, sem alteração
└── manifest.json                            bbox de cada sprite na cartela + paleta
```

Estados: `comemorando`, `triste`, `desesperado`, `concentrado`.

## Especificações

- Cartela: 1536 × 1024 px. Todos os recortes estão em resolução nativa (sem reescala).
- `hero`: 277 × 247 px, inclui o fundo colorido do estado.
- `frames`: 106 × 182 px, alinhados pela base da sombra; usar em loop de 6 frames
  (6–8 fps funciona bem para pixel art desse tamanho).
- `expressoes`: 83 × 94 px, mesmo enquadramento da cabeça em todos.
- `bracos`: 80 × 94 px, inclui o rótulo numérico original.
- {alpha}

## Braços: o que significam os rótulos

Cada estado tem 10 poses. O rótulo (também no nome do arquivo, `x{{dx}}_y{{dy}}`) é o
**deslocamento do braço em unidades do grid**, não em pixels. Negativo = esquerda/cima,
positivo = direita/baixo.

| Estado | poses (linha de cima / linha de baixo) |
|---|---|
{bracos}

## Animação por frame (o que muda)

{frames}

## Paleta

| papel | cor |
|---|---|
{paleta}
| fundo do estado | {fundos} |

Cores extraídas por amostragem da própria cartela (a imagem tem ruído de
compressão, então são aproximações de referência, não valores exatos).

## Notas para implementação

{notas}
- `hero` serve para telas de estado/perfil; `frames` para animação; `expressoes`
  para trocar o rosto sobre o mesmo corpo; `bracos` para rig manual.
"""
    try:
        with open(f"{out}/README.md", "w") as f:
            f.write(txt)
    except OSError as e:
        raise SystemExit(f"não foi possível escrever o README: {e}") from None


total = sum(fracionar(s) for s in SHEETS)
print(f"ok: {total} sprites em {len(SHEETS)} cartelas")
