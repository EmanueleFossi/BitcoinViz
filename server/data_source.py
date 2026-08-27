"""
Abstraction layer for raw transaction data.

Every other backend module calls get_raw_transactions() and gets back the
same pandas DataFrame shape, no matter where the data actually lives.
Today it reads local CSV files. When you move to Neo4j, you rewrite ONLY
this function — server.py, filters.py, and the frontend never change.
"""
import os
import pandas as pd

DATA_DIR = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")), "data_cleaned")

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


# In-memory cache: the 13 CSVs never change while the server is running,
# so we only need to actually read+concat them once. Every subsequent
# call (each day-switch, each filter, each screen) reuses this instead
# of hitting the disk again — this is what was making every click slow.
_cache = None


def get_raw_transactions() -> pd.DataFrame:
    """
    Returns ALL raw transaction rows as one normalized DataFrame.
    This is the ONLY function in the whole project allowed to know that
    data currently lives in these specific CSV files.
    """
    global _cache
    if _cache is not None:
        return _cache

    chunks = []
    for filename in ALL_FILES:
        filepath = os.path.join(DATA_DIR, filename)
        if not os.path.exists(filepath):
            print(f"  [SKIP] {filename} non trovato")
            continue
        try:
            df = pd.read_csv(filepath)
            df["source_file"] = filename
            chunks.append(df)
            print(f"  [OK]   {filename} — {len(df)} righe")
        except Exception as e:
            print(f"  [ERR]  {filename} — {e}")

    if not chunks:
        raise FileNotFoundError("Nessun file trovato in data_cleaned/")

    raw = pd.concat(chunks, ignore_index=True)
    raw["output_value_BTC"] = pd.to_numeric(raw["output_value_BTC"], errors="coerce").fillna(0)
    raw["transaction_inputs"] = pd.to_numeric(raw["transaction_inputs"], errors="coerce").fillna(1)

    _cache = raw
    return _cache


# --- FUTURE (Neo4j) ---------------------------------------------------
# def get_raw_transactions() -> pd.DataFrame:
#     from neo4j import GraphDatabase
#     driver = GraphDatabase.driver(URI, auth=(USER, PASSWORD))
#     with driver.session() as session:
#         result = session.run("MATCH (t:Transaction)-[:OUTPUT]->(o:Output) RETURN ...")
#         records = [r.data() for r in result]
#     df = pd.DataFrame(records)
#     # IMPORTANT: rename/reshape columns here so the output has the exact
#     # same column names as the CSV version above (transaction_hash, time,
#     # output_value_BTC, output_address, transaction_inputs,
#     # total_input_value_BTC, input_addresses). That's the whole contract.
#     return df
# ------------------------------------------------------------------------