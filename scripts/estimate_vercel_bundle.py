"""Estimate Vercel Python function bundle size (source + pip deps).

Run: python scripts/estimate_vercel_bundle.py

Uses CPU-only torch (same as vercel.json installCommand) for a realistic estimate.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IGNORE_DIRS = {
    ".git",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    "storage",
    "data",
    "deploy",
    "docs",
    ".vercel",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vscode",
}
IGNORE_FILES = {
    "minuta.db",
    "app.py",
    "Dockerfile",
    "docker-compose.yml",
    "DEPLOYMENT.md",
    "README.md",
    "setup.bat",
    "run.bat",
    ".env",
}
IGNORE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".wav",
    ".mp3",
    ".m4a",
    ".ogg",
    ".webm",
    ".mp4",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".7z",
    ".db",
    ".sqlite",
    ".sqlite3",
}


def dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for name in files:
            fp = Path(root) / name
            try:
                total += fp.stat().st_size
            except OSError:
                pass
    return total


def source_size() -> int:
    total = 0
    for root, dirs, files in os.walk(ROOT):
        rel = Path(root).relative_to(ROOT)
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and d != "scripts"]
        if rel.parts and rel.parts[0] == "scripts":
            continue
        for name in files:
            if name in IGNORE_FILES:
                continue
            if Path(name).suffix.lower() in IGNORE_SUFFIXES:
                continue
            fp = Path(root) / name
            try:
                total += fp.stat().st_size
            except OSError:
                pass
    return total


def mb(n: int) -> float:
    return round(n / 1024 / 1024, 2)


def main() -> int:
    print("=== Minuta Vercel bundle estimate ===\n")
    src = source_size()
    print(f"Deployable source (after .vercelignore rules): {mb(src)} MB")

    large: list[tuple[float, str]] = []
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in {".git", ".venv", "venv", "node_modules"}]
        for name in files:
            fp = Path(root) / name
            try:
                size = fp.stat().st_size
            except OSError:
                continue
            if size > 10 * 1024 * 1024:
                large.append((mb(size), str(fp.relative_to(ROOT))))

    print("\nFiles > 10 MB in project tree:")
    if large:
        for size, path in sorted(large, reverse=True):
            print(f"  {size:>8} MB  {path}")
    else:
        print("  (none — bundle bloat is from pip dependencies, not source files)")

    venv_dir = tempfile.mkdtemp(prefix="minuta-vercel-est-")
    print(f"\nCreating temp venv: {venv_dir}")
    try:
        py = sys.executable
        subprocess.check_call([py, "-m", "venv", venv_dir])
        pip = str(Path(venv_dir) / "Scripts" / "pip.exe")
        if not Path(pip).exists():
            pip = str(Path(venv_dir) / "bin" / "pip")

        subprocess.check_call(
            [
                pip,
                "install",
                "--no-cache-dir",
                "torch>=2.0.0",
                "--index-url",
                "https://download.pytorch.org/whl/cpu",
            ]
        )
        subprocess.check_call(
            [pip, "install", "--no-cache-dir", "-r", str(ROOT / "requirements-vercel.txt")]
        )

        site = Path(venv_dir) / "Lib" / "site-packages"
        if not site.exists():
            site = Path(venv_dir) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
        deps = dir_size(site)
        total = src + deps
        print(f"\nPip dependencies (CPU torch + requirements-vercel.txt): {mb(deps)} MB")
        print(f"Estimated function bundle total: {mb(total)} MB")
        print(f"Vercel Python limit (standard): 500 MB")
        if total > 500 * 1024 * 1024:
            print("\nWARNING: Still likely over 500 MB with full ML stack.")
            print("Options: enable Vercel Large Functions (up to 5 GB) OR host API on VPS/Docker.")
        else:
            print("\nOK: Should fit within the 500 MB standard Python limit.")
    finally:
        shutil.rmtree(venv_dir, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
