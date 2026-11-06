import os
import sys
import time
import subprocess
import webbrowser
import urllib.request

APP_URL = "http://localhost:8080"
APP_TITLE = "WebWallet - Enterprise Multi-Chain Platform"

def is_server_running():
    try:
        with urllib.request.urlopen(APP_URL, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False

def launch_native_window():
    edge_paths = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")
    ]
    chrome_paths = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe")
    ]

    for p in edge_paths + chrome_paths:
        if os.path.exists(p):
            try:
                subprocess.Popen([
                    p,
                    f"--app={APP_URL}",
                    "--window-size=1280,820",
                    "--window-position=center",
                    f"--name={APP_TITLE}"
                ])
                return True
            except Exception:
                pass
    return False

def main():
    if not is_server_running():
        # Try to launch server.py if local repo exists
        base_dir = os.path.dirname(os.path.abspath(__file__))
        server_path = os.path.join(base_dir, "server.py")
        if not os.path.exists(server_path):
            server_path = os.path.join(os.getcwd(), "server.py")
        if os.path.exists(server_path):
            subprocess.Popen([sys.executable, server_path], cwd=os.path.dirname(server_path))
            time.sleep(1.5)

    if not launch_native_window():
        webbrowser.open(APP_URL)

if __name__ == "__main__":
    main()

