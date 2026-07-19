import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

def folder_size(p: Path) -> int:
    total = 0
    try:
        for root, dirs, files in os.walk(p, onerror=lambda e: None):
            for f in files:
                try:
                    total += (Path(root) / f).stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total

targets = [
    Path(os.environ["LOCALAPPDATA"]) / "Temp",
    Path(os.environ["LOCALAPPDATA"]) / "npm-cache",
    Path(os.environ["LOCALAPPDATA"]) / "pip",
    Path(os.environ["LOCALAPPDATA"]) / "pnpm",
    Path(os.environ["LOCALAPPDATA"]) / "pnpm-cache",
    Path(os.environ["LOCALAPPDATA"]) / "Yarn",
    Path(os.environ["LOCALAPPDATA"]) / "Docker",
    Path(os.environ["LOCALAPPDATA"]) / "Packages",
    Path(os.environ["LOCALAPPDATA"]) / "Microsoft",
    Path(os.environ["LOCALAPPDATA"]) / "Google",
    Path(os.environ["LOCALAPPDATA"]) / "ms-playwright",
    Path(os.environ["LOCALAPPDATA"]) / "ms-playwright-go",
    Path(os.environ["LOCALAPPDATA"]) / "Ollama",
    Path(os.environ["LOCALAPPDATA"]) / "NVIDIA",
    Path(os.environ["LOCALAPPDATA"]) / "NVIDIA Corporation",
    Path(os.environ["LOCALAPPDATA"]) / "Programs",
    Path(os.environ["LOCALAPPDATA"]) / "D3DSCache",
    Path(os.environ["LOCALAPPDATA"]) / "CrashDumps",
    Path(os.environ["LOCALAPPDATA"]) / "Package Cache",
    Path(os.environ["LOCALAPPDATA"]) / "Roblox",
    Path(os.environ["LOCALAPPDATA"]) / "Bloxstrap",
    Path(os.environ["LOCALAPPDATA"]) / "EpicGamesLauncher",
    Path(os.environ["LOCALAPPDATA"]) / "Epic Games",
    Path(os.environ["LOCALAPPDATA"]) / "Oculus",
    Path(os.environ["LOCALAPPDATA"]) / "Adobe",
    Path(os.environ["LOCALAPPDATA"]) / "Mozilla",
    Path(os.environ["LOCALAPPDATA"]) / "cursor-updater",
    Path(os.environ["LOCALAPPDATA"]) / "antigravity",
    Path(os.environ["LOCALAPPDATA"]) / "OpenAI",
    Path(os.environ["LOCALAPPDATA"]) / "Perplexity",
    Path(os.environ["LOCALAPPDATA"]) / "Claude-3p",
    Path(os.environ["LOCALAPPDATA"]) / "cache",
    Path(os.environ["LOCALAPPDATA"]) / "CEF",
    Path(os.environ["LOCALAPPDATA"]) / "electron-builder",
    Path(os.environ["LOCALAPPDATA"]) / "node-gyp",
    Path(os.environ["LOCALAPPDATA"]) / "NuGet",
    Path(os.environ["LOCALAPPDATA"]) / "uv",
    Path(os.environ["LOCALAPPDATA"]) / "com.vercel.cli",
    Path(os.environ["LOCALAPPDATA"]) / "Expo",
    Path(os.environ["LOCALAPPDATA"]) / "Figma",
    Path(os.environ["LOCALAPPDATA"]) / "Muse Hub",
    Path(os.environ["LOCALAPPDATA"]) / "Unity",
    Path(os.environ["LOCALAPPDATA"]) / "UnrealEngine",
    Path(os.environ["LOCALAPPDATA"]) / "UnrealEngineLauncher",
    Path(os.environ["APPDATA"]) / "Cursor",
    Path(os.environ["APPDATA"]) / "Code",
    Path(os.environ["APPDATA"]) / "Telegram Desktop",
    Path(os.environ["APPDATA"]) / "npm",
    Path(os.environ["APPDATA"]) / "Docker",
    Path(os.environ["APPDATA"]) / "Docker Desktop",
    Path(os.environ["APPDATA"]) / "Unity",
    Path(os.environ["APPDATA"]) / "UnityHub",
    Path(os.environ["APPDATA"]) / "Unreal Engine",
    Path(os.environ["APPDATA"]) / "discord",
    Path(os.environ["APPDATA"]) / "Antigravity",
    Path(os.environ["APPDATA"]) / "Antigravity IDE",
    Path(os.environ["APPDATA"]) / "Trae",
    Path(os.environ["APPDATA"]) / "TRAE SOLO",
    Path(os.environ["APPDATA"]) / "Windsurf",
    Path(os.environ["USERPROFILE"]) / ".cache",
    Path(os.environ["USERPROFILE"]) / ".nuget",
    Path(os.environ["USERPROFILE"]) / ".gradle",
    Path(os.environ["USERPROFILE"]) / ".m2",
    Path(os.environ["USERPROFILE"]) / ".cargo",
    Path(os.environ["USERPROFILE"]) / ".rustup",
    Path(os.environ["USERPROFILE"]) / ".docker",
    Path(os.environ["USERPROFILE"]) / ".cursor",
    Path(os.environ["USERPROFILE"]) / ".vscode",
    Path(os.environ["USERPROFILE"]) / ".ollama",
    Path(os.environ["USERPROFILE"]) / ".npm",
    Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Edge" / "User Data" / "Default" / "Cache",
    Path(os.environ["LOCALAPPDATA"]) / "Google" / "Chrome" / "User Data" / "Default" / "Cache",
    Path(os.environ["LOCALAPPDATA"]) / "Google" / "Chrome" / "User Data" / "Default" / "Code Cache",
    Path(os.environ["APPDATA"]) / "Cursor" / "Cache",
    Path(os.environ["APPDATA"]) / "Cursor" / "CachedData",
    Path(os.environ["APPDATA"]) / "Cursor" / "User" / "workspaceStorage",
    Path(os.environ["APPDATA"]) / "Cursor" / "User" / "globalStorage",
    Path(os.environ["APPDATA"]) / "Cursor" / "logs",
    Path(os.environ["APPDATA"]) / "Code" / "Cache",
    Path(os.environ["APPDATA"]) / "Code" / "CachedData",
    Path(os.environ["APPDATA"]) / "Code" / "logs",
    Path(r"C:\Windows\Temp"),
    Path(r"C:\Windows\SoftwareDistribution\Download"),
]

existing = [p for p in targets if p.exists()]
print(f"Sizing {len(existing)} targets with threads...", flush=True)
rows = []

def work(p):
    return p, folder_size(p)

with ThreadPoolExecutor(max_workers=8) as ex:
    futs = {ex.submit(work, p): p for p in existing}
    done = 0
    for fut in as_completed(futs):
        p, b = fut.result()
        done += 1
        if b >= 30 * 1024 * 1024:
            rows.append((b, str(p)))
        if done % 10 == 0:
            print(f"  {done}/{len(existing)}", flush=True)

rows.sort(reverse=True)
print()
for b, p in rows:
    print(f"{b/1024**3:8.2f} GB  {p}")
print(f"\nSubtotal: {sum(b for b,_ in rows)/1024**3:.2f} GB")
