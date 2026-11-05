
"""Digital Restoration of Heritage Paintings - Flask backend.

The CNN is optional at startup. Put the trained .keras file in ./models/
or set MODEL_PATH to its full path.

The model is a patch classifier, not a damage-segmentation model. Restoration
uses a user-drawn mask + OpenCV inpainting; it is only an approximation.
"""
from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

# app.py location is the project root.
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
MODEL_DIR = BASE_DIR / "models"
DB_PATH = BASE_DIR / "heritage_restoration.db"

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp"}
IMAGE_SIZE = (224, 224)
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "20"))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
app.config["UPLOAD_FOLDER"] = str(UPLOAD_DIR)

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MODEL_DIR.mkdir(parents=True, exist_ok=True)

_model = None
_model_error = None


def db_connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db_connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS restorations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                original_path TEXT NOT NULL,
                restored_path TEXT,
                prediction TEXT,
                confidence REAL,
                notes TEXT
            )
        """)


def allowed_file(filename: str) -> bool:
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS
    )


def safe_image_name(original: str) -> str:
    suffix = Path(secure_filename(original)).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
        suffix = ".png"
    return f"{uuid.uuid4().hex}{suffix}"


def get_model_path() -> Path:
    """MODEL_PATH can be absolute or relative to this app.py's directory."""
    configured = os.getenv("MODEL_PATH")

    if configured:
        path = Path(configured).expanduser()
        return path if path.is_absolute() else (BASE_DIR / path).resolve()

    return MODEL_DIR / "artinsight_damage_cnn_final.keras"


def load_model_if_available():
    global _model, _model_error

    if _model is not None:
        return _model

    path = get_model_path()

    if not path.is_file():
        _model_error = (
            f"Model file not found at {path}. Put "
            "'artinsight_damage_cnn_final.keras' in the models folder "
            "or set MODEL_PATH to the correct .keras file."
        )
        return None

    try:
        import tensorflow as tf

        _model = tf.keras.models.load_model(path)
        _model_error = None
        app.logger.info("CNN loaded successfully from %s", path)
        return _model

    except Exception as exc:
        _model_error = f"Could not load model from {path}: {exc}"
        app.logger.exception("CNN model loading failed")
        return None


def image_to_rgb(path: Path) -> Image.Image:
    with Image.open(path) as im:
        return ImageOps.exif_transpose(im).convert("RGB")


