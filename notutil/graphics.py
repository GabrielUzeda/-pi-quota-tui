"""Kitty Graphics: matrizes originais, transporte em memória e cache de frames."""
import base64
import os
import zlib
from dataclasses import dataclass

from . import pets


def enabled(mode: str) -> bool:
    if mode != "auto":
        return mode == "kitty"
    # shortcut: multiplexadores ficam em ANSI; habilitar passthrough antes de autodetectá-los.
    if os.environ.get("TMUX") or os.environ.get("STY"):
        return False
    return (os.environ.get("TERM_PROGRAM", "").lower() in ("ghostty", "kitty")
            or os.environ.get("TERM") in ("xterm-kitty", "xterm-ghostty")
            or bool(os.environ.get("KITTY_WINDOW_ID")))


def command(control: str, payload: str = "") -> str:
    return "\x1b_G"+control+(";" + payload if payload else "")+"\x1b\\"


@dataclass(frozen=True)
class PetImage:
    pet: str
    emotion: str
    frame: int
    row: int
    col: int
    rows: int
    cols: int


class KittyGraphics:
    def __init__(self) -> None:
        self.ids: dict[tuple[str, str, int], int] = {}
        self.visible: list[PetImage] = []

    def _upload(self, image: PetImage) -> tuple[int, str]:
        key = image.pet, image.emotion, image.frame % 6
        if key in self.ids:
            return self.ids[key], ""
        image_id = 197000 + len(self.ids)
        canvas = pets.frames_para(pets.H//2, pet_name=image.pet)[image.emotion][image.frame % 6]
        rgba = bytes(channel for line in canvas for color in line
                     for channel in ((*color, 255) if color is not None else (0, 0, 0, 0)))
        payload = base64.b64encode(zlib.compress(rgba)).decode("ascii")
        output = []
        for start in range(0, len(payload), 4096):
            chunk = payload[start:start+4096]
            more = int(start+4096 < len(payload))
            control = (f"a=t,f=32,s={pets.W},v={pets.H},o=z,i={image_id},q=2,"
                       if start == 0 else "q=2,")
            output.append(command(control+f"m={more}", chunk))
        self.ids[key] = image_id
        return image_id, "".join(output)

    def draw(self, images: list[PetImage], force: bool = False) -> str:
        output = []
        for index, old in enumerate(self.visible):
            if not force and index < len(images) and old == images[index]:
                continue
            image_id = self.ids[old.pet, old.emotion, old.frame % 6]
            output.append(command(f"a=d,d=i,i={image_id},p={index+1},q=2"))
        for index, image in enumerate(images):
            if not force and index < len(self.visible) and image == self.visible[index]:
                continue
            image_id, upload = self._upload(image)
            output.append(upload)
            output.append(f"\x1b[{image.row};{image.col}H")
            output.append(command(f"a=p,i={image_id},p={index+1},c={image.cols},"
                                  f"r={image.rows},C=1,q=2"))
        self.visible = list(images)
        return "".join(output)

    def close(self) -> str:
        output = "".join(command(f"a=d,d=I,i={image_id},q=2") for image_id in self.ids.values())
        self.ids.clear()
        self.visible.clear()
        return output


def text_update(screen: str, previous: str) -> str:
    """Atualiza apenas linhas alteradas; apaga sobras sem limpar as imagens."""
    current, old = screen.split("\n"), previous.split("\n")
    output = []
    for index in range(max(len(current), len(old))):
        line = current[index] if index < len(current) else ""
        if index >= len(old) or line != old[index]:
            output.append(f"\x1b[{index+1};1H"+line+"\x1b[0m\x1b[K")
    return "".join(output)
