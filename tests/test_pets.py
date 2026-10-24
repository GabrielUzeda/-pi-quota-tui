import io
import re
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from notutil import pets as pet

ROOT = Path(__file__).resolve().parents[1]


class PetTests(unittest.TestCase):
    def test_all_drawings_are_valid_and_expressions_differ(self):
        for renderer in (pet.render_mascot_frame, pet.render_monitor_frame,
                         pet.render_claude_frame, pet.render_openai_frame,
                         pet.render_commandcode_frame):
            self.check_drawings(renderer)

    def check_drawings(self, renderer):
        for state in pet.STATES:
            for frame in range(6):
                drawings = []
                for expr in range(4):
                    canvas = renderer(state, frame, expr)
                    self.assertEqual((len(canvas), len(canvas[0])), (pet.H, pet.W))
                    self.assertTrue(all(len(row) == pet.W for row in canvas))
                    pixels = [c for row in canvas for c in row if c is not None]
                    self.assertGreater(len(pixels), 800)
                    self.assertTrue(all(len(c) == 3 and all(0 <= v <= 255 for v in c)
                                        for c in pixels))
                    self.assertTrue(all(c is None for c in canvas[0]+canvas[-1]))
                    self.assertTrue(all(row[0] is None and row[-1] is None for row in canvas))
                    drawings.append(tuple(tuple(row) for row in canvas))
                self.assertEqual(len(set(drawings)), 4, (state, frame))

    def test_celebrating_monitor_has_two_eyes_above_mouth(self):
        canvas = pet.render_monitor_frame("comemorando", 0)
        for x in (34, 46):
            eye = [canvas[y][x:x+5] for y in range(40, 45)]
            self.assertGreater(sum(c == pet.WHITE for row in eye for c in row), 10)
            self.assertNotEqual(canvas[42][x+2], pet.WHITE)  # Pupila escura.
        self.assertIn(pet.WHITE, canvas[50][37:48])

    def test_sad_mascot_has_visible_whites_and_attached_tears(self):
        for frame in range(6):
            canvas = [[None]*pet.W for _ in range(pet.H)]
            pet.face(canvas, "triste", frame, 0, lambda x, y: (x-40, y-8))
            if frame == 0:
                self.assertIn(pet.WHITE, canvas[36][28:35])
                self.assertIn(pet.WHITE, canvas[36][45:52])
            else:
                y = (29 if frame == 3 else 31)+8
                for x in (29, 49):
                    self.assertEqual(canvas[y][x], pet.TEAR)
                    self.assertIn(pet.OUTLINE, canvas[y-1][x:x+3])

    def test_tears_remain_connected_and_return_toward_start(self):
        for streaming in (False, True):
            heights = []
            for frame in range(6):
                canvas = [[None]*pet.W for _ in range(pet.H)]

                def stamp(x, y, rows, canvas=canvas):
                    pet.bitmap(canvas, x, y, rows)

                pet.tears(stamp, [(20, 20), (40, 20)], frame, streaming)
                length = (2, 4, 6, 7, 6, 4)[frame] + (3 if streaming else 0)
                for x in (20, 40):
                    self.assertTrue(all(canvas[y][x+1] is not None
                                        for y in range(20, 20+length+2)))
                    self.assertEqual(canvas[20][x+1], pet.PAL["S"])
                    self.assertEqual(canvas[20+length+1][x+1], pet.TEAR)
                    self.assertIsNone(canvas[20+length+2][x+1])
                heights.append(length)
            self.assertGreater(heights[3], heights[0])
            self.assertLess(heights[-1], heights[3])
            self.assertLessEqual(abs(heights[-1]-heights[0]), 2)

    def test_shadow_has_no_isolated_vertical_tips(self):
        for renderer, color in [(pet.render_mascot_frame, (43, 45, 56)),
                                 (pet.render_monitor_frame, (43, 45, 56))]:
            canvas = renderer("comemorando", 3)
            rows = {y for y, line in enumerate(canvas) if color in line}
            self.assertEqual(rows, {74, 75, 76})
            for y in rows:
                self.assertGreater(sum(c == color for c in canvas[y]), 10)

    def test_inverse_composite_fills_stretched_pixels_without_holes(self):
        layer = [[None]*pet.W for _ in range(pet.H)]
        pet.bitmap(layer, 10, 10, ["WW", "WW"])
        canvas = [[None]*pet.W for _ in range(pet.H)]
        pet.composite(canvas, layer, lambda x, y: (x/2, y/2), (0, 0))
        self.assertTrue(all(canvas[y][x] == pet.WHITE
                            for y in range(20, 23) for x in range(20, 23)))
        self.assertIsNone(canvas[0][0])

    def test_open_eye_pupils_are_centered_in_their_bitmaps(self):
        for eye in (pet.ROUND, pet.WIDE, pet.SAD, pet.FOCUS):
            for row in eye:
                if "P" in row:
                    self.assertEqual(row.index("P"), len(row)//2)
                    self.assertEqual(row.count("W") % 2, 0)

    def test_compact_eyes_remove_pupils_without_erasing_sclera(self):
        native = pet.render_monitor_frame("comemorando", 0)
        compact = pet.render_monitor_frame("comemorando", 0, compact=True)
        for x in (36, 48):
            self.assertNotEqual(native[42][x], pet.WHITE)
            self.assertEqual(compact[42][x], pet.WHITE)
        for compact_mode in (False, True):
            canvas = [[None]*pet.W for _ in range(pet.H)]
            pet.face(canvas, "comemorando", 0, 0,
                     lambda x, y: (x-40, y-8), compact=compact_mode)
            for y in range(32, 39):
                self.assertEqual(canvas[y][28:35], canvas[y][46:53][::-1])
            self.assertEqual(canvas[35][31], pet.WHITE if compact_mode else pet.OUTLINE)

    def test_downscale_preserves_eye_contrast_but_not_transparent_noise(self):
        source = [[pet.BLUE, pet.WHITE], [pet.BLUE, pet.BLUE]]
        self.assertEqual(pet._escala_matriz(source, 1, 1), [[pet.WHITE]])
        self.assertEqual(pet._escala_matriz(source, 2, 2), source)
        source = [[None, pet.WHITE], [None, None]]
        self.assertEqual(pet._escala_matriz(source, 1, 1), [[None]])

    def test_small_matrices_keep_visible_eyes_on_both_sides(self):
        for name in pet.PETS:
            for rows in (12, 16, 24, 42, 60):
                canvas = pet.frames_para(rows, pet_name=name)["comemorando"][0]
                for start, end in ((0, rows), (rows+1, rows*2)):
                    self.assertTrue(any(c == pet.WHITE for line in canvas for c in line[start:end]),
                                    (name, rows, start))

    def test_rainbow_uses_a_small_fixed_palette(self):
        colors = {pet.thermal(x, y) for x in range(-25, 26) for y in range(53)}
        self.assertLessEqual(len(colors), 6)
        self.assertIn(pet.BLUE, colors)

    def test_antigravity_head_shadow_preserves_rainbow_colors_in_all_poses(self):
        body = pet.polygon(pet.BODY)
        for frame in range(6):
            canvas = pet.render_mascot_frame("comemorando", frame)
            jump, sy, sx, tilt = pet.POSES["comemorando"][frame]
            top = 73+jump-52*sy
            checked = 0
            for py in range(pet.H):
                for px in range(pet.W):
                    y = (py-top)/sy
                    x = (px-42-(26-y)*tilt)/sx
                    x, y = round(x), round(y)
                    if (x, y) in body and x < 0 and 2 <= y <= 10 and (x-2, y) not in body:
                        color = pet.thermal(x, y)
                        self.assertEqual(canvas[py][px], tuple(round(v*.72) for v in color),
                                         (frame, x, y))
                        checked += 1
            self.assertGreater(checked, 0)

    def test_resting_body_is_symmetric_and_cycle_closes(self):
        for renderer in (pet.render_mascot_frame, pet.render_monitor_frame,
                         pet.render_claude_frame, pet.render_openai_frame,
                         pet.render_commandcode_frame):
            canvas = renderer("comemorando", 0)
            for y in range(25, 73):
                self.assertEqual([c is not None for c in canvas[y][10:42]],
                                 [c is not None for c in canvas[y][43:75]][::-1])
            for state in pet.STATES:
                frames = [renderer(state, f) for f in range(6)]
                def difference(a, b):
                    return sum((ca is None) != (cb is None)
                               for ra, rb in zip(a, b, strict=True) for ca, cb in zip(ra, rb, strict=True))
                steps = [difference(frames[f], frames[(f+1) % 6]) for f in range(6)]
                self.assertLessEqual(steps[-1], max(steps[:-1]), (renderer.__name__, state))

    def test_preview_png(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"monitor.png"
            result = subprocess.run(
                [sys.executable, "-S", str(ROOT/"scripts/preview_pet.py"),
                 str(path), "--pet", "opencode", "--expression", "4"],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = path.read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack(">II", data[16:24])
            self.assertEqual((width, height), (552, 368))
            size = struct.unpack(">I", data[33:37])[0]
            scan = zlib.decompress(data[41:41+size])
            self.assertEqual(len(scan), height*(width*3+1))

    def test_validation(self):
        for args in [("invalido", 0, 0), ("triste", -1, 0),
                     ("triste", 6, 0), ("triste", 0, 4)]:
            with self.assertRaises(ValueError):
                pet.render_mascot_frame(*args)

    def test_monitor_cli_export_without_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, "-S", str(ROOT/"pet.py"), "--pet", "opencode",
                 "--rows", "42", "--expression", "4", "--export", directory],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            files = list(Path(directory).glob("*.ansi"))
            self.assertEqual(len(files), 24)
            self.assertTrue(all("▀" in f.read_text() for f in files))
            arc = pet.frames_para(42)["comemorando"][0]
            monitor = pet.frames_para(42, pet_name="opencode")["comemorando"][0]
            self.assertNotEqual(arc, monitor)

    def test_scaling_transparency_and_half_blocks(self):
        for rows in (16, 42, 60):
            matrix = pet.frames_para(rows)["comemorando"][0]
            self.assertEqual((len(matrix), len(matrix[0])), (rows*2, rows*2))
            _, lines = pet.matrix_to_ansi(matrix)
            self.assertEqual(lines, rows)
        self.assertIn("▄", pet.celula_ansi(None, (1, 2, 3)))
        self.assertIn("▀", pet.celula_ansi((1, 2, 3), None))
        self.assertEqual(pet.celula_ansi(None, None), "\x1b[0m ")

    def test_export_and_no_image_dependency(self):
        with tempfile.TemporaryDirectory() as directory:
            # -S desabilita site-packages: não há Pillow nem dependências no runtime.
            result = subprocess.run(
                [sys.executable, "-S", str(ROOT/"pet.py"), "--rows", "24",
                 "--expression", "4", "--export", directory],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            files = list(Path(directory).glob("*.ansi"))
            self.assertEqual(len(files), 24)
            self.assertTrue(all("▀" in f.read_text() for f in files))

    def test_animation_uses_expression_and_restores_terminal(self):
        stream = io.StringIO()
        with patch("notutil.pets.frames_para", return_value={"triste": [[[None]]]}) as frames, \
                patch("notutil.pets.STATES", ("triste",)), patch("notutil.pets.sys.stdout", stream), \
                patch("notutil.pets.time.sleep", side_effect=KeyboardInterrupt):
            pet.run_pet("triste", True, None, "/unused", 6.5, 24, 3)
        frames.assert_called_once_with(24, 3, "antigravity")
        output = stream.getvalue()
        self.assertIn("\x1b[H", output)
        self.assertNotIn("\\x1b", output)
        self.assertIn("antigravity E4", output)
        self.assertTrue(output.endswith("\x1b[0m\x1b[?25h\x1b[?1049l"))

    def test_grid_shows_all_pets_and_emotions_and_fits_terminal(self):
        def drawings(rows, expr_idx, name):
            matrix = [[None]*(rows*2) for _ in range(rows*2)]
            return {state: [matrix]*6 for state in pet.STATES}

        for cols, lines in ((100, 45), (40, 50), (15, 90)):
            with self.subTest(cols=cols, lines=lines):
                stream = io.StringIO()
                with patch("notutil.pets.shutil.get_terminal_size", return_value=(cols, lines)), \
                        patch("notutil.pets.frames_para", side_effect=drawings) as frames, \
                        patch("notutil.pets.sys.stdout", stream), \
                        patch("notutil.pets.time.sleep", side_effect=[None, KeyboardInterrupt]):
                    pet.run_grid(8, 42, 2)
                output = stream.getvalue()
                self.assertEqual(frames.call_count, len(pet.PETS))
                self.assertTrue(all(call.args[1] == 2 for call in frames.call_args_list))
                screens = output.split("\x1b[H")[1:]
                self.assertEqual(len(screens), 2)
                for screen in screens:
                    plain = re.sub(r"\x1b\[[?0-9;]*[A-Za-z]", "", screen)
                    rows = plain.splitlines()
                    self.assertLessEqual(len(rows), lines-1)
                    self.assertTrue(all(len(row) <= cols-1 for row in rows))
                    for name in pet.PETS:
                        self.assertEqual(plain.count(name), len(pet.STATES))
                    for state in pet.STATES:
                        self.assertEqual(plain.count(state), len(pet.PETS))
                self.assertIn("F1/6", screens[0])
                self.assertIn("F2/6", screens[1])
                self.assertTrue(output.endswith("\x1b[0m\x1b[?25h\x1b[?1049l"))

    def test_grid_rejects_terminal_too_small_before_hiding_cursor(self):
        stream = io.StringIO()
        with patch("notutil.pets.shutil.get_terminal_size", return_value=(10, 5)), \
                patch("notutil.pets.sys.stdout", stream), self.assertRaises(SystemExit):
            pet.run_grid(6.5, None)
        self.assertEqual(stream.getvalue(), "")

    def test_default_cli_opens_grid_and_explicit_selection_keeps_single_pet(self):
        for flags in ([], ["--rows", "12", "--fps", "8", "--expression", "3"],
                      ["--pet", "opencode"], ["-s", "triste"], ["--demo"],
                      ["--export", "out"], ["--state-file", "/tmp/pet.state"]):
            with self.subTest(flags=flags), patch("notutil.pets.sys.argv", ["pet.py"]+flags), \
                    patch("notutil.pets.run_grid") as grid, patch("notutil.pets.run_pet") as single:
                pet.main()
                individual = bool(set(flags) & {"--pet", "-s", "--demo", "--export", "--state-file"})
                self.assertEqual(single.called, individual)
                self.assertEqual(grid.called, not individual)
                if not flags:
                    grid.assert_called_once_with(6.5, None, 0)
                elif "--expression" in flags:
                    grid.assert_called_once_with(8, 12, 2)

    def test_cli_rejects_invalid_size_and_speed(self):
        for flag, value in [("--rows", "0"), ("--fps", "0"), ("--fps", "nan")]:
            result = subprocess.run([sys.executable, str(ROOT/"pet.py"), flag, value],
                                    capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
