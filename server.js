require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const rateLimit = require("express-rate-limit");

const {
  ROBOFLOW_API_KEY,
  ROBOFLOW_MODEL_ID,
  DEMO_TOKEN,
  MIN_CONFIDENCE = "0.5",
  DROWSY_CLASSES = "drowsy,fatigue",
  AWAKE_CLASSES = "awake",
  DEBUG_RAW = "0",
  PORT = 3000,
} = process.env;

const toSet = (s) =>
  new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
const drowsySet = toSet(DROWSY_CLASSES);
const awakeSet = toSet(AWAKE_CLASSES);
const minConf = Number(MIN_CONFIDENCE) || 0.5;

for (const [k, v] of Object.entries({ ROBOFLOW_API_KEY, ROBOFLOW_MODEL_ID, DEMO_TOKEN })) {
  if (!v) console.warn(`WARNING: ${k} is not set`);
}

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// Static page is public; the API is not.
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

function tokenOk(req) {
  if (!DEMO_TOKEN) return false;
  const given = Buffer.from(String(req.get("x-demo-token") || ""));
  const real = Buffer.from(DEMO_TOKEN);
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}

// Handles detection (array), single-label classification (array + top)
// and multi-label classification (object keyed by class).
function extractPredictions(data) {
  const p = data && data.predictions;
  if (Array.isArray(p)) {
    return p.map((x) => ({
      cls: String(x.class || x.class_name || "").toLowerCase(),
      conf: Number(x.confidence) || 0,
    }));
  }
  if (p && typeof p === "object") {
    return Object.entries(p).map(([k, v]) => ({
      cls: k.toLowerCase(),
      conf: Number(v && v.confidence) || 0,
    }));
  }
  return [];
}

function classify(preds) {
  const strong = preds.filter((x) => x.conf >= minConf);
  if (strong.length === 0) return { state: "UNKNOWN", best: null };
  const best = strong.reduce((a, b) => (b.conf > a.conf ? b : a));
  if (drowsySet.has(best.cls)) return { state: "DROWSY", best };
  if (awakeSet.has(best.cls)) return { state: "AWAKE", best };
  return { state: "UNKNOWN", best };
}

app.post("/api/detect", limiter, (req, res, next) => {
  if (!tokenOk(req)) return res.status(401).json({ error: "Unauthorized" });
  next();
}, upload.single("frame"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image received" });
    if (!ROBOFLOW_API_KEY || !ROBOFLOW_MODEL_ID) {
      return res.status(500).json({ error: "Server not configured" });
    }

    const imageBase64 = req.file.buffer.toString("base64");

    const response = await axios.post(
      `https://serverless.roboflow.com/${ROBOFLOW_MODEL_ID}`,
      imageBase64,
      {
        headers: {
          Authorization: `Bearer ${ROBOFLOW_API_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      }
    );

    if (DEBUG_RAW === "1") console.log("RAW:", JSON.stringify(response.data));

    const preds = extractPredictions(response.data);
    const { state, best } = classify(preds);

    res.json({
      state, // AWAKE | DROWSY | UNKNOWN
      best: best ? { class: best.cls, confidence: best.conf } : null,
      count: preds.length,
    });
  } catch (error) {
    console.error("Inference error:", error.response?.status, error.response?.data || error.message);
    res.status(502).json({ error: "Model inference failed" });
  }
});

// Multer / other errors -> JSON
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || "Bad request" });
  next();
});

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
