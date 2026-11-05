# HeritageLens — Digital Restoration of Heritage Paintings

A student-project web app with a Flask backend, SQLite database, TensorFlow/Keras CNN hook, manual damage-mask editor, OpenCV inpainting preview, and a Three.js interactive 3D image-panel viewer.

## Important limitations

- Your existing CNN was trained on **224×224 patches**. The app samples five square patches from an uploaded image and summarizes the sigmoid scores. This is a rough image-level indicator, **not pixel-level damage detection** and not a calibrated whole-painting confidence.
- Your reported test confusion matrix predicted every test image as damaged. Do not describe the current accuracy as proof of reliable classification. Retrain/evaluate with painting-level splits and better-balanced/verified examples before claiming performance.
- The restoration preview is **OpenCV Telea inpainting** on regions that a user paints into the mask. It fills pixels using nearby context and cannot know the historically correct original pigment or missing subject details. It is not a generative AI restoration model.
- The 3D viewer displays the original and preview as shallow textured panels. It does not infer the painting's real physical geometry or depth.
- The original image is retained unchanged; the preview is stored as a separate file.

## 1. Setup

Python 3.10 or 3.11 is recommended. From this directory:

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate
pip install -r requirements.txt
```

To enable CNN predictions, install a TensorFlow version compatible with your Python and operating system. For example, in a supported environment:

```bash
pip install tensorflow
```

Copy your trained model into:

```text
models/artinsight_damage_cnn_final.keras
```

Or set `MODEL_PATH` to its actual path. Do not rename a different model and assume it is compatible; it must be the saved Keras model from your training pipeline and must expect 224×224 RGB inputs scaled to 0–1 with a sigmoid output where 1 means damaged.

## 2. Run

```bash
python app.py
```

Open `http://127.0.0.1:5000` in your browser. The first run creates `heritage_restoration.db` automatically. Uploaded images and generated previews are saved in `uploads/`.

## 3. Workflow

1. Upload a painting photo.
2. Click **Analyze damage**. If the model file is missing, the app still opens and reports that classification is unavailable.
3. Paint red strokes over the damaged regions in the mask editor. The strokes become a binary mask sent to the backend.
4. Click **Generate restoration preview**. The server runs OpenCV inpainting and saves a separate preview.
5. Inspect the original and preview in the interactive 3D viewer; drag to rotate and scroll to zoom.
6. Review past records in the history section.

## 4. Database

SQLite table `restorations` records timestamp, original filename/path, predicted label, confidence summary, restoration preview path, and notes. This is a local demonstration app without authentication; do not expose it publicly or upload confidential images without adding access controls.

## 5. API

- `GET /api/health` — app and model status
- `POST /api/analyze` — multipart field `image`
- `POST /api/restore/<record_id>` — multipart fields `mask` (PNG, white strokes) and optional `radius` (1–15)
- `GET /api/history` — recent saved records

## Suggested next research step

For a more scientifically defensible system, train a segmentation model from the ArtInsight polygon annotations to predict a damage mask, then evaluate by holding out entire original paintings. For convincing reconstruction of missing content, use a dedicated inpainting/generative restoration model and clearly distinguish its synthesized pixels from observed historical evidence.
