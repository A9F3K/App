import os
from pathlib import Path

def folder_size(p: Path) -> int:
    total = 0
    try:
        for root, dirs, files in os.walk(p, onerror=lambda e: None):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        pass
    return total

def rank(root: Path, n: int = 40, min_mb: int = 50):
    rows = []
    if not root.exists():
        print(f"Missing: {root}")
        return
    children = [c for c in root.iterdir() if c.is_dir()]
    print(f"Scanning {len(children)} folders under {root} ...", flush=True)
    for i, child in enumerate(children, 1):
        b = folder_size(child)
        if b >= min_mb * 1024 * 1024:
            rows.append((b, child.name))
        if i % 20 == 0:
            print(f"  ... {i}/{len(children)}", flush=True)
    rows.sort(reverse=True)
    print(f"=== {root} ===")
    for b, name in rows[:n]:
        print(f"{b/1024**3:8.2f} GB  {name}")
    print(f"TOTAL (>= {min_mb}MB): {sum(b for b,_ in rows)/1024**3:.2f} GB")
    print(flush=True)

local = Path(os.environ["LOCALAPPDATA"])
roaming = Path(os.environ["APPDATA"])
low = Path(os.environ["USERPROFILE"]) / "AppData" / "LocalLow"

rank(local)
rank(roaming)
rank(low)

# Also size a few profile-level caches outside AppData
print("=== Profile-level caches ===")
for rel in [".cache", ".nuget", ".gradle", ".m2", ".cargo", ".rustup", ".docker", ".cursor", ".vscode", ".npm"]:
    p = Path(os.environ["USERPROFILE"]) / rel
    if p.exists():
        b = folder_size(p)
        if b >= 50 * 1024 * 1024:
            print(f"{b/1024**3:8.2f} GB  {p}")