def predict_damage(path: Path):
    """Predict using five square patches.

    Training directory class order is alphabetical:
      damaged -> class 0
      not_damaged -> class 1

    A sigmoid trained with binary labels therefore estimates P(not_damaged).
    """
    model = load_model_if_available()

    if model is None:
        return {
            "available": False,
            "message": _model_error,
            "label": "Model unavailable",
            "confidence": None,
        }

    try:
        im = image_to_rgb(path)
        w, h = im.size
        side = min(w, h)

        positions = [
            (0, 0),
            (max(0, w - side), 0),
            (0, max(0, h - side)),
            (max(0, w - side), max(0, h - side)),
            ((w - side) // 2, (h - side) // 2),
        ]

        patches = []

        for x, y in positions:
            crop = im.crop((x, y, x + side, y + side))
            crop = crop.resize(IMAGE_SIZE)
            patches.append(np.asarray(crop, dtype=np.float32) / 255.0)

        batch = np.stack(patches)
        scores = np.asarray(
            model.predict(batch, verbose=0)
        ).reshape(-1)

        # Sigmoid score is probability of class 1 = not_damaged.
        not_damaged_score = float(np.mean(scores))
        damage_score = 1.0 - not_damaged_score

        if damage_score >= 0.5:
            label = "Damaged"
            confidence = damage_score
        else:
            label = "Likely not damaged"
            confidence = not_damaged_score

        return {
            "available": True,
            "label": label,
            "confidence": round(confidence * 100, 2),
            "damage_score": round(damage_score * 100, 2),
            "not_damaged_score": round(not_damaged_score * 100, 2),
            "patch_scores": [
                round(float(1.0 - s) * 100, 2) for s in scores
            ],
            "message": (
                "Patch-level estimate only, not damage segmentation. "
                "Validate using unseen paintings; model results may be "
                "unreliable if the training data are imbalanced."
            ),
        }

    except Exception as exc:
        app.logger.exception("Prediction failed")

        return {
            "available": False,
            "message": f"Prediction failed: {exc}",
            "label": "Prediction unavailable",
            "confidence": None,
        }


@app.get("/")
def index():
    model = load_model_if_available()

    return render_template(
        "index.html",
        model_ready=model is not None,
        model_message=_model_error or "CNN loaded successfully",
    )


@app.get("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename, as_attachment=False)


@app.get("/api/health")
def health():
    model = load_model_if_available()

    return jsonify({
        "ok": True,
        "model_ready": model is not None,
        "model_message": _model_error,
        "database": DB_PATH.name,
    })


@app.post("/api/analyze")
def analyze():
    file = request.files.get("image")

    if not file or not file.filename:
        return jsonify({"error": "Choose an image first."}), 400

    if not allowed_file(file.filename):
        return jsonify({
            "error": (
                "Unsupported file type. Use PNG, JPG, JPEG, WEBP or BMP."
            )
        }), 400

    original_filename = secure_filename(file.filename) or "painting"
    stored_name = safe_image_name(original_filename)
    stored_path = UPLOAD_DIR / stored_name

    try:
        file.save(stored_path)
        im = image_to_rgb(stored_path)

        if im.width < 16 or im.height < 16:
            raise ValueError("Image is too small")

        normalized_name = f"{Path(stored_name).stem}.png"
        normalized_path = UPLOAD_DIR / normalized_name

        im.save(normalized_path, format="PNG")

        if normalized_path != stored_path:
            stored_path.unlink(missing_ok=True)

        stored_name = normalized_name
        stored_path = normalized_path

    except Exception as exc:
        stored_path.unlink(missing_ok=True)
        return jsonify({"error": f"Invalid image: {exc}"}), 400

    result = predict_damage(stored_path)

    with db_connect() as conn:
        cur = conn.execute(
            """INSERT INTO restorations
               (created_at, original_filename, original_path,
                prediction, confidence, notes)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                datetime.now(timezone.utc).isoformat(),
                original_filename,
                stored_name,
                result.get("label"),
                result.get("confidence"),
                result.get("message"),
            ),
        )

        record_id = cur.lastrowid

    result.update({
        "id": record_id,
        "image_url": f"/uploads/{stored_name}",
        "filename": original_filename,
    })

    return jsonify(result)


@app.post("/api/restore/<int:record_id>")
def restore(record_id):
    """Inpaint a user-drawn binary mask; white pixels mark areas to repair."""
    with db_connect() as conn:
        record = conn.execute(
            "SELECT * FROM restorations WHERE id=?",
            (record_id,),
        ).fetchone()

    if record is None:
        return jsonify({"error": "Analysis record not found."}), 404

    mask_file = request.files.get("mask")

    if not mask_file or not mask_file.filename:
        return jsonify({
            "error": "Draw over the damaged areas in the mask editor first."
        }), 400

    try:
        import cv2

        source_path = UPLOAD_DIR / record["original_path"]
        source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)

        if source is None:
            raise ValueError("Could not read original image")

        mask_image = Image.open(mask_file.stream).convert("L")
        mask = np.array(mask_image)

        if mask.shape[:2] != source.shape[:2]:
            mask = cv2.resize(
                mask,
                (source.shape[1], source.shape[0]),
                interpolation=cv2.INTER_NEAREST,
            )

        mask = np.where(mask > 32, 255, 0).astype(np.uint8)

        if cv2.countNonZero(mask) == 0:
            return jsonify({
                "error": (
                    "The mask is empty. Paint over damaged regions "
                    "using the brush."
                )
            }), 400

        mask = cv2.dilate(
            mask,
            np.ones((3, 3), np.uint8),
            iterations=1,
        )

        try:
            radius = int(request.form.get("radius", "5"))
        except ValueError:
            radius = 5

        radius = max(1, min(radius, 15))

        restored = cv2.inpaint(
            source,
            mask,
            radius,
            cv2.INPAINT_TELEA,
        )

        out_name = f"restored_{uuid.uuid4().hex}.png"
        cv2.imwrite(str(UPLOAD_DIR / out_name), restored)

        with db_connect() as conn:
            conn.execute(
                """UPDATE restorations
                   SET restored_path=?,
                       notes=COALESCE(notes,'') || ?
                   WHERE id=?""",
                (
                    out_name,
                    " | OpenCV inpainting preview; "
                    "not verified reconstruction",
                    record_id,
                ),
            )

        return jsonify({
            "restored_url": f"/uploads/{out_name}",
            "message": (
                "Approximate inpainting preview created. Have a "
                "conservation specialist inspect it before treating "
                "it as a restoration record."
            ),
        })

    except ImportError:
        return jsonify({
            "error": (
                "OpenCV is not installed. Run: "
                "pip install opencv-python-headless"
            )
        }), 500

    except Exception as exc:
        app.logger.exception("Restoration failed")
        return jsonify({"error": f"Restoration failed: {exc}"}), 500


@app.get("/api/history")
def history():
    with db_connect() as conn:
        rows = conn.execute(
            """SELECT id, created_at, original_filename, original_path,
                      restored_path, prediction, confidence, notes
               FROM restorations ORDER BY id DESC LIMIT 50"""
        ).fetchall()

    return jsonify([
        {
            "id": r["id"],
            "created_at": r["created_at"],
            "filename": r["original_filename"],
            "image_url": f"/uploads/{r['original_path']}",
            "restored_url": (
                f"/uploads/{r['restored_path']}"
                if r["restored_path"] else None
            ),
            "prediction": r["prediction"],
            "confidence": r["confidence"],
            "notes": r["notes"],
        }
        for r in rows
    ])


@app.errorhandler(413)
def too_large(_error):
    return jsonify({
        "error": (
            f"File too large. Maximum upload size is {MAX_UPLOAD_MB} MB."
        )
    }), 413


init_db()


if __name__ == "__main__":
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=False,
    )
