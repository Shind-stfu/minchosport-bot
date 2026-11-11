#!/usr/bin/env python3
"""Build and score a local, read-only shoe-brand benchmark manifest.

The script never writes to the application database or copies customer images.
Optional CSV prediction files use SHA-256 keys and can be produced by a
separately licensed inference implementation.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote


NEGATIVE_LABEL = "(sin marca legible / sin calzado)"


def normalize(value: str | None) -> str:
    if not value:
        return ""
    value = value.casefold().replace("&", " and ")
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


def brand_from_label(value: str | None) -> str | None:
    """Map SoleMatch model slugs and brand labels to canonical brands."""
    if not value or not value.strip():
        return None
    label = normalize(value).replace(" ", "_")
    # Check Jordan before the broader Nike prefix; Jordan is a separate brand
    # for this project even when the model label starts with nike_air_jordan_.
    if label.startswith(("nike_air_jordan_", "air_jordan_", "jordan_")) or label in {"jordan", "air_jordan"}:
        return "Jordan"
    prefixes = [
        (("new_balance_", "newbalance_", "nb_", "new_balance"), "New Balance"),
        (("adidas_", "adidas"), "Adidas"),
        (("nike_", "nike"), "Nike"),
        (("puma_", "puma"), "Puma"),
        (("converse_", "converse"), "Converse"),
        (("vans_", "vans"), "Vans"),
        (("reebok_", "reebok"), "Reebok"),
        (("asics_", "asics"), "Asics"),
        (("saucony_", "saucony"), "Saucony"),
    ]
    for starts, brand in prefixes:
        if label.startswith(starts):
            return brand
    direct = {
        "jordan": "Jordan", "air jordan": "Jordan", "new balance": "New Balance",
        "adidas": "Adidas", "nike": "Nike", "puma": "Puma", "converse": "Converse",
        "vans": "Vans", "reebok": "Reebok", "asics": "Asics", "saucony": "Saucony",
    }
    return direct.get(normalize(value)) or value.strip()


def open_database_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError(f"No existe la base local: {path}")
    uri = f"file:{quote(path.resolve().as_posix(), safe='/:')}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def load_samples(connection: sqlite3.Connection, media_directory: Path):
    rows = connection.execute(
        """
        SELECT l.media_asset_id AS asset_id, l.expected_brand, l.split,
               m.sha256, m.file_name, e.predicted_brand AS integrated_prediction,
               e.source_predictions_json
        FROM shoe_brand_labels l
        JOIN media_assets m ON m.id=l.media_asset_id
        LEFT JOIN shoe_brand_evaluation_samples e
          ON e.media_asset_id=l.media_asset_id AND e.split='holdout'
        ORDER BY l.reviewed_at, l.media_asset_id
        """
    ).fetchall()

    hash_brands: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in rows:
        if row["sha256"] and row["expected_brand"]:
            hash_brands[(row["split"], row["sha256"])].add(normalize(row["expected_brand"]))
    conflict_hashes = {
        sha for (split, sha), brands in hash_brands.items()
        if split == "holdout" and len(brands) > 1
    }

    seen_holdout: set[str] = set()
    holdouts = []
    references_by_hash: dict[str, sqlite3.Row] = {}
    omitted = Counter()
    for row in rows:
        sha = row["sha256"] or ""
        media_path = media_directory / row["file_name"]
        if not sha:
            omitted["missing_sha256"] += 1
            continue
        if not media_path.is_file():
            omitted["missing_media"] += 1
            continue
        if row["split"] == "holdout":
            if sha in conflict_hashes:
                omitted["conflicting_duplicate_labels"] += 1
                continue
            if sha in seen_holdout:
                omitted["duplicate_holdout_images"] += 1
                continue
            seen_holdout.add(sha)
            holdouts.append({
                "asset_id": row["asset_id"], "sha256": sha, "expected": row["expected_brand"],
                "path": str(media_path.resolve()), "integrated_prediction": row["integrated_prediction"],
                "source_predictions_json": row["source_predictions_json"] or "{}",
            })
        elif row["split"] == "reference" and row["expected_brand"]:
            if sha not in references_by_hash:
                references_by_hash[sha] = row
            else:
                omitted["duplicate_reference_images"] += 1

    # A holdout image and every byte-identical copy are forbidden from the reference catalog.
    for sha in seen_holdout.intersection(references_by_hash):
        del references_by_hash[sha]
        omitted["holdout_hash_removed_from_references"] += 1
    references = []
    for sha, row in references_by_hash.items():
        media_path = media_directory / row["file_name"]
        if media_path.is_file():
            references.append({"asset_id": row["asset_id"], "sha256": sha,
                               "expected": row["expected_brand"], "path": str(media_path.resolve())})
    return holdouts, references, omitted


def load_current_predictions(connection: sqlite3.Connection, holdouts: list[dict]):
    by_hash: dict[str, dict[str, str | None]] = {item["sha256"]: {} for item in holdouts}
    for item in holdouts:
        if item["integrated_prediction"]:
            by_hash[item["sha256"]]["Sugerencia integrada"] = item["integrated_prediction"]
        try:
            sources = json.loads(item["source_predictions_json"])
        except (TypeError, json.JSONDecodeError):
            sources = {}
        if isinstance(sources, dict):
            by_hash[item["sha256"]].update({
                str(name): value if isinstance(value, str) and value.strip() else None
                for name, value in sources.items()
            })
    return by_hash


def load_prediction_csv(path: Path) -> dict[str, str | None]:
    predictions: dict[str, str | None] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or "sha256" not in reader.fieldnames:
            raise ValueError(f"{path}: se requiere la columna sha256")
        prediction_column = next((name for name in ("brand", "prediction", "model") if name in reader.fieldnames), None)
        if not prediction_column:
            raise ValueError(f"{path}: agrega una columna brand, prediction o model")
        for row in reader:
            sha = (row.get("sha256") or "").strip().lower()
            if not re.fullmatch(r"[0-9a-f]{64}", sha):
                continue
            raw = (row.get(prediction_column) or "").strip()
            if sha in predictions and predictions[sha] != (brand_from_label(raw) if raw else None):
                raise ValueError(f"{path}: predicciones incompatibles repetidas para {sha[:12]}")
            predictions[sha] = brand_from_label(raw) if raw else None
    return predictions


def score_predictions(holdouts: list[dict], predictions: dict[str, str | None]):
    by_expected: dict[str, list[dict]] = defaultdict(list)
    confusion: Counter[tuple[str, str]] = Counter()
    predicted_count = correct_count = 0
    for item in holdouts:
        expected = brand_from_label(item["expected"]) if item["expected"] else None
        prediction = brand_from_label(predictions.get(item["sha256"]))
        key = expected or NEGATIVE_LABEL
        by_expected[key].append({"prediction": prediction, "expected": expected})
        confusion[(key, prediction or "(abstención)")] += 1
        if prediction:
            predicted_count += 1
            if expected and normalize(prediction) == normalize(expected):
                correct_count += 1
    precision = correct_count / predicted_count if predicted_count else None
    coverage = predicted_count / len(holdouts) if holdouts else None
    per_expected = {}
    for brand, samples in sorted(by_expected.items()):
        selected = [sample for sample in samples if sample["prediction"]]
        correct = sum(bool(sample["prediction"] and sample["expected"]
                           and normalize(sample["prediction"]) == normalize(sample["expected"])) for sample in selected)
        per_expected[brand] = {
            "examples": len(samples),
            "predicted": len(selected),
            "correct": int(correct),
            "recall": (int(correct) / len(samples)) if samples and brand != NEGATIVE_LABEL else None,
        }
    return {
        "evaluation_examples": len(holdouts), "predictions": predicted_count, "correct": correct_count,
        "precision": precision, "coverage": coverage, "per_expected_brand": per_expected,
        "confusion": [{"expected": expected, "predicted": predicted, "count": count}
                      for (expected, predicted), count in sorted(confusion.items())],
    }


def write_manifest(path: Path, holdouts: list[dict], references: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    holdout_hashes = {item["sha256"] for item in holdouts}
    rows = [{"split": "reference", **item} for item in references if item["sha256"] not in holdout_hashes]
    rows.extend({"split": "holdout", **item} for item in holdouts)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path,
                        help="Carpeta de modo de la app: contiene business.sqlite y media/.")
    parser.add_argument("--output", type=Path, default=Path("data/solematch-pilot/report.json"))
    parser.add_argument("--manifest", type=Path, default=Path("data/solematch-pilot/manifest.jsonl"))
    parser.add_argument("--clip-predictions", type=Path)
    parser.add_argument("--resnet-predictions", type=Path)
    args = parser.parse_args()

    db_path = args.data_dir / "business.sqlite"
    connection = open_database_read_only(db_path)
    try:
        all_labels = connection.execute("SELECT split, expected_brand FROM shoe_brand_labels").fetchall()
        total_media_count = connection.execute("SELECT COUNT(*) FROM media_assets").fetchone()[0]
        holdouts, references, omitted = load_samples(connection, args.data_dir / "media")
        current = load_current_predictions(connection, holdouts)
    finally:
        connection.close()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_manifest(args.manifest, holdouts, references)
    candidates: dict[str, dict[str, str | None]] = {}
    for source in sorted({name for sample in current.values() for name in sample}):
        candidates[source] = {sha: sample.get(source) for sha, sample in current.items()}
    if args.clip_predictions:
        candidates["SoleMatch CLIP"] = load_prediction_csv(args.clip_predictions)
    if args.resnet_predictions:
        candidates["SoleMatch ResNet50 triplet"] = load_prediction_csv(args.resnet_predictions)

    counts = Counter(label["split"] for label in all_labels)
    labeled_negatives = sum(1 for label in all_labels if label["expected_brand"] is None)
    report = {
        "benchmark": "solematch-pilot-v1",
        "read_only_database": True,
        "photo_counts": {"all_media": total_media_count, "verified_labels": len(all_labels),
                         "unlabeled_photos": max(0, total_media_count - len(all_labels))},
        "label_counts": {"reference": counts["reference"], "holdout": counts["holdout"],
                         "negative_labels": labeled_negatives},
        "usable_counts": {"holdout": len(holdouts), "distinct_reference_images": len(references)},
        "omitted": dict(omitted),
        "metrics": {name: score_predictions(holdouts, predictions) for name, predictions in sorted(candidates.items())},
        "solematch_status": {
            "clip": "evaluated_from_csv" if args.clip_predictions else "integrated_in_platform",
            "resnet_triplet": "evaluated_from_csv" if args.resnet_predictions else "blocked",
            "blocker": "El repositorio upstream no incluye licencia de código ni checkpoint ResNet50. La plataforma integra el baseline CLIP MIT de Xenova sobre sus referencias verificadas, no el checkpoint triplet de SoleMatch.",
            "note": "Las métricas publicadas de Recall@1 son de búsqueda de modelo en un catálogo cerrado y no equivalen a precisión de marca.",
        },
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, sqlite3.Error, ValueError) as error:
        print(f"Error en el piloto SoleMatch: {error}", file=sys.stderr)
        raise SystemExit(2)
