import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from extract_pdf_text import extract_document_text


class ExtractPdfTextTest(unittest.TestCase):
    def test_sample_references_are_ordered_and_grouped(self):
        fixture = ROOT / "examples" / "pg_0007.pdf"
        if not fixture.exists():
            self.skipTest("examples/pg_0007.pdf fixture is not present")

        text = extract_document_text(str(fixture))
        references = [part.strip() for part in text.split("\n\n") if part.strip()]

        self.assertEqual(26, len(references))
        self.assertTrue(references[0].startswith("[1] Mah Akgun"))
        self.assertTrue(references[-1].startswith("[26]"))
        self.assertIn("Vol. 13. John Wiley", references[20])
        self.assertIn("12 (2025), 149. doi:10.1057/s41599-025-04471-1", references[23])
        self.assertIn("doi:10.1007/s10639-022-11445-2", references[22])
        self.assertFalse(any(reference.startswith("149.") for reference in references))


if __name__ == "__main__":
    unittest.main()
