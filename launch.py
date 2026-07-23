import sys
import time
import threading
import webbrowser
import subprocess

def start_server():
    subprocess.run([sys.executable, "server/server.py"])

t = threading.Thread(target=start_server, daemon=True)
t.start()

print("Starting server...")
time.sleep(1.5)

print("Opening browser at http://localhost:5501")
webbrowser.open("http://localhost:5501")

print("App started! Press Ctrl+C to close.\n")

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\nServer close.")
