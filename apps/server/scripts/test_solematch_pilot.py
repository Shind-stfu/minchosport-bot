import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("solematch_pilot.py")
SPEC = importlib.util.spec_from_file_location("solematch_pilot", SCRIPT)
pilot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pilot)


class SoleMatchPilotTests(unittest.TestCase):
    def test_model_slug_mapping_keeps_jordan_separate_from_nike(self):
        self.assertEqual(pilot.brand_from_label("nike_air_jordan_1_high"), "Jordan")
        self.assertEqual(pilot.brand_from_label("jordan_1_og"), "Jordan")
        self.assertEqual(pilot.brand_from_label("nike_air_max_95"), "Nike")
        self.assertEqual(pilot.brand_from_label("nb_327"), "New Balance")

    def test_metrics_count_abstentions_and_negative_labels(self):
        samples = [
            {"sha256": "a", "expected": "Jordan"},
            {"sha256": "b", "expected": "Adidas"},
            {"sha256": "c", "expected": None},
        ]
        result = pilot.score_predictions(samples, {"a": "Nike", "c": "Jordan"})
        self.assertEqual(result["evaluation_examples"], 3)
        self.assertEqual(result["predictions"], 2)
        self.assertEqual(result["correct"], 0)
        self.assertEqual(result["precision"], 0)
        self.assertAlmostEqual(result["coverage"], 2 / 3)

    def test_holdout_duplicates_and_reference_copy_are_excluded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            media.mkdir()
            for name in ("holdout.jpg", "duplicate.jpg", "reference.jpg", "other.jpg"):
                (media / name).write_bytes(b"fixture")
            db = sqlite3.connect(":memory:")
            db.row_factory = sqlite3.Row
            db.executescript("""
              CREATE TABLE shoe_brand_labels(media_asset_id TEXT, expected_brand TEXT, split TEXT, reviewed_at TEXT);
              CREATE TABLE media_assets(id TEXT, sha256 TEXT, file_name TEXT);
              CREATE TABLE shoe_brand_evaluation_samples(media_asset_id TEXT, split TEXT, predicted_brand TEXT, source_predictions_json TEXT);
            """)
            db.executemany("INSERT INTO media_assets VALUES (?,?,?)", [
                ("h1", "a" * 64, "holdout.jpg"), ("h2", "a" * 64, "duplicate.jpg"),
                ("r1", "a" * 64, "reference.jpg"), ("r2", "b" * 64, "other.jpg"),
            ])
            db.executemany("INSERT INTO shoe_brand_labels VALUES (?,?,?,?)", [
                ("h1", "Jordan", "holdout", "1"), ("h2", "Jordan", "holdout", "2"),
                ("r1", "Jordan", "reference", "3"), ("r2", "Nike", "reference", "4"),
            ])
            holdouts, references, omitted = pilot.load_samples(db, media)
            self.assertEqual([item["sha256"] for item in holdouts], ["a" * 64])
            self.assertEqual([item["sha256"] for item in references], ["b" * 64])
            self.assertEqual(omitted["duplicate_holdout_images"], 1)
            self.assertEqual(omitted["holdout_hash_removed_from_references"], 1)
            db.close()


if __name__ == "__main__":
    unittest.main()
