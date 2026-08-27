"""
Filtering logic, extracted out of the route handlers so both the JSON API
(/api/transactions) and the CSV export (/export) apply IDENTICAL rules.
Takes a raw DataFrame (from data_source.get_raw_transactions) + a params
dict (from the frontend) and returns the filtered rows as a DataFrame.
"""
import pandas as pd


def apply_filters(raw: pd.DataFrame, params: dict) -> pd.DataFrame:
    # Powers main.js's day dropdown (loadDataAndDraw). Matches against the
    # "source_file" column data_source.py stamps on every row today.
    # NOTE: when the backend moves to Neo4j, "source_file" won't exist —
    # replace this with a date-range match on the "time" column instead.
    day_file = params.get("day")
    if day_file and "source_file" in raw.columns:
        raw = raw[raw["source_file"] == day_file]
    # Date range (Start date / End date picker) — independent of "day"
    # above, used when Export/Apply sends a multi-day span. Filters on the
    # real "time" column, so it keeps working even after CSV → Neo4j.
    start_date = params.get("startDate")
    end_date   = params.get("endDate")
    if start_date or end_date:
        times = pd.to_datetime(raw["time"], errors="coerce", utc=True)
        mask = pd.Series(True, index=raw.index)
        if start_date:
            mask &= times >= pd.to_datetime(start_date, utc=True)
        if end_date:
            end_dt = pd.to_datetime(end_date, utc=True) + pd.Timedelta(days=1)  # inclusive of the whole end day
            mask &= times < end_dt
        raw = raw[mask]

    min_ratio   = float(params.get("unbalancedThreshold", 1))
    top_ratio   = float(params.get("topRatioThreshold",   1))
    min_btc     = float(params.get("minSingleOutput",     0))
    max_btc     = float(params.get("maxSingleOutput", float("inf")))
    min_min_btc = float(params.get("minMinOutput",        0))
    max_min_btc = float(params.get("maxMinOutput",  float("inf")))
    min_inputs  = int(params.get("minInputs",  0))
    max_inputs  = int(params.get("maxInputs",  999999))
    min_outputs = int(params.get("minOutputs", 0))
    max_outputs = int(params.get("maxOutputs", 999999))

    result_rows = []
    for tx_hash, group in raw.groupby("transaction_hash"):
        values = sorted(group["output_value_BTC"].tolist(), reverse=True)
        num_inputs  = int(group["transaction_inputs"].iloc[0])
        num_outputs = len(values)

        max_val = values[0]
        min_val = values[-1]
        ratio = (max_val / min_val) if (min_val > 0 and num_outputs > 1) else 1.0
        top_r = (values[0] / values[1]) if (len(values) >= 2 and values[1] > 0) else 1.0

        if ratio     < min_ratio:   continue
        if top_r     < top_ratio:   continue
        if max_val   < min_btc:     continue
        if max_btc < float("inf") and max_val > max_btc: continue
        if min_val   < min_min_btc: continue
        if max_min_btc < float("inf") and min_val > max_min_btc: continue
        if num_inputs  < min_inputs  or num_inputs  > max_inputs:  continue
        if num_outputs < min_outputs or num_outputs > max_outputs: continue

        for _, out_row in group.iterrows():
            result_rows.append({
                "transaction_hash":      out_row["transaction_hash"],
                "time":                  out_row["time"],
                "output_value_BTC":      out_row["output_value_BTC"],
                "output_address":        out_row.get("output_address", ""),
                "transaction_inputs":    out_row["transaction_inputs"],
                "total_input_value_BTC": out_row.get("total_input_value_BTC", ""),
                "input_addresses":       out_row.get("input_addresses", ""),
            })

    return pd.DataFrame(result_rows)