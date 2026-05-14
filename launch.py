import sys
import time
import threading
import webbrowser
import subprocess

def start_server():
    subprocess.run([sys.executable, "server/server.py"])

t = threading.Thread(target=start_server, daemon=True)
t.start()

print("Avvio server...")
time.sleep(1.5)

print("Apertura browser su http://localhost:5501")
webbrowser.open("http://localhost:5501")

print("App avviata! Premi Ctrl+C per chiudere.\n")

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\nServer chiuso.")
