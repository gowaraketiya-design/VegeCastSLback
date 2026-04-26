const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
const db = require("./db");
const { logAdminAction } = require("./utils/adminLogger");

const path = require("path");
const multer = require("multer");
const { execFile } = require("child_process");
const adminAuth = require("./middleware/adminAuth");

const upload = multer({ dest: path.join(__dirname, "../storage/uploads") });

const exportCache = new Map();

// const db = require("./db");
// const { logAdminAction } = require("./utils/adminLogger");


// Middleware
app.use(cors({
  origin: [
    "https://vegecastslfront.vercel.app", // 
    "http://localhost:3000" // for local dev
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));



// Health check (public)
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "Backend is running",
    time: new Date().toISOString(),
  });
});

//db health check
app.get("/api/db-health", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows[0] });
  } catch (err) {
    console.error("DB health error:", err);
    res.status(500).json({ ok: false, message: "DB connection failed" });
  }
});



//dashboard


app.get("/api/public/dashboard-summary", async (req, res) => {
  try {
    // get latest forecast rows for all vegetables
    const [latestRunRows] = await db.query(
      `
      SELECT p.*
      FROM predictions_daily p
      JOIN (
        SELECT target, MAX(created_at) AS latest_created
        FROM predictions_daily
        GROUP BY target
      ) x
        ON p.target = x.target
       AND p.created_at = x.latest_created
      `
    );

    if (!latestRunRows.length) {
      return res.json({
        ok: true,
        averagePrice: null,
        topRiser: null,
        lowestForecast: null,
        vegetableCount: 0,
      });
    }

    // group by target and compute average predicted price per vegetable
    const grouped = {};
    for (const row of latestRunRows) {
      if (!grouped[row.target]) grouped[row.target] = [];
      grouped[row.target].push(Number(row.predicted_value));
    }

    const summaries = Object.entries(grouped).map(([target, values]) => {
      const avg =
        values.reduce((a, b) => a + b, 0) / values.length;

      return {
        target,
        avgPrice: avg,
        first: values[0],
        last: values[values.length - 1],
      };
    });

    // overall average
    const averagePrice =
      summaries.reduce((a, b) => a + b.avgPrice, 0) / summaries.length;

    // top riser = highest increase from first forecast day to last forecast day
    const topRiser = summaries
      .map((s) => ({
        target: s.target,
        rise: s.last - s.first,
      }))
      .sort((a, b) => b.rise - a.rise)[0] || null;

    // lowest forecasted average
    const lowestForecast = summaries
      .map((s) => ({
        target: s.target,
        avgPrice: s.avgPrice,
      }))
      .sort((a, b) => a.avgPrice - b.avgPrice)[0] || null;

    res.json({
      ok: true,
      averagePrice: Number(averagePrice.toFixed(1)),
      topRiser: topRiser
        ? {
            target: topRiser.target,
            rise: Number(topRiser.rise.toFixed(1)),
          }
        : null,
      lowestForecast: lowestForecast
        ? {
            target: lowestForecast.target,
            avgPrice: Number(lowestForecast.avgPrice.toFixed(1)),
          }
        : null,
      vegetableCount: summaries.length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Failed to load dashboard summary" });
  }
});



app.get("/api/public/dashboard-details", async (req, res) => {
  try {
    // latest forecast rows for each target
    const [latestRows] = await db.query(`
      SELECT p.*
      FROM predictions_daily p
      JOIN (
        SELECT target, MAX(created_at) AS latest_created
        FROM predictions_daily
        GROUP BY target
      ) x
        ON p.target = x.target
       AND p.created_at = x.latest_created
      ORDER BY p.target, p.forecast_date ASC
    `);

    const grouped = {};
    for (const row of latestRows) {
      if (!grouped[row.target]) grouped[row.target] = [];
      grouped[row.target].push({
        date: row.forecast_date,
        predicted: Number(row.predicted_value),
      });
    }

    const movers = Object.entries(grouped).map(([target, rows]) => {
      const first = rows[0]?.predicted ?? null;
      const last = rows[rows.length - 1]?.predicted ?? null;
      const avg =
        rows.length > 0
          ? rows.reduce((a, b) => a + b.predicted, 0) / rows.length
          : null;

      return {
        target,
        first,
        last,
        avgPrice: avg != null ? Number(avg.toFixed(1)) : null,
        rise:
          first != null && last != null
            ? Number((last - first).toFixed(1))
            : null,
      };
    });

    const topMovers = [...movers].sort((a, b) => (b.rise ?? -9999) - (a.rise ?? -9999));

    // actual historical series for potatoes (dashboard default)
    const [histRows] = await db.query(`
      SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
      FROM train_ready_daily
      WHERE JSON_EXTRACT(values_json, '$."Import Potatoes"') IS NOT NULL
      ORDER BY date DESC
      LIMIT 30
    `);

    histRows.reverse();

    const priceTrend = histRows.map((r) => {
      const v =
        typeof r.values_json === "string"
          ? JSON.parse(r.values_json)
          : r.values_json;

      return {
        date: r.date,
        value: v?.["Import Potatoes"] ?? null,
      };
    });

    res.json({
      ok: true,
      topMovers,
      priceTrend,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Failed to load dashboard details" });
  }
});



// Admin login (public)
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    await logAdminAction({
      req,
      admin_username: username || "unknown",
      action: "login",
      status: "failed",
      details: "Missing credentials",
    });
    return res.status(400).json({ ok: false, message: "Missing credentials" });
  }

  const valid =
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD;

  // console.log("ENV USER:", username);
  // console.log("ENV PASS:", [password]);

  if (!valid) {
    await logAdminAction({
      req,
      admin_username: username,
      action: "login",
      status: "failed",
      details: "Invalid credentials",
    });
    return res.status(401).json({ ok: false, message: "Invalid credentials" });
  }

  const token = jwt.sign({ role: "admin", username }, process.env.JWT_SECRET, {
    expiresIn: "8h",
  });

  await logAdminAction({
    req,
    admin_username: username,
    action: "login",
    status: "success",
    details: "Admin login success",
  });

  res.json({ ok: true, token });
});


// Protected admin route
// const adminAuth = require("./middleware/adminAuth");

app.get("/api/admin/me", adminAuth, (req, res) => {
  res.json({ ok: true, admin: req.admin });
});

app.get("/api/admin/logs", adminAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, admin_username, action, details, status, created_at
       FROM admin_logs
       ORDER BY created_at DESC
       LIMIT 20`
    );
    res.json({ ok: true, logs: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Failed to fetch logs" });
  }
});

//upload data preview 
app.post("/api/admin/upload/preview",
  adminAuth,
  upload.fields([
    { name: "vegFile", maxCount: 1 },
    { name: "externalFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const vegPath = req.files?.vegFile?.[0]?.path;
      const exPath = req.files?.externalFile?.[0]?.path;

      if (!vegPath || !exPath) {
        return res
          .status(400)
          .json({ ok: false, message: "Both files required" });
      }

      // Generate export file info
      const exportId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const exportFilename = `train_ready_${exportId}.xlsx`;
      const exportPath = path.join(
        __dirname,
        "../storage/uploads",
        exportFilename
      );

      const pyScript = path.join(__dirname, "python/preprocess_merge.py");

      execFile(
        "python", // change to "py" if python not found on your Windows
        [pyScript, vegPath, exPath, exportPath],
        { maxBuffer: 1024 * 1024 * 50 }, // 50MB buffer for stdout
        (err, stdout, stderr) => {
          if (err) {
            console.error("PY ERR:", err);
            console.error("PY STDERR:", stderr);
            return res
              .status(500)
              .json({ ok: false, message: "Preprocess failed" });
          }

          try {
            const payload = JSON.parse(stdout);

            // store export file so it can be downloaded later
            exportCache.set(exportId, {
              path: exportPath,
              filename: exportFilename,
              createdAt: Date.now(),
            });

            return res.json({
              ok: true,
              exportId,
              exportFilename,
              stats: payload.stats,
              preview: payload.preview,
              full: payload.full, // keep for now so confirm can work
            });
          } catch (parseErr) {
            console.error("JSON parse failed:", parseErr);
            console.error("PY STDOUT (first 500):", stdout?.slice(0, 500));
            console.error("PY STDERR:", stderr);
            return res.status(500).json({
              ok: false,
              message: "Python returned invalid JSON",
            });
          }
        }
      );
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, message: "Server error" });
    }
  }
);


app.get("/api/admin/upload/latest-date", adminAuth, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastUploadedDate
       FROM train_ready_daily`
    );

    return res.json({
      ok: true,
      lastUploadedDate: row?.lastUploadedDate || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to load latest uploaded date" });
  }
});


