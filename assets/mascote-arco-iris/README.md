# Mascote Arco-Íris — referência visual fracionada

Gota de corpo azul com topo em arco-íris, braços e pernas soltos.

Recorte da cartela `Cartela de Animações do Mascote Arco-Íris.png` em 84 sprites individuais + `manifest.json`
com as coordenadas originais de cada recorte.

Gerado por `scripts/fracionar-cartelas.py` (rode na raiz para regerar as duas
cartelas; apaga e recria esta pasta).

## Estrutura

```
assets/mascote-arco-iris/
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
- Os PNGs são **opacos** (fundo de célula claro, não transparente). Para recortar
  com alpha, aplique um limiar na cor de fundo ou use o `bbox` do manifest
  sobre a cartela original.

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

- **comemorando** — F1 base sorrindo; F2 um braço sobe; F3 dois braços sobem; F4 braços bem altos e boca aberta; F5 brilho aparece; F6 salto com brilhos.
- **triste** — F1 cabeça baixa; F2–F3 ombros caem mais; F4 olhos fechados e inclinação; F5 primeira lágrima; F6 lágrimas escorrendo até o chão.
- **desesperado** — F1 mãos na cabeça com gotas; F2 pânico (olhos arregalados, faíscas); F3 grito; F4 desânimo com gotas; F5 corpo encolhido; F6 suor e mãos na cabeça.
- **concentrado** — F1 sobrancelhas franzidas e punhos; F2–F3 leve mudança de peso; F4–F5 foco máximo; F6 estrela (ideia/foco) no topo.

## Paleta

| papel | cor |
|---|---|
| corpo | `#0060f0` |
| contorno | `#0018d8` |
| arco_iris | `#f01800, #f06000, #f0c000, #f0d800, #90c018, #10c0b0, #0078f0` |
| fundo_painel | `#efeffb` |
| celula | `#f7f9fa` |
| header | `#1e2a5a` |
| fundo do estado | comemorando `#4cba6f` · triste `#2fbdf7` · desesperado `#e8503f` · concentrado `#7b4fe0` |

Cores extraídas por amostragem da própria cartela (a imagem tem ruído de
compressão, então são aproximações de referência, não valores exatos).

## Uso como referência do pet

O `pet.py` redesenha o mascote com geometria, gradiente e bitmaps faciais
próprios. Não carrega estes PNGs nem embute pixels extraídos deles.
As imagens desta pasta são apenas referências visuais.

Veja [o guia do pet](../../README.md) e a
[prévia dos 24 desenhos](../../previews/pet-procedural.png).

## Notas para implementação

- A sombra elíptica sob o mascote já vem dentro dos frames: se o personagem se
  mover na cena, recorte/anime a sombra separadamente.
- O corpo é um "sino" com base reta e o topo em arco-íris; a altura do arco
  cobre ~45% do sprite e é a âncora visual de todas as poses.
- `hero` serve para telas de estado/perfil; `frames` para animação; `expressoes`
  para trocar o rosto sobre o mesmo corpo; `bracos` para rig manual.
