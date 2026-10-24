// Mascotes em meio-blocos ANSI (2 pixels por linha de terminal), a partir de pets-data.ts.
import { PET_ALPHABET, PET_FRAMES, PET_PALETTE } from "./pets-data.ts";

export const FRAME_COUNT = 6;
type Rgb = readonly [number, number, number];

const INDEX = new Map([...PET_ALPHABET].map((c, i) => [c, i] as const));
const RESET = "\x1b[0m";
const fg = (c: Rgb) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const bg = (c: Rgb) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;

function pixel(char: string): Rgb | undefined {
  const index = INDEX.get(char);
  return index === undefined ? undefined : PET_PALETTE[index];
}

function cell(top: Rgb | undefined, bottom: Rgb | undefined): string {
  if (top && bottom) return `${fg(top)}${bg(bottom)}▀${RESET}`;
  if (top) return `${fg(top)}\x1b[49m▀${RESET}`;
  if (bottom) return `${fg(bottom)}\x1b[49m▄${RESET}`;
  return `${RESET} `;
}

/** Um quadro (2 linhas de pixel por linha de terminal; "." é transparente) em linhas ANSI. */
export function frameToAnsi(rows: string[]): string[] {
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y];
    const bottom = rows[y + 1] ?? ".".repeat(top.length);
    let line = "";
    for (let x = 0; x < top.length; x++) line += cell(pixel(top[x]), pixel(bottom[x]));
    lines.push(line);
  }
  return lines;
}

const cache = new Map<string, string[][]>();

/** Quadros ANSI de um pet/emoção; convertidos uma vez e reutilizados. */
export function petFrames(pet: string, emotion: string): string[][] {
  const key = `${pet}/${emotion}`;
  let frames = cache.get(key);
  if (!frames) {
    frames = (PET_FRAMES[pet]?.[emotion] ?? []).map(frameToAnsi);
    cache.set(key, frames);
  }
  return frames;
}