app.get("/api/public/model-performance", async (req, res) => {
  try {
    const targets = [
      "Import Potatoes",
      "Import Big Onions",
      "Import Red Onions",
      "Import Chillies",
    ];

    const [rows] = await db.query(
      `SELECT target, model_name, mae, rmse, mape, notes, created_at
       FROM model_performance
       WHERE target IN (?, ?, ?, ?)
       ORDER BY FIELD(target, ?, ?, ?, ?)`,
      [...targets, ...targets]
    );

    return res.json({
      ok: true,
      items: rows.map((r) => ({
        target: r.target,
        modelName: r.model_name,
        mae: Number(r.mae),
        rmse: Number(r.rmse),
        mape: Number(r.mape),
        notes: r.notes || null,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to load model performance" });
  }
});


app.get("/api/admin/upload/export/:id", adminAuth, (req, res) => {
  const id = req.params.id;
  const item = exportCache.get(id);

  if (!item) {
    return res
      .status(404)
      .json({ ok: false, message: "Export not found or expired" });
  }

  return res.download(item.path, item.filename);
});



app.post("/api/admin/upload/confirm", adminAuth, async (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ ok: false, message: "No rows to save" });
    }

    // bulk upsert
    const sql = `
      INSERT INTO train_ready_daily (date, values_json)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        values_json = VALUES(values_json),
        updated_at = CURRENT_TIMESTAMP
    `;

    const values = rows.map((r) => [
      r.date,                       // YYYY-MM-DD
      JSON.stringify(r.values || {}) // includes nulls
    ]);

    await db.query(sql, [values]);

    await logAdminAction({
      req,
      admin_username: req.admin.username,
      action: "upload",
      status: "success",
      details: `Saved ${rows.length} dates into train_ready_daily`,
    });

    res.json({ ok: true, savedDates: rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Save failed" });
  }
});


app.get("/api/admin/predictions/latest", adminAuth, async (req, res) => {
  try {
    const target = req.query.target;

    if (!target) {
      return res.status(400).json({ ok: false, message: "target is required" });
    }

    const [[row]] = await db.query(
      `SELECT 
         DATE_FORMAT(MAX(forecast_date), '%Y-%m-%d') AS lastForecastDate
       FROM predictions_daily
       WHERE target = ?`,
      [target]
    );

    return res.json({
      ok: true,
      target,
      lastForecastDate: row?.lastForecastDate || null,
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to load latest forecast info" });
  }
});



app.get("/api/public/potatoes", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT date, values_json
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Potatoes"') IS NOT NULL
       ORDER BY date ASC
       LIMIT 60`
    );

    const series = rows.map((r) => {
      const v = typeof r.values_json === "string" ? JSON.parse(r.values_json) : r.values_json;
      return {
        date: r.date, // MySQL DATE
        price: v?.["Import Potatoes"] ?? null,
      };
    });

    res.json({ ok: true, series });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Failed to load potatoes" });
  }
});


// app.get("/api/public/predictions/potatoes", async (req, res) => {
//   try {
//     const [rows] = await db.query(
//       `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
//       FROM train_ready_daily
//       WHERE JSON_EXTRACT(values_json, '$."Import Potatoes"') IS NOT NULL
//       ORDER BY date DESC
//       LIMIT 90`
//     );

//     rows.reverse();


//     const series = rows
//       .map((r) => {
//         const v = typeof r.values_json === "string" ? JSON.parse(r.values_json) : r.values_json;
//         return {
//           date: String(r.date).slice(0, 10),
//           price: v?.["Import Potatoes"] ?? null,
//         };
//       })
//       .filter((x) => x.price !== null);

//     if (series.length === 0) {
//       return res.json({ ok: true, series: [], forecast: [] });
//     }

//     const last = series[series.length - 1];
//     const lastDate = new Date(last.date);
//     const lastPrice = Number(last.price);

//     // dummy forecast for next 7 days (same value)
//     const forecast = [];
//     for (let i = 1; i <= 7; i++) {
//       const d = new Date(lastDate);
//       d.setDate(d.getDate() + i);
//       forecast.push({
//         date: d.toISOString().slice(0, 10),
//         predicted: lastPrice,
//       });
//     }

//     res.json({ ok: true, series, forecast });
//   } catch (e) {
//     console.error(e);
//     res.status(500).json({ ok: false, message: "Failed to load predictions" });
//   }
// });


// const { execFile } = require("child_process");
// const path = require("path");



//Predictions Page

app.get("/api/public/predictions", async (req, res) => {
  try {
    const target = req.query.veg || "Import Potatoes";
    const horizon = Number(req.query.horizon || 7);

    // latest run for selected vegetable
    const [[r0]] = await db.query(
      `SELECT run_id
       FROM predictions_daily
       WHERE target = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [target]
    );

    if (!r0?.run_id) {
      return res.json({
        ok: true,
        target,
        model: null,
        runId: null,
        lastActualDate: null,
        volatility: null,
        historyLast5: [],
        forecast: [],
      });
    }

    const runId = r0.run_id;

    const [fcRows] = await db.query(
      `SELECT DATE_FORMAT(forecast_date, '%Y-%m-%d') AS date,
              predicted_value AS predicted,
              lower_95 AS lower,
              upper_95 AS upper,
              model_name
       FROM predictions_daily
       WHERE target = ? AND run_id = ?
       ORDER BY forecast_date ASC
       LIMIT ?`,
      [target, runId, horizon]
    );

    const [histRows] = await db.query(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, ?) IS NOT NULL
       ORDER BY date DESC
       LIMIT 5`,
      [`$."${target}"`]
    );

    histRows.reverse();

    const historyLast5 = histRows.map((r) => {
      const v =
        typeof r.values_json === "string"
          ? JSON.parse(r.values_json)
          : r.values_json;

      return {
        date: r.date,
        value: v?.[target] ?? null,
      };
    });

    const [[lastRow]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, ?) IS NOT NULL`,
      [`$."${target}"`]
    );

    const preds = fcRows
      .map((x) => Number(x.predicted))
      .filter((n) => Number.isFinite(n));

    let volatility = null;
    if (preds.length >= 2) {
      const rets = [];
      for (let i = 1; i < preds.length; i++) {
        rets.push((preds[i] - preds[i - 1]) / preds[i - 1]);
      }
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance =
        rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
      volatility = Math.sqrt(variance);
    }

    return res.json({
      ok: true,
      target,
      model: fcRows[0]?.model_name || null,
      runId,
      lastActualDate: lastRow?.lastDate || null,
      volatility,
      historyLast5,
      forecast: fcRows,
    });
  } catch (e) {
    console.error(e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to load saved predictions" });
  }
});


app.get("/api/public/predictions/potatoes", async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Import Potatoes";

    // latest run_id for this target
    const [[r0]] = await db.query(
      `SELECT run_id
       FROM predictions_daily
       WHERE target = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [target]
    );

    if (!r0?.run_id) {
      return res.json({ ok: true, target, model: "SARIMAX", lastActualDate: null, volatility: null, historyLast5: [], forecast: [] });
    }

    const runId = r0.run_id;

    // forecast rows for that run (limit to horizon)
    const [fcRows] = await db.query(
      `SELECT DATE_FORMAT(forecast_date, '%Y-%m-%d') AS date,
              predicted_value AS predicted,
              lower_95 AS lower,
              upper_95 AS upper,
              model_name
       FROM predictions_daily
       WHERE target = ? AND run_id = ?
       ORDER BY forecast_date ASC
       LIMIT ?`,
      [target, runId, horizon]
    );

    // last 5 actuals (for display)
    const [histRows] = await db.query(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Potatoes"') IS NOT NULL
       ORDER BY date DESC
       LIMIT 5`
    );
    histRows.reverse();
    const historyLast5 = histRows.map((r) => {
      const v = typeof r.values_json === "string" ? JSON.parse(r.values_json) : r.values_json;
      return { date: r.date, value: v?.["Import Potatoes"] ?? null };
    });

    // last actual date
    const [[lastRow]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Potatoes"') IS NOT NULL`
    );

    // volatility from forecast (std of returns)
    const preds = fcRows.map((x) => Number(x.predicted)).filter((n) => Number.isFinite(n));
    let volatility = null;
    if (preds.length >= 2) {
      const rets = [];
      for (let i = 1; i < preds.length; i++) rets.push((preds[i] - preds[i - 1]) / preds[i - 1]);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
      volatility = Math.sqrt(varr);
    }

    return res.json({
      ok: true,
      target,
      model: fcRows[0]?.model_name || "SARIMAX",
      runId,
      lastActualDate: lastRow?.lastDate || null,
      volatility,
      historyLast5,
      forecast: fcRows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to load saved predictions" });
  }
});



app.post("/api/admin/predictions/preview/chillies", adminAuth, async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Import Chillies";
    const modelName = "XGBOOST";

    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Chillies"') IS NOT NULL`
    );
    const lastActualDate = row?.lastDate || null;

    const [histRows] = await db.query(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Chillies"') IS NOT NULL
       ORDER BY date DESC
       LIMIT 15`
    );

    histRows.reverse();

    const recentHistory = histRows.map((r) => {
      const v =
        typeof r.values_json === "string"
          ? JSON.parse(r.values_json)
          : r.values_json;

      return {
        date: r.date,
        "Import Chillies": v?.["Import Chillies"] ?? null,
        "Average Exchange Rate": v?.["Average Exchange Rate"] ?? null,
        "Import Fuel Price": v?.["Import Fuel Price"] ?? null,
      };
    });

    const pyScript = path.join(__dirname, "python", "forecast_chillies_xgb.py");
    const args = [
      String(horizon),
      String(lastActualDate),
      JSON.stringify(recentHistory),
    ];

    const payload = await new Promise((resolve, reject) => {
      execFile(
        "python",
        [pyScript, ...args],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (stderr) console.error("PY STDERR:", stderr);

          let parsed = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }

          if (err) {
            console.error("PY ERR:", err);
            if (stdout) console.error("PY STDOUT:", stdout);
            if (parsed && parsed.ok === false) {
              return reject(new Error(parsed.error || "Forecast failed"));
            }
            return reject(new Error("Forecast failed"));
          }

          if (!parsed) {
            if (stdout) console.error("PY STDOUT:", stdout);
            return reject(new Error("Invalid python output"));
          }

          resolve(parsed);
        }
      );
    });

    if (!payload.ok || !Array.isArray(payload.forecast)) {
      return res.status(500).json({ ok: false, message: "Bad forecast payload" });
    }

    const lastForecastDate =
      payload.forecast.length ? payload.forecast[payload.forecast.length - 1].date : null;

    return res.json({
      ok: true,
      target,
      model: modelName,
      horizon,
      lastActualDate,
      lastForecastDate,
      forecast: payload.forecast,
      volatility: payload.volatility ?? null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to preview predictions" });
  }
});



app.post("/api/admin/predictions/preview/potatoes", adminAuth, async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Import Potatoes";
    const modelName = "XGBOOST";

    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Potatoes"') IS NOT NULL`
    );
    const lastActualDate = row?.lastDate || null;

    const [histRows] = await db.query(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Potatoes"') IS NOT NULL
       ORDER BY date DESC
       LIMIT 15`
    );

    histRows.reverse();

    const recentHistory = histRows.map((r) => {
      const v =
        typeof r.values_json === "string"
          ? JSON.parse(r.values_json)
          : r.values_json;

      return {
        date: r.date,
        "Import Potatoes": v?.["Import Potatoes"] ?? null,
        "Average Exchange Rate": v?.["Average Exchange Rate"] ?? null,
        "Import Fuel Price": v?.["Import Fuel Price"] ?? null,
      };
    });

    const pyScript = path.join(__dirname, "python", "forecast_potatoes_xgb.py");
    const args = [
      String(horizon),
      String(lastActualDate),
      JSON.stringify(recentHistory),
    ];

    const payload = await new Promise((resolve, reject) => {
      execFile(
        "python",
        [pyScript, ...args],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (stderr) console.error("PY STDERR:", stderr);

          let parsed = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }

          if (err) {
            console.error("PY ERR:", err);
            if (stdout) console.error("PY STDOUT:", stdout);
            if (parsed && parsed.ok === false) {
              return reject(new Error(parsed.error || "Forecast failed"));
            }
            return reject(new Error("Forecast failed"));
          }

          if (!parsed) {
            if (stdout) console.error("PY STDOUT:", stdout);
            return reject(new Error("Invalid python output"));
          }

          resolve(parsed);
        }
      );
    });

    if (!payload.ok || !Array.isArray(payload.forecast)) {
      return res.status(500).json({ ok: false, message: "Bad forecast payload" });
    }

    const lastForecastDate =
      payload.forecast.length ? payload.forecast[payload.forecast.length - 1].date : null;

    return res.json({
      ok: true,
      target,
      model: modelName,
      horizon,
      lastActualDate,
      lastForecastDate,
      forecast: payload.forecast,
      volatility: payload.volatility ?? null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to preview predictions" });
  }
});



app.post("/api/admin/predictions/preview/big-onions", adminAuth, async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Import Big Onions";
    const modelName = "XGBOOST";

    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Big Onions"') IS NOT NULL`
    );
    const lastActualDate = row?.lastDate || null;

    const [histRows] = await db.query(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Big Onions"') IS NOT NULL
       ORDER BY date DESC
       LIMIT 15`
    );

    histRows.reverse();

    const recentHistory = histRows.map((r) => {
      const v =
        typeof r.values_json === "string"
          ? JSON.parse(r.values_json)
          : r.values_json;

      return {
        date: r.date,
        "Import Big Onions": v?.["Import Big Onions"] ?? null,
        "Average Exchange Rate": v?.["Average Exchange Rate"] ?? null,
        "Import Fuel Price": v?.["Import Fuel Price"] ?? null,
      };
    });

    const pyScript = path.join(__dirname, "python", "forecast_big_onions_xgb.py");
    const args = [
      String(horizon),
      String(lastActualDate),
      JSON.stringify(recentHistory),
    ];

    const payload = await new Promise((resolve, reject) => {
      execFile(
        "python",
        [pyScript, ...args],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (stderr) console.error("PY STDERR:", stderr);

          let parsed = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }

          if (err) {
            console.error("PY ERR:", err);
            if (stdout) console.error("PY STDOUT:", stdout);
            if (parsed && parsed.ok === false) {
              return reject(new Error(parsed.error || "Forecast failed"));
            }
            return reject(new Error("Forecast failed"));
          }

          if (!parsed) {
            if (stdout) console.error("PY STDOUT:", stdout);
            return reject(new Error("Invalid python output"));
          }

          resolve(parsed);
        }
      );
    });

    if (!payload.ok || !Array.isArray(payload.forecast)) {
      return res.status(500).json({ ok: false, message: "Bad forecast payload" });
    }

    const lastForecastDate =
      payload.forecast.length ? payload.forecast[payload.forecast.length - 1].date : null;

    return res.json({
      ok: true,
      target,
      model: modelName,
      horizon,
      lastActualDate,
      lastForecastDate,
      forecast: payload.forecast,
      volatility: payload.volatility ?? null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to preview predictions" });
  }
});




app.post("/api/admin/predictions/preview/red-onions", adminAuth, async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Import Red Onions";
    const modelName = "XGBOOST";

    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Red Onions"') IS NOT NULL`
    );
    const lastActualDate = row?.lastDate || null;

    const [histRows] = await db.query(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Import Red Onions"') IS NOT NULL
       ORDER BY date DESC
       LIMIT 15`
    );

    histRows.reverse();

    const recentHistory = histRows.map((r) => {
      const v =
        typeof r.values_json === "string"
          ? JSON.parse(r.values_json)
          : r.values_json;

      return {
        date: r.date,
        "Import Red Onions": v?.["Import Red Onions"] ?? null,
        "Average Exchange Rate": v?.["Average Exchange Rate"] ?? null,
        "Import Fuel Price": v?.["Import Fuel Price"] ?? null,
      };
    });

    const pyScript = path.join(__dirname, "python", "forecast_red_onions_xgb.py");
    const args = [
      String(horizon),
      String(lastActualDate),
      JSON.stringify(recentHistory),
    ];

    const payload = await new Promise((resolve, reject) => {
      execFile(
        "python",
        [pyScript, ...args],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (stderr) console.error("PY STDERR:", stderr);

          let parsed = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }

          if (err) {
            console.error("PY ERR:", err);
            if (stdout) console.error("PY STDOUT:", stdout);
            if (parsed && parsed.ok === false) {
              return reject(new Error(parsed.error || "Forecast failed"));
            }
            return reject(new Error("Forecast failed"));
          }

          if (!parsed) {
            if (stdout) console.error("PY STDOUT:", stdout);
            return reject(new Error("Invalid python output"));
          }

          resolve(parsed);
        }
      );
    });

    if (!payload.ok || !Array.isArray(payload.forecast)) {
      return res.status(500).json({ ok: false, message: "Bad forecast payload" });
    }

    const lastForecastDate =
      payload.forecast.length ? payload.forecast[payload.forecast.length - 1].date : null;

    return res.json({
      ok: true,
      target,
      model: modelName,
      horizon,
      lastActualDate,
      lastForecastDate,
      forecast: payload.forecast,
      volatility: payload.volatility ?? null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to preview predictions" });
  }
});



//Other vegetables predictions
app.post("/api/admin/predictions/preview/carrots", adminAuth, async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Carrots";
    const modelName = "SARIMAX";

    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Carrots"') IS NOT NULL`
    );
    const lastActualDate = row?.lastDate || null;

    const pyScript = path.join(__dirname, "python", "forecast_carrots.py");
    const args = [String(horizon), String(lastActualDate)];

    const payload = await new Promise((resolve, reject) => {
      execFile(
        "python",
        [pyScript, ...args],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (stderr) console.error("PY STDERR:", stderr);

          let parsed = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }

          if (err) {
            console.error("PY ERR:", err);
            if (stdout) console.error("PY STDOUT:", stdout);
            if (parsed && parsed.ok === false) {
              return reject(new Error(parsed.error || "Forecast failed"));
            }
            return reject(new Error("Forecast failed"));
          }

          if (!parsed) {
            if (stdout) console.error("PY STDOUT:", stdout);
            return reject(new Error("Invalid python output"));
          }

          resolve(parsed);
        }
      );
    });

    if (!payload.ok || !Array.isArray(payload.forecast)) {
      return res.status(500).json({ ok: false, message: "Bad forecast payload" });
    }

    const lastForecastDate =
      payload.forecast.length ? payload.forecast[payload.forecast.length - 1].date : null;

    return res.json({
      ok: true,
      target,
      model: modelName,
      horizon,
      lastActualDate,
      lastForecastDate,
      forecast: payload.forecast,
      volatility: payload.volatility ?? null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to preview predictions" });
  }
});

app.post("/api/admin/predictions/preview/cabbages", adminAuth, async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Cabbages";
    const modelName = "SARIMAX";

    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Cabbages"') IS NOT NULL`
    );
    const lastActualDate = row?.lastDate || null;

    const pyScript = path.join(__dirname, "python", "forecast_cabbages.py");
    const args = [String(horizon), String(lastActualDate)];

    const payload = await new Promise((resolve, reject) => {
      execFile(
        "python",
        [pyScript, ...args],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (stderr) console.error("PY STDERR:", stderr);

          let parsed = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }

          if (err) {
            console.error("PY ERR:", err);
            if (stdout) console.error("PY STDOUT:", stdout);
            if (parsed && parsed.ok === false) {
              return reject(new Error(parsed.error || "Forecast failed"));
            }
            return reject(new Error("Forecast failed"));
          }

          if (!parsed) {
            if (stdout) console.error("PY STDOUT:", stdout);
            return reject(new Error("Invalid python output"));
          }

          resolve(parsed);
        }
      );
    });

    if (!payload.ok || !Array.isArray(payload.forecast)) {
      return res.status(500).json({ ok: false, message: "Bad forecast payload" });
    }

    const lastForecastDate =
      payload.forecast.length ? payload.forecast[payload.forecast.length - 1].date : null;

    return res.json({
      ok: true,
      target,
      model: modelName,
      horizon,
      lastActualDate,
      lastForecastDate,
      forecast: payload.forecast,
      volatility: payload.volatility ?? null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to preview predictions" });
  }
});

app.post("/api/admin/predictions/preview/tomatoes", adminAuth, async (req, res) => {
  try {
    const horizon = Number(req.query.horizon || 7);
    const target = "Tomatoes";
    const modelName = "SARIMAX";

    const [[row]] = await db.query(
      `SELECT DATE_FORMAT(MAX(date), '%Y-%m-%d') AS lastDate
       FROM train_ready_daily
       WHERE JSON_EXTRACT(values_json, '$."Tomatoes"') IS NOT NULL`
    );
    const lastActualDate = row?.lastDate || null;

    const pyScript = path.join(__dirname, "python", "forecast_tomatoes.py");
    const args = [String(horizon), String(lastActualDate)];

    const payload = await new Promise((resolve, reject) => {
      execFile(
        "python",
        [pyScript, ...args],
        { maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (stderr) console.error("PY STDERR:", stderr);

          let parsed = null;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            parsed = null;
          }

          if (err) {
            console.error("PY ERR:", err);
            if (stdout) console.error("PY STDOUT:", stdout);
            if (parsed && parsed.ok === false) {
              return reject(new Error(parsed.error || "Forecast failed"));
            }
            return reject(new Error("Forecast failed"));
          }

          if (!parsed) {
            if (stdout) console.error("PY STDOUT:", stdout);
            return reject(new Error("Invalid python output"));
          }

          resolve(parsed);
        }
      );
    });

    if (!payload.ok || !Array.isArray(payload.forecast)) {
      return res.status(500).json({ ok: false, message: "Bad forecast payload" });
    }

    const lastForecastDate =
      payload.forecast.length ? payload.forecast[payload.forecast.length - 1].date : null;

    return res.json({
      ok: true,
      target,
      model: modelName,
      horizon,
      lastActualDate,
      lastForecastDate,
      forecast: payload.forecast,
      volatility: payload.volatility ?? null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to preview predictions" });
  }
});


//save predictions

app.post("/api/admin/predictions/save", adminAuth, async (req, res) => {
  try {
    const { target, model, horizon, forecast } = req.body || {};

    if (!target || !model || !Array.isArray(forecast) || forecast.length === 0) {
      return res.status(400).json({ ok: false, message: "Missing forecast payload" });
    }

    const runId = `${target.replace(/\s+/g, "_").toLowerCase()}_${Date.now()}`;

    const round1 = (v) =>
      typeof v === "number" && Number.isFinite(v)
        ? Number(v.toFixed(1))
        : null;

    const values = forecast.map((r) => [
      target,
      r.date,
      round1(r.predicted),
      round1(r.lower),
      round1(r.upper),
      model,
      runId,
    ]);

    await db.query(
      `INSERT INTO predictions_daily
       (target, forecast_date, predicted_value, lower_95, upper_95, model_name, run_id)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         predicted_value = VALUES(predicted_value),
         lower_95 = VALUES(lower_95),
         upper_95 = VALUES(upper_95),
         model_name = VALUES(model_name),
         run_id = VALUES(run_id),
         created_at = CURRENT_TIMESTAMP`,
      [values]
    );

    const lastForecastDate =
      forecast.length ? forecast[forecast.length - 1].date : null;

    await logAdminAction({
      req,
      admin_username: req.admin.username,
      action: "generate_forecast",
      status: "success",
      details: `Saved ${values.length} forecast rows for ${target} using ${model} (horizon=${horizon})`,
    });

    return res.json({
      ok: true,
      message: "Forecasts saved to DB",
      target,
      model,
      runId,
      savedRows: values.length,
      lastForecastDate,
    });
  } catch (e) {
    console.error(e);

    await logAdminAction({
      req,
      admin_username: req.admin?.username || "admin",
      action: "generate_forecast",
      status: "failed",
      details: `Failed to save forecast rows`,
    });

    return res.status(500).json({ ok: false, message: "Failed to save forecasts" });
  }
});





//Explorer Page

app.get("/api/public/explorer", async (req, res) => {
  try {
    const veg = req.query.veg || "Import Potatoes";
    const from = req.query.from || "2018-01-01";
    const to = req.query.to || "2030-12-31";

    const [rows] = await db.query(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, values_json
       FROM train_ready_daily
       WHERE date BETWEEN ? AND ?
         AND JSON_EXTRACT(values_json, ?) IS NOT NULL
       ORDER BY date ASC`,
      [from, to, `$."${veg}"`]
    );

    const series = rows
      .map((r) => {
        const v =
          typeof r.values_json === "string"
            ? JSON.parse(r.values_json)
            : r.values_json;

        return {
          date: r.date,
          value: v?.[veg] ?? null,
        };
      })
      .filter((x) => x.value !== null);

    const values = series.map((x) => Number(x.value)).filter(Number.isFinite);

    const summary = {
      count: series.length,
      latest: series.length ? series[series.length - 1].value : null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
    };

    return res.json({
      ok: true,
      vegetable: veg,
      from,
      to,
      summary,
      series,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, message: "Failed to load explorer data" });
  }
});


// Global error handler (keep last)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: "Internal Server Error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
