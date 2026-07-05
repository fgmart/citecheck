import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from extract_pdf_text import extract_document_text


class ExtractPdfTextTest(unittest.TestCase):
    def references_from_fixture(self, filename):
        fixture = ROOT / "examples" / filename
        if not fixture.exists():
            self.skipTest(f"examples/{filename} fixture is not present")

        text = extract_document_text(str(fixture))
        return [part.strip() for part in text.split("\n\n") if part.strip()]

    def test_sample_references_are_ordered_and_grouped(self):
        references = self.references_from_fixture("pg_0007.pdf")

        self.assertEqual(26, len(references))
        self.assertTrue(references[0].startswith("[1] Mah Akgun"))
        self.assertTrue(references[-1].startswith("[26]"))
        self.assertIn("Vol. 13. John Wiley", references[20])
        self.assertIn("12 (2025), 149. doi:10.1057/s41599-025-04471-1", references[23])
        self.assertIn("doi:10.1007/s10639-022-11445-2", references[22])
        self.assertFalse(any(reference.startswith("149.") for reference in references))

    def test_references_starting_in_right_column_do_not_absorb_left_body_text(self):
        references = self.references_from_fixture("chemaistry-full.pdf")
        reference_4 = references[3]

        self.assertTrue(reference_4.startswith("[4] Christiane Gresse von Wangenheim"))
        self.assertIn("Matheus F Bertonceli Bueno. 2021.", reference_4)
        self.assertIn("Visual tools for teaching machine learning in K-12", reference_4)
        self.assertNotIn("One of our youngest participants", reference_4)

    def test_full_paper_references_continue_across_two_column_pages(self):
        references = self.references_from_fixture("chemaistry-full.pdf")

        self.assertEqual(22, len(references))
        self.assertIn("DoodleIt: A Novel Tool and Approach for Teaching How CNNs", references[10])
        self.assertNotIn("ChemAIstry: A Novel Software Tool", references[10])
        self.assertIn("Perception, Trust, Attitudes, and Models", references[11])
        self.assertTrue(references[16].startswith("[17] Ismaila Temitayo Sanusi"))
        self.assertTrue(references[21].startswith("[22] Qi Xia"))
        self.assertFalse(any(reference.endswith("797") or reference.endswith("798") for reference in references))

    def test_vibebuilder_full_paper_extracts_numbered_references(self):
        references = self.references_from_fixture("VibeBuilder-full.pdf")

        self.assertEqual(26, len(references))
        self.assertTrue(references[0].startswith("[1] Mah Akgun"))
        self.assertTrue(references[25].startswith("[26]"))
        self.assertIn("doi:10.3102/0034654317710096", references[4])


if __name__ == "__main__":
    unittest.main()
