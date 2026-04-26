import sys
import json
import os
import math
import numpy as np
import pandas as pd
import xgboost as xgb


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, "models", "potatoes_xgb")

MODEL_PATH = os.path.join(MODEL_DIR, "potatoe_xgboost_model.ubj")
META_PATH = os.path.join(MODEL_DIR, "potatoe_meta.json")

print("DEBUG XGBOOST VERSION:", xgb.__version__, file=sys.stderr)

def clean_num(v, default=None):
    try:
        v = float(v)
        if math.isnan(v) or math.isinf(v):
            return default
        return v
    except Exception:
        return default


def main():
    try:
        horizon = int(sys.argv[1]) if len(sys.argv) > 1 else 7
        last_actual_date_str = sys.argv[2] if len(sys.argv) > 2 else None
        history_json = sys.argv[3] if len(sys.argv) > 3 else "[]"

        model = xgb.XGBRegressor()
        model.load_model(MODEL_PATH)


        with open(META_PATH, "r", encoding="utf-8") as f:
            meta = json.load(f)

        target = meta["target"]
        feature_cols = meta["features"]

        # print("DEBUG MODEL PATH:", MODEL_PATH, file=sys.stderr)
        # print("DEBUG META PATH:", META_PATH, file=sys.stderr)
        # print("DEBUG FEATURES:", feature_cols, file=sys.stderr)

        rows = json.loads(history_json)
        last_data = pd.DataFrame(rows)

        if last_data.empty:
            raise ValueError("No recent history rows provided for XGBoost forecast")

        last_data["date"] = pd.to_datetime(last_data["date"], errors="coerce")
        last_data = last_data.dropna(subset=["date"]).sort_values("date").set_index("date")

        for c in [target, "Average Exchange Rate", "Import Fuel Price"]:
            if c not in last_data.columns:
                last_data[c] = np.nan
            last_data[c] = pd.to_numeric(last_data[c], errors="coerce")

        last_data["Average Exchange Rate"] = last_data["Average Exchange Rate"].ffill().bfill()
        last_data["Import Fuel Price"] = last_data["Import Fuel Price"].ffill().bfill()
        last_data[target] = last_data[target].interpolate(limit=3, limit_direction="both")
        last_data = last_data.dropna(subset=[target])

        if len(last_data) < 7:
            raise ValueError("At least 7 usable rows are required for Potatoes XGBoost forecast")

        if last_actual_date_str and last_actual_date_str != "None":
            last_date = pd.to_datetime(last_actual_date_str, errors="coerce")
        else:
            last_date = last_data.index[-1]

        if pd.isna(last_date):
            last_date = last_data.index[-1]

        last_data = last_data[last_data.index <= last_date]

        print("DEBUG LAST DATE:", last_date, file=sys.stderr)
        print("DEBUG LAST ROWS:", file=sys.stderr)
        print(last_data.tail(10).to_string(), file=sys.stderr)

        if len(last_data) < 7:
            raise ValueError("Not enough usable history up to supplied last actual date")

        future_dates = pd.bdate_range(last_date + pd.Timedelta(days=1), periods=horizon)
        future_preds = []

        for date in future_dates:
            row = last_data.iloc[-1:].copy()

            row["lag_1"] = float(last_data[target].iloc[-1])
            row["lag_2"] = float(last_data[target].iloc[-2])
            row["lag_3"] = float(last_data[target].iloc[-3])
            row["lag_5"] = float(last_data[target].iloc[-5])
            row["lag_7"] = float(last_data[target].iloc[-7])

            row["roll_mean_3"] = float(last_data[target].iloc[-3:].mean())
            row["roll_mean_5"] = float(last_data[target].iloc[-5:].mean())
            row["roll_mean_7"] = float(last_data[target].iloc[-7:].mean())

            row["dayofweek"] = int(date.dayofweek)
            row["month"] = int(date.month)
            row["dayofmonth"] = int(date.day)

            row["Average Exchange Rate"] = float(last_data["Average Exchange Rate"].iloc[-1])
            row["Import Fuel Price"] = float(last_data["Import Fuel Price"].iloc[-1])

            for col in feature_cols:
                if col not in row.columns:
                    row[col] = 0.0

            X_new = pd.DataFrame([row.iloc[0][feature_cols].values], columns=feature_cols)
            X_new = X_new.replace([np.inf, -np.inf], np.nan).fillna(0.0)

            raw_pred = clean_num(model.predict(X_new)[0], None)

            recent_vals = last_data[target].iloc[-7:].astype(float)
            lower_bound = max(1.0, float(recent_vals.min()) * 0.7)
            upper_bound = float(recent_vals.max()) * 1.3
            recent_last = float(last_data[target].iloc[-1])

            if raw_pred is None:
                pred = recent_last
            else:
                pred = min(max(raw_pred, lower_bound), upper_bound)

            pred = 0.7 * pred + 0.3 * recent_last
            pred = max(0.0, pred)

            future_preds.append(pred)

            print(
                f"STEP {date.strftime('%Y-%m-%d')} "
                f"last={float(last_data[target].iloc[-1])} "
                f"raw_pred={raw_pred} "
                f"final_pred={pred}",
                file=sys.stderr
            )

            new_row = row.copy()
            new_row[target] = pred
            new_row.index = [date]
            last_data = pd.concat([last_data, new_row], axis=0)

        forecast = []
        for i, d in enumerate(future_dates):
            pred = round(max(0.0, clean_num(future_preds[i], 0.0)), 1)
            forecast.append({
                "date": d.strftime("%Y-%m-%d"),
                "predicted": pred,
                "lower": round(max(0.0, pred * 0.95), 1),
                "upper": round(max(0.0, pred * 1.05), 1),
            })

        vals = np.array([clean_num(x, 0.0) for x in future_preds], dtype=float)
        if len(vals) > 1:
            safe_prev = np.where(vals[:-1] == 0, 1.0, vals[:-1])
            returns = np.diff(vals) / safe_prev
            volatility = clean_num(np.std(returns), 0.0)
        else:
            volatility = 0.0

        print(json.dumps({
            "ok": True,
            "target": target,
            "model": "XGBOOST",
            "lastActualDate": last_date.strftime("%Y-%m-%d"),
            "forecast": forecast,
            "volatility": volatility
        }, allow_nan=False))

    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": str(e)
        }, allow_nan=False))
        sys.exit(1)


if __name__ == "__main__":
    main()