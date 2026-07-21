import os
import glob
import pandas as pd
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

# Pay attention to the paths!!!!
BASE_DIR   = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR   = os.path.join(BASE_DIR, "data_cleaned") 
EXPORT_DIR = os.path.join(BASE_DIR, "data_cleaned")

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
CORS(app)

ALL_FILES = [
    "Bitcoin_Data_2024_05_24.csv",
    "Bitcoin_Data_2024_05_25.csv",
    "Bitcoin_Data_2024_05_26.csv",
    "Bitcoin_Data_2024_05_27.csv",
    "Bitcoin_Data_2024_05_28.csv",
    "Bitcoin_Data_2024_05_29.csv",
    "Bitcoin_Data_2024_05_30.csv",
    "Bitcoin_Data_2024_05_31.csv",
    "Bitcoin_Data_2024_06_01.csv",
    "Bitcoin_Data_2024_06_02.csv",
    "Bitcoin_Data_2024_06_03.csv",
    "Bitcoin_Data_2024_06_04.csv",
    "Bitcoin_Data_2024_06_05.csv",
]

@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/export", methods=["POST"])
def export_csv():
    params = request.get_json()

    min_ratio   = float(params.get("unbalancedThreshold", 1))
    top_ratio   = float(params.get("topRatioThreshold",   1))
    min_btc     = float(params.get("minSingleOutput",     0))
    max_btc     = float(params.get("maxSingleOutput", float('inf')))
    min_min_btc = float(params.get("minMinOutput",        0))
    max_min_btc = float(params.get("maxMinOutput",  float('inf')))   # NEW
    min_inputs  = int(params.get("minInputs",  0))
    max_inputs  = int(params.get("maxInputs",  999999))
    min_outputs = int(params.get("minOutputs", 0))
    max_outputs = int(params.get("maxOutputs", 999999))
    only_spent  = bool(params.get("onlySpentInPeriod", False))

    print(f"\n[Export] Filtri ricevuti: ratio>={min_ratio}, topRatio>={top_ratio}, "
          f"largestOutput {min_btc}-{max_btc}, smallestOutput {min_min_btc}-{max_min_btc}, "
          f"inputs {min_inputs}-{max_inputs}, outputs {min_outputs}-{max_outputs}, onlySpent={only_spent}")

    all_chunks = []
    for filename in ALL_FILES:
        filepath = os.path.join(DATA_DIR, filename)
        if not os.path.exists(filepath):
            print(f"  [SKIP] {filename} non trovato")
            continue
        try:
            df = pd.read_csv(filepath)
            df["source_file"] = filename
            all_chunks.append(df)
            print(f"  [OK]   {filename} — {len(df)} righe")
        except Exception as e:
            print(f"  [ERR]  {filename} — {e}")

    if not all_chunks:
        return jsonify({"error": "Nessun file trovato in data_cleaned/"}), 404

    raw = pd.concat(all_chunks, ignore_index=True)
    raw["output_value_BTC"] = pd.to_numeric(raw["output_value_BTC"], errors="coerce").fillna(0)
    raw["transaction_inputs"] = pd.to_numeric(raw["transaction_inputs"], errors="coerce").fillna(1)

    result_rows = []
    for tx_hash, group in raw.groupby("transaction_hash"):
        values = sorted(group["output_value_BTC"].tolist(), reverse=True)
        num_inputs  = int(group["transaction_inputs"].iloc[0])
        num_outputs = len(values)

        max_val = values[0]
        min_val = values[-1]
        ratio     = (max_val / min_val) if (min_val > 0 and num_outputs > 1) else 1.0
        top_r     = (values[0] / values[1]) if (len(values) >= 2 and values[1] > 0) else 1.0
        total_vol = sum(values)

        if ratio     < min_ratio:   continue
        if top_r     < top_ratio:   continue
        if max_val   < min_btc:     continue
        if max_btc < float('inf') and max_val > max_btc: continue
        if min_val   < min_min_btc: continue
        if max_min_btc < float('inf') and min_val > max_min_btc: continue   # NEW
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

    if not result_rows:
        return jsonify({"error": "Nessuna transazione trovata con i filtri attuali."}), 200

    os.makedirs(EXPORT_DIR, exist_ok=True)
    filename = "bitcoin_filtered.csv"
    filepath   = os.path.join(EXPORT_DIR, filename)

    result_df = pd.DataFrame(result_rows)
    result_df.to_csv(filepath, index=False)

    tx_count  = result_df["transaction_hash"].nunique()
    row_count = len(result_df)
    print(f"\n[Export] Salvato: {filepath}")
    print(f"[Export] {tx_count} transazioni → {row_count} righe\n")

    return jsonify({
        "ok":       True,
        "file":     filename,
        "path":     filepath,
        "tx_count": tx_count,
        "rows":     row_count,
    })


if __name__ == "__main__":
    print("=" * 50)
    print("  Bitcoin Viz Server")
    print(f"  Root Project Dir: {BASE_DIR}")
    print(f"  Data dir       : {DATA_DIR}")
    print("  URL di accesso : http://localhost:5501") # Cambiato per coerenza
    print("=" * 50)
    
    app.run(debug=False, port=5501)