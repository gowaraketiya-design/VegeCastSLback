import sys, json
import pandas as pd
import math

# ------------------------
# Helpers
# ------------------------

EXTERNAL_RENAME_MAP = {
    "Monthly Average Exchange Rates": "Average Exchange Rate",
    "CPC Import Prices": "Import Fuel Price",
}

def clean_value(v):
    """Convert NaN / NaT to None so JSON is valid"""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def detect_table(df: pd.DataFrame):
    # find header row containing "Item Name"
    for i in range(min(30, len(df))):
        row = df.iloc[i].astype(str).str.strip().tolist()
        if "Item Name" in row:
            return i
    return None


def preprocess_raw_xlsx(filepath: str):
    # read first sheet by default
    raw = pd.read_excel(filepath, sheet_name=0, header=None)
    header_row = detect_table(raw)
    if header_row is None:
        raise ValueError("Could not find header row with 'Item Name'")

    df = pd.read_excel(filepath, sheet_name=0, header=header_row)
    df.columns = [str(c).strip() for c in df.columns]

    if "Item Name" not in df.columns:
        raise ValueError("Missing 'Item Name' column")

    # date columns start after "Scale" (or after 3rd column)
    if "Scale" in df.columns:
        start_idx = list(df.columns).index("Scale") + 1
    else:
        start_idx = 3

    date_cols = df.columns[start_idx:]

    out = {}  # date -> dict of item values
    for _, r in df.iterrows():
        item = str(r.get("Item Name", "")).strip()
        if (
            not item
            or item.lower().startswith("prices and indices")
            or "retail prices" in item.lower()
        ):
            continue

        # skip section headings
        unit = str(r.get("Unit", "")).strip()
        scale = str(r.get("Scale", "")).strip()
        if unit == "" and scale == "":
            continue

        for dc in date_cols:
            if pd.isna(dc):
                continue

            d = pd.to_datetime(dc, errors="coerce")
            if pd.isna(d):
                continue

            date_key = d.strftime("%Y-%m-%d")

            v = r.get(dc, None)
            try:
                val = float(v) if pd.notna(v) else None
            except:
                val = None

            out.setdefault(date_key, {})[item] = val

    wide = pd.DataFrame.from_dict(out, orient="index").sort_index()
    wide.index.name = "date"
    wide.reset_index(inplace=True)

    # ensure date column is clean + parseable
    wide["date"] = pd.to_datetime(wide["date"], errors="coerce")
    wide = wide.dropna(subset=["date"])
    wide["date"] = wide["date"].dt.strftime("%Y-%m-%d")

    return wide


def ensure_keys(df, keys):
    for k in keys:
        if k not in df.columns:
            df[k] = None
    return df

# def expand_monthly_to_daily(df: pd.DataFrame, date_col="date"):
#     """
#     Expands monthly data into daily by repeating the monthly value
#     for every day in that month.
#     """
#     df[date_col] = pd.to_datetime(df[date_col], errors="coerce")

#     daily_rows = []

#     for _, row in df.iterrows():
#         d = row[date_col]
#         if pd.isna(d):
#             continue

#         # month start & end
#         start = d.replace(day=1)
#         end = (start + pd.offsets.MonthEnd(1))

#         for day in pd.date_range(start, end, freq="D"):
#             new_row = row.copy()
#             new_row[date_col] = day
#             daily_rows.append(new_row)

#     out = pd.DataFrame(daily_rows)
#     out[date_col] = out[date_col].dt.strftime("%Y-%m-%d")
#     return out

