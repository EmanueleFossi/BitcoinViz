import pandas as pd
import os

# Configurazione
input_folder = 'data'
output_file = 'data/unique_spent_addresses.csv' # Il file indice leggero
files_to_process = [
    "Bitcoin_Data_2024_05_24.csv", "Bitcoin_Data_2024_05_25.csv",
    "Bitcoin_Data_2024_05_26.csv", "Bitcoin_Data_2024_05_27.csv",
    "Bitcoin_Data_2024_05_28.csv", "Bitcoin_Data_2024_05_29.csv",
    "Bitcoin_Data_2024_05_30.csv", "Bitcoin_Data_2024_05_31.csv",
    "Bitcoin_Data_2024_06_01.csv", "Bitcoin_Data_2024_06_02.csv",
    "Bitcoin_Data_2024_06_03.csv", "Bitcoin_Data_2024_06_04.csv",
    "Bitcoin_Data_2024_06_05.csv"
]

def generate_slim_index():
    # Usiamo un set per memorizzare gli indirizzi unici che hanno "speso"
    # Il set elimina automaticamente i duplicati e gestisce milioni di stringhe efficientemente
    spent_addresses = set()

    print("Inizio estrazione indirizzi di spesa (INPUT) per l'indice globale...")

    for file_name in files_to_process:
        path = os.path.join(input_folder, file_name)
        if os.path.exists(path):
            print(f"Elaborazione: {file_name}")
            
            # Leggiamo SOLO la colonna degli input_addresses per massimizzare la velocità
            # Usiamo chunksize se i file sono davvero enormi (opzionale, ma sicuro)
            try:
                for chunk in pd.read_csv(path, usecols=['input_addresses'], chunksize=100000):
                    # Rimuoviamo righe vuote e iteriamo sugli input
                    for row in chunk['input_addresses'].dropna():
                        # Gli indirizzi di input possono essere multipli separati da virgola
                        # Esempio: "addr1, addr2" -> ["addr1", "addr2"]
                        addresses = [a.strip() for a in str(row).split(',')]
                        spent_addresses.update(addresses)
            except Exception as e:
                print(f"Errore durante la lettura di {file_name}: {e}")
        else:
            print(f"File non trovato: {file_name}")

    if spent_addresses:
        # Trasformiamo il set in un DataFrame con una sola colonna 'address'
        df_final = pd.DataFrame(list(spent_addresses), columns=['address'])
        
        # Salvataggio in CSV
        df_final.to_csv(output_file, index=False)
        
        print(f"\n--- COMPLETATO ---")
        print(f"File creato: {output_file}")
        print(f"Totale indirizzi 'spenditori' unici trovati: {len(spent_addresses)}")
        print(f"Dimensione stimata file: {round(os.path.getsize(output_file) / (1024*1024), 2)} MB")
    else:
        print("Errore: nessun indirizzo trovato.")

if __name__ == "__main__":
    generate_slim_index()