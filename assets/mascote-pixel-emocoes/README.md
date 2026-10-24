# Mascote Pixel Art (Emoções) — referência visual fracionada

Monitor quadrado branco com tela preta, braços e pés destacáveis.

Recorte da cartela `Folha de Sprites Pixel Art_ Emoções.png` em 84 sprites individuais + `manifest.json`
com as coordenadas originais de cada recorte.

Gerado por `scripts/fracionar-cartelas.py` (rode na raiz para regerar as duas
cartelas; apaga e recria esta pasta).

## Estrutura

```
assets/mascote-pixel-emocoes/
├── hero/<estado>.png                     4  ilustração do estado (com fundo colorido)
├── frames/<estado>/f1..f6.png           24  frames da animação
├── expressoes/<estado>/e1..e4.png       16  variações de rosto (TL, TR, BL, BR)
├── bracos/<estado>/x{dx}_y{dy}.png      40  poses de braço rotuladas por deslocamento
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
- Os PNGs são **opacos** (fundo de célula escuro/xadrezado). Recorte o sprite pelo
  contorno preto + corpo claro (ou use o `bbox` do manifest sobre a cartela
  original) antes de compor em cena.

## Braços: o que significam os rótulos

Cada estado tem 10 poses. O rótulo (também no nome do arquivo, `x{dx}_y{dy}`) é o
**deslocamento do braço em unidades do grid**, não em pixels. Negativo = esquerda/cima,
positivo = direita/baixo.

| Estado | poses (linha de cima / linha de baixo) |
|---|---|
| comemorando | (-2,0) (-1,-1) (0,-2) (1,-1) (2,0) (-2,1) (-1,2) (0,2) (1,2) (2,1) |
| triste | (-2,1) (-1,1) (0,1) (1,1) (2,1) (-2,2) (-1,2) (0,3) (1,2) (2,2) |
| desesperado | (-2,-1) (-1,-2) (0,-2) (1,-2) (2,-1) (-2,0) (-1,1) (0,2) (1,1) (2,0) |
| concentrado | (-2,0) (-1,-1) (0,-2) (1,-1) (2,0) (-2,1) (-1,1) (0,2) (1,1) (2,1) |

## Animação por frame (o que muda)

- **comemorando** — F1 base; F2 braços erguidos; F3 corpo inclina; F4 corpo deslocado; F5 inclinação oposta com brilhos coloridos; F6 mesma pose com brilhos.
- **triste** — F1 cabeça baixa e ombros caídos; F2–F4 corpo afunda; F5 primeira lágrima no chão; F6 pingos de lágrima espalhados.
- **desesperado** — F1 mãos na cabeça e gotas; F2 tremor (linhas de movimento); F3 grito; F4 corpo tombando com rastro; F5 desânimo com gotas; F6 suor.
- **concentrado** — F1–F3 braços junto ao corpo, base firme; F4–F5 olhos fechados na tela e gota de suor; F6 volta à base parada.

## Paleta

| papel | cor |
|---|---|
| corpo | `#f4f2ee` |
| contorno | `#000000` |
| tela | `#000000` |
| fundo_painel | `#14141c` |
| celula | `#282830` |
| header | `#081820` |
| fundo do estado | comemorando `#28b050` · triste `#00a8f0` · desesperado `#f84040` · concentrado `#9848f8` |

Cores extraídas por amostragem da própria cartela (a imagem tem ruído de
compressão, então são aproximações de referência, não valores exatos).

## Pet redesenhado por código

nesta cartela. Não lê nem embute os recortes desta pasta.
O desenho inclui gabinete branco, tela escura, quatro expressões por emoção,
braços e sapatos independentes, inclinações, salto, suor e lágrimas.


[Guia completo](../../README.md)

## Notas para implementação

- A tela é a área de maior contraste: use-a como âncora para sobrepor
  expressões ou ícones sem redesenhar o corpo.
- O fundo das células é escuro e xadrezado em algumas áreas; para composição
  em cena, recorte o sprite por limiar (corpo claro + contorno preto) em vez
  de assumir um fundo chapado.
- `hero` serve para telas de estado/perfil; `frames` para animação; `expressoes`
  para trocar o rosto sobre o mesmo corpo; `bracos` para rig manual.