def expand_monthly_to_daily(df: pd.DataFrame, date_col="date"):
    """
    Expands monthly data into daily by repeating the monthly value
    for every day in that month.

    Robust to strings like '2018-01', 'Jan-2018', '1/2018', etc.
    """
    if df is None or df.empty:
        return df

    # Force date parsing
    dts = pd.to_datetime(df[date_col], errors="coerce", infer_datetime_format=True)

    # If parsing failed for many, try a second strategy (common monthly formats)
    if dts.isna().all():
        # Try converting month-like strings to first day of month
        # e.g. "2018-01" -> "2018-01-01"
        fixed = df[date_col].astype(str).str.strip()

        # add "-01" if looks like YYYY-MM
        fixed2 = fixed.where(~fixed.str.match(r"^\d{4}-\d{2}$"), fixed + "-01")

        # add "/01" if looks like MM/YYYY
        fixed2 = fixed2.where(~fixed2.str.match(r"^\d{1,2}/\d{4}$"), "01/" + fixed2)

        dts = pd.to_datetime(fixed2, errors="coerce", dayfirst=True, infer_datetime_format=True)

    df = df.copy()
    df[date_col] = dts
    df = df.dropna(subset=[date_col])

    if df.empty:
        return df  # nothing valid to expand

    daily_rows = []
    for _, row in df.iterrows():
        d = row[date_col]

        # month start & month end
        start = d.replace(day=1)
        end = (start + pd.offsets.MonthEnd(1))

        for day in pd.date_range(start, end, freq="D"):
            new_row = row.copy()
            new_row[date_col] = day
            daily_rows.append(new_row)

    out = pd.DataFrame(daily_rows)
    if out.empty:
        return out

    # ✅ Ensure datetime before .dt
    out[date_col] = pd.to_datetime(out[date_col], errors="coerce")
    out = out.dropna(subset=[date_col])

    out[date_col] = out[date_col].dt.strftime("%Y-%m-%d")
    return out


veg_path = sys.argv[1]
ex_path = sys.argv[2]
out_csv_path = sys.argv[3] if len(sys.argv) > 3 else None



# ------------------------
# Main
# ------------------------

def main():
    veg_path = sys.argv[1]
    ex_path = sys.argv[2]

    veg = preprocess_raw_xlsx(veg_path)
    exo = preprocess_raw_xlsx(ex_path)

    exo = exo.rename(columns=EXTERNAL_RENAME_MAP)

    # External data is monthly → expand to daily
    # DEBUG: show some external dates
    print("EXTERNAL date sample:", exo["date"].head(5).tolist(), file=sys.stderr)

    exo = expand_monthly_to_daily(exo)


    # ensure external has required columns
    exo = ensure_keys(exo, ["Average Exchange Rate", "Import Fuel Price"])

    merged = pd.merge(
        veg,
        exo[["date", "Average Exchange Rate", "Import Fuel Price"]],
        on="date",
        how="left",
    ).sort_values("date")


    merged["date"] = pd.to_datetime(merged["date"], errors="coerce")

    merged = merged.dropna(subset=["date"])

    merged = merged[merged["date"].dt.dayofweek < 5]  # 0=Mon ... 4=Fri
    merged["date"] = merged["date"].dt.strftime("%Y-%m-%d")

    # Force dataframe to object + replace NaN with None
    merged = merged.astype(object).where(pd.notnull(merged), None)

    # Save full preprocessed wide CSV for download
    # Save full preprocessed wide XLSX for download
    if out_csv_path:
        # Ensure date is nice in Excel
        tmp = merged.copy()
        tmp["date"] = pd.to_datetime(tmp["date"], errors="coerce")
        tmp.to_excel(out_csv_path, index=False, engine="openpyxl")



    # ------------------------
    # Preview (cleaned)
    # ------------------------
    preview = []
    for _, row in merged.head(15).iterrows():
        rec = {}
        for k, v in row.items():
            rec[str(k)] = clean_value(v)
        preview.append(rec)

    stats = {
        "dates": int(merged["date"].nunique()),
        "columns": int(len(merged.columns) - 1),
    }

    # ------------------------
    # Full rows for DB (cleaned)
    # ------------------------
    full_rows = []
    for _, row in merged.iterrows():
        date = str(row["date"])
        values = {}
        for k, v in row.drop(labels=["date"]).items():
            values[str(k)] = clean_value(v)

        full_rows.append({
            "date": date,
            "values": values
        })

    # forbid NaN in JSON
    print(
        json.dumps(
            {
                "ok": True,
                "stats": stats,
                "preview": preview,
                "full": full_rows,
            },
            allow_nan=False
        )
    )


if __name__ == "__main__":
    main()
