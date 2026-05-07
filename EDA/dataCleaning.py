import pandas as pd
import os

input_folder = 'data'
output_folder = 'data_cleaned'

if not os.path.exists(output_folder):
    os.makedirs(output_folder)

files = [f for f in os.listdir(input_folder) if f.endswith('.csv')]

def filter_by_output_sum():
    for file_name in files:
        print(f"Elaborazione e filtraggio: {file_name}...")
        path = os.path.join(input_folder, file_name)
        output_path = os.path.join(output_folder, file_name)
        
        cols = [
            'transaction_hash', 'time', 'output_value_BTC', 
            'output_address', 'transaction_inputs', 
            'total_input_value_BTC', 'input_addresses'
        ]
        
        first_chunk = True
        
        try:
            # Leggiamo a chunk
            for chunk in pd.read_csv(path, usecols=cols, chunksize=100000):
                
                # 1. Calcoliamo la somma degli output per ogni transazione nel chunk
                # Nota: trasformiamo in float per sicurezza
                chunk['output_value_BTC'] = chunk['output_value_BTC'].astype(float)
                
                # Calcoliamo il totale per hash (usiamo transform per mantenere le righe originali)
                tx_sums = chunk.groupby('transaction_hash')['output_value_BTC'].transform('sum')
                
                # 2. Filtriamo: teniamo solo le righe dove la somma totale della transazione è > 1
                filtered_chunk = chunk[tx_sums > 1.0]
                
                # 3. Salvataggio incrementale (append) per non caricare tutto in memoria
                if first_chunk:
                    filtered_chunk.to_csv(output_path, index=False, mode='w')
                    first_chunk = False
                else:
                    filtered_chunk.to_csv(output_path, index=False, mode='a', header=False)
            
            print(f"✅ {file_name} filtrato e salvato.")
            
        except Exception as e:
            print(f"❌ Errore su {file_name}: {e}")

filter_by_output_sum()