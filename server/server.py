import os
import json
import pandas as pd
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

from data_source import get_raw_transactions
from filters import apply_filters

BASE_DIR   = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXPORT_DIR = os.path.join(BASE_DIR, "data_cleaned")

app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
CORS(app)


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


def _rows_to_safe_json(df: pd.DataFrame):
    """
    Converts a DataFrame to a list of plain dicts, with NaN/NaT already
    turned into proper JSON null. Uses pandas' OWN json writer (to_json)
    instead of jsonify()/json.dumps() directly on the DataFrame, because
    pandas' to_json always writes null for missing values correctly —
    regardless of whether the column is text, numbers, or mixed. Trying
    to sanitize NaN ourselves with astype/where is fragile and depends on
    column dtypes; this sidesteps that entirely.
    """
    if df.empty:
        return []
    raw_json_str = df.to_json(orient="records")
    return json.loads(raw_json_str)


# ── Used by every chart/view in the frontend. Returns JSON directly —
#    no file written, no file re-read. This is the boundary: everything
#    past this point (ExplorativeFlow, MatrixChart, ClusterManager...)
#    only ever talks to this one endpoint, never to CSV directly. ──────
@app.route("/api/transactions", methods=["POST"])
def api_transactions():
    params = request.get_json() or {}
    print(f"\n[API] Filtri ricevuti: {params}")

    try:
        raw = get_raw_transactions()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404

    result_df = apply_filters(raw, params)
    if result_df.empty:
        return jsonify({"error": "Nessuna transazione trovata con i filtri attuali.", "rows": []}), 200

    return jsonify({
        "ok": True,
        "tx_count": int(result_df["transaction_hash"].nunique()),
        "rows": _rows_to_safe_json(result_df),
    })


# ── Kept ONLY for the "download filtered CSV" screen. This is a real
#    user-facing feature (they want an actual file), not internal data
#    plumbing — so it's fine that this one still writes to disk. ──────
@app.route("/export", methods=["POST"])
def export_csv():
    params = request.get_json() or {}
    print(f"\n[Export] Filtri ricevuti: {params}")

    try:
        raw = get_raw_transactions()
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404

    result_df = apply_filters(raw, params)
    if result_df.empty:
        return jsonify({"error": "Nessuna transazione trovata con i filtri attuali."}), 200

    os.makedirs(EXPORT_DIR, exist_ok=True)
    filename = "bitcoin_filtered.csv"
    filepath = os.path.join(EXPORT_DIR, filename)
    result_df.to_csv(filepath, index=False)

    tx_count  = result_df["transaction_hash"].nunique()
    row_count = len(result_df)
    print(f"[Export] Salvato: {filepath} — {tx_count} transazioni, {row_count} righe")

    return jsonify({
        "ok":       True,
        "file":     filename,
        "path":     filepath,
        "tx_count": int(tx_count),
        "rows":     row_count,
    })


if __name__ == "__main__":
    print("=" * 50)
    print("  Bitcoin Viz Server")
    print(f"  Root Project Dir: {BASE_DIR}")
    print("  URL di accesso : http://localhost:5501")
    print("=" * 50)
    app.run(debug=False, port=5501)