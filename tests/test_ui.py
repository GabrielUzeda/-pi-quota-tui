import unittest

from notutil.models import Snapshot, Window
from notutil.ui import CARD_ROWS, render

NOW = 1800000000.0


def snapshot(*windows, name="Provedor"):
    return Snapshot(name.lower(), name, name.lower(), windows, NOW, "teste")


class CompactLayoutTests(unittest.TestCase):
    def test_card_is_three_lines_and_shows_the_blocking_window(self):
        snap = snapshot(Window("5 horas", 20, NOW+3600, 18000),
                        Window("Semanal", 80, NOW+3600, 604800))
        screen, pages = render([snap], NOW, 0, 0, 80, 24)
        lines = screen.split("\n")
        self.assertEqual(pages, 1)
        self.assertEqual(sum("╭─" in line for line in lines), 1)
        self.assertIn("80%", lines[3])
        self.assertNotIn("20%", lines[3])
        self.assertIn("outras janelas", screen)
        self.assertIn("5 HORAS 20%", screen)
        self.assertEqual(len([line for line in lines if "╰" in line]), 1)
        self.assertEqual(CARD_ROWS, 3)

    def test_secondary_line_hides_when_there_is_no_room(self):
        snap = snapshot(Window("5 horas", 20, NOW+3600, 18000),
                        Window("Semanal", 80, NOW+3600, 604800))
        screen, _ = render([snap], NOW, 0, 0, 80, 7)
        self.assertNotIn("outras janelas", screen)
        self.assertLessEqual(len(screen.split("\n")), 10)

    def test_empty_snapshot_still_renders_a_card(self):
        screen, _ = render([snapshot()], NOW, 0, 0, 80, 24)
        self.assertIn("SEM SINAL", screen)
        self.assertIn("sem dados da assinatura", screen)


if __name__ == "__main__":
    unittest.main()
