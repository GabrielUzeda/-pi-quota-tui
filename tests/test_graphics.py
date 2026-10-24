import base64
import io
import os
import random
import re
import unittest
import zlib
from dataclasses import replace
from unittest.mock import patch

from notutil import graphics, pets
from notutil.models import Snapshot, Window
from notutil.ui import render


def commands(output):
    return [part.split(";", 1) for part in re.findall(r"\x1b_G(.*?)\x1b\\", output, re.DOTALL)]


class GraphicsTests(unittest.TestCase):
    def setUp(self):
        self.image = graphics.PetImage("opencode", "concentrado", 0, 15, 8, 4, 8)

    def test_detection_and_manual_fallback(self):
        for env, expected in (
                ({}, False),
                ({"TERM_PROGRAM": "ghostty"}, True),
                ({"TERM": "xterm-kitty"}, True),
                ({"TERM_PROGRAM": "unknown"}, False),
                ({"TERM_PROGRAM": "ghostty", "TMUX": "test-session"}, False)):
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                self.assertEqual(graphics.enabled("auto"), expected)
                self.assertTrue(graphics.enabled("kitty"))
                self.assertFalse(graphics.enabled("ansi"))

    def test_native_rgba_is_transparent_and_not_downscaled(self):
        painter = graphics.KittyGraphics()
        output = painter.draw([self.image])
        upload = [item for item in commands(output) if len(item) == 2]
        self.assertIn("f=32,s=84,v=84,o=z", upload[0][0])
        rgba = zlib.decompress(base64.b64decode("".join(item[1] for item in upload)))
        canvas = pets.frames_para(42, pet_name="opencode")["concentrado"][0]
        expected = bytes(c for line in canvas for color in line
                         for c in ((*color, 255) if color is not None else (0, 0, 0, 0)))
        self.assertEqual(rgba, expected)
        self.assertEqual(len(rgba), 84*84*4)
        self.assertIn("\x1b[15;8H", output)
        self.assertIn("c=8,r=4,C=1,q=2", output)

    def test_large_upload_is_split_into_kitty_chunks(self):
        rng = random.Random(7)
        canvas = [[tuple(rng.randrange(256) for _ in range(3)) for _ in range(84)]
                  for _ in range(84)]
        with patch("notutil.graphics.pets.frames_para", return_value={"concentrado": [canvas]}):
            output = graphics.KittyGraphics().draw([self.image])
        upload = [item for item in commands(output) if len(item) == 2]
        self.assertGreater(len(upload), 1)
        self.assertTrue(all(len(item[1]) <= 4096 for item in upload))
        self.assertTrue(all("m=1" in item[0] for item in upload[:-1]))
        self.assertIn("m=0", upload[-1][0])
        data = zlib.decompress(base64.b64decode("".join(item[1] for item in upload)))
        self.assertEqual(len(data), 84*84*4)

    def test_frames_are_cached_and_old_placements_are_removed(self):
        painter = graphics.KittyGraphics()
        painter.draw([self.image])
        self.assertEqual(painter.draw([self.image]), "")
        second = replace(self.image, frame=1)
        changed = painter.draw([second])
        self.assertIn("a=d,d=i,i=197000,p=1,q=2", changed)
        cached = painter.draw([self.image])
        self.assertNotIn("a=t", cached)
        self.assertIn("a=p,i=197000", cached)
        self.assertIn("a=p", painter.draw([self.image], force=True))
        self.assertIn("a=d,d=i", painter.draw([]))
        self.assertNotIn("a=p", painter.draw([]))
        cleanup = painter.close()
        self.assertEqual(cleanup.count("a=d,d=I"), 2)
        self.assertEqual(painter.ids, {})

    def test_text_only_rewrites_changed_lines_and_erases_old_rows(self):
        self.assertEqual(graphics.text_update("one\ntwo", "one\ntwo"), "")
        self.assertEqual(graphics.text_update("one\nnew", "one\ntwo"),
                         "\x1b[2;1Hnew\x1b[0m\x1b[K")
        self.assertIn("\x1b[2;1H\x1b[0m\x1b[K", graphics.text_update("one", "one\ntwo"))
        self.assertNotIn("\x1b[2J", graphics.text_update("new", "old"))

    def test_app_draws_graphics_resizes_and_cleans_up(self):
        from notutil import app
        stream = io.StringIO()
        now = 1800000000
        snapshot = Snapshot("opencode", "OpenCode", "opencode",
                            (Window("5 horas", 20),), now, "teste")
        with patch("notutil.app.sys.stdin") as stdin, \
                patch("notutil.app.sys.stdout", stream), \
                patch.object(stream, "isatty", return_value=True), \
                patch("notutil.app.termios"), patch("notutil.app.tty"), \
                patch("notutil.app.Monitor") as monitor, \
                patch("notutil.app.Weather") as weather, \
                patch("notutil.app.Calendar") as agenda, \
                patch("notutil.app.time.time", return_value=now), \
                patch("notutil.app.select.select", return_value=([1], [], [])), \
                patch("notutil.app.shutil.get_terminal_size",
                      side_effect=[(100, 30), (100, 30), (100, 30), (80, 25)]):
            stdin.isatty.return_value = True
            stdin.read.side_effect = ["w", "r", "q"]
            monitor.return_value.snapshots.return_value = [snapshot]
            weather.return_value.finish.return_value = ""
            agenda.return_value.finish.return_value = ()
            app.run("kitty")
            monitor.return_value.close.assert_called_once()
            weather.return_value.close.assert_called_once()
            agenda.return_value.close.assert_called_once()
        output = stream.getvalue()
        self.assertEqual(output.count("\x1b[2J"), 2)
        self.assertIn("a=t,f=32,s=84,v=84", output)
        self.assertIn("a=d,d=I", output)
        self.assertTrue(output.endswith("\x1b[0m\x1b[?25h\x1b[?1049l"))

    def test_graphics_layout_is_compact_below_cards_and_inside_terminal(self):
        now = 1800000000
        snapshots = [Snapshot(name, name, name, (Window("5 horas", 20),), now, "teste")
                     for name in pets.PETS]
        for cols, height in ((52, 15), (80, 30), (156, 30), (200, 45)):
            images = []
            screen, _ = render(snapshots, now, 0, 0, cols, height, images=images)
            self.assertNotIn("▀", screen)
            self.assertNotIn("\x1b_G", screen)
            self.assertLessEqual(len(screen.split("\n")), height)
            for image in images:
                self.assertLessEqual(image.rows, 6)
                self.assertGreaterEqual(image.col, 1)
                self.assertLessEqual(image.col+image.cols-1, cols-1)
                self.assertLess(image.row+image.rows-1, height-1)
                above = screen.split("\n")[:image.row-1]
                self.assertTrue(any("╰" in line for line in above))
            if height >= 30:
                self.assertEqual(len(images), 5)
        fallback, _ = render(snapshots, now, 0, 0, 200, 45)
        self.assertIn("▀", fallback)


if __name__ == "__main__":
    unittest.main()
