import os
import glob
import argparse
import pandas as pd

# ─────────────────────────────────────────────
#  CONFIGURA QUI I TUOI PERCORSI
# ─────────────────────────────────────────────
DEFAULT_INPUT_DIR = r"C:\Users\emanu\OneDrive\Desktop\dataVisBC\data_cleaned" 
DEFAULT_OUTPUT = r"C:\Users\emanu\OneDrive\Desktop\Bitcoin_Data_Unified.csv"
DEFAULT_LIMIT     = 100  
# ─────────────────────────────────────────────


def unifica_file_bitcoin(input_dir: str, output_file: str, limit: int) -> None:
    pattern = os.path.join(input_dir, "Bitcoin_Data_*.csv")
    files = sorted(glob.glob(pattern))

    if not files:
        print(f"[ERRORE] Nessun file trovato con il pattern: {pattern}")
        return

    print(f"Trovati {len(files)} file da processare.\n")

    chunks = []

    for filepath in files:
        filename = os.path.basename(filepath)
        try:
            df = pd.read_csv(filepath, nrows=limit)
            df.insert(0, "source_file", filename)
            chunks.append(df)
            print(f"  [OK] {filename} — {len(df)} righe lette")
        except Exception as e:
            print(f"  [SKIP] {filename} — errore: {e}")

    if not chunks:
        print("\n[ERRORE] Nessun dato da salvare.")
        return

    risultato = pd.concat(chunks, ignore_index=True)
    risultato.to_csv(output_file, index=False)

    print(f"\nFile unificato salvato in: {output_file}")
    print(f"Totale righe: {len(risultato)} | Totale colonne: {len(risultato.columns)}")


def main():
    parser = argparse.ArgumentParser(
        description="Unifica file CSV Bitcoin giornalieri in un unico file."
    )
    parser.add_argument(
        "--input_dir",
        default=DEFAULT_INPUT_DIR,
        help=f"Cartella contenente i file Bitcoin_Data_*.csv (default: {DEFAULT_INPUT_DIR})",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=f"File CSV di output (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Righe massime da leggere per file (default: {DEFAULT_LIMIT})",
    )
    args = parser.parse_args()

    print("=" * 50)
    print("  Unificatore CSV Bitcoin")
    print("=" * 50)
    print(f"  Cartella input : {args.input_dir}")
    print(f"  File output    : {args.output}")
    print(f"  Righe per file : {args.limit}")
    print("=" * 50 + "\n")

    unifica_file_bitcoin(args.input_dir, args.output, args.limit)


if __name__ == "__main__":
    main()