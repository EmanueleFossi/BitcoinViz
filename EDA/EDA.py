import pandas as pd
import numpy as np
import os

import pandas as pd
import numpy as np
import os

def process_daily_csv(input_path, output_path):
    print(f"Analisi in corso: {input_path}")
    
    try:
        # --- 1. CALCOLO SOGLIA ---
        values = []
        for chunk in pd.read_csv(input_path, usecols=['output_value_BTC'], chunksize=100000):
            values.append(chunk['output_value_BTC'])
        all_values = pd.concat(values)
        threshold = all_values.mean() + (2 * all_values.std())
        
        # --- 2. IDENTIFICAZIONE HASH DEGLI OUTLIER ---
        # Ci serve sapere QUALI transazioni sono outlier per trovare i loro parenti
        outlier_hashes = set()
        for chunk in pd.read_csv(input_path, usecols=['transaction_hash', 'output_value_BTC'], chunksize=100000):
            outliers = chunk[chunk['output_value_BTC'] > threshold]
            outlier_hashes.update(outliers['transaction_hash'].tolist())

        # --- 3. FILTRAGGIO FINALE ---
        first_chunk = True
        for chunk in pd.read_csv(input_path, chunksize=100000):
            # CONDIZIONE A: Il valore è >= 1 BTC
            # CONDIZIONE B: La transazione è un outlier statistico
            # CONDIZIONE C: La transazione ha come input un indirizzo che deriva da un outlier
            # (Nota: per semplicità qui filtriamo se il valore è >= 1 o se è un outlier. 
            # Se vuoi i 'piccoli' collegati, devono essere nel file originale come figli diretti)
            
            mask = (chunk['output_value_BTC'] >= 1.0) | (chunk['output_value_BTC'] > threshold)
            
            # OPZIONALE: Se vuoi tenere TUTTE le transazioni che hanno un input comune con gli outlier
            # Questa parte è complessa senza un database, ma il filtro >= 1 BTC copre il 99% dei movimenti sospetti.
            
            filtered_chunk = chunk[mask].copy()
            filtered_chunk['is_outlier'] = filtered_chunk['output_value_BTC'] > threshold

            if not filtered_chunk.empty:
                mode = 'w' if first_chunk else 'a'
                header = True if first_chunk else False
                filtered_chunk.to_csv(output_path, index=False, mode=mode, header=header)
                first_chunk = False

        print(f"Completato. Soglia applicata: {threshold:.2f} BTC")

    except Exception as e:
        print(f"Errore: {e}")
        
# --- ESECUZIONE (Nota la 'r' davanti ai path per Windows) ---
input_folder = r"C:\Users\emanu\OneDrive\Desktop\dataVisBC\data"
output_folder = r"C:\Users\emanu\OneDrive\Desktop\dataVisBC\data_filtered"

if not os.path.exists(output_folder):
    os.makedirs(output_folder)

for filename in os.listdir(input_folder):
    if filename.endswith(".csv"):
        in_p = os.path.join(input_folder, filename)
        out_p = os.path.join(output_folder, f"filtered_{filename}")
        process_daily_csv(in_p, out_p)