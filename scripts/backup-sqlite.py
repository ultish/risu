#!/usr/bin/env python3
"""Hot-backup a sqlite database with the backup API (WAL-safe).

Writes a content-addressed snapshot only when the bytes change, plus latest.db.
Prints the content hash to stdout.

  python3 backup-sqlite.py --db ~/risu-data/risu.db --dest ~/risu-backups --prefix risu
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hot_backup(db: Path, dest_file: Path, prefix: str) -> None:
    dest_file.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f"{prefix}-", suffix=".db", dir=dest_file.parent
    )
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        src = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            src.execute("PRAGMA query_only=ON")
            dst = sqlite3.connect(tmp)
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        tmp.replace(dest_file)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def prune(dest: Path, prefix: str, keep: int) -> None:
    snaps = sorted(
        dest.glob(f"{prefix}-????????-*.db"),
        key=lambda p: p.stat().st_mtime,
    )
    for path in snaps[:-keep] if keep >= 0 else []:
        path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--dest", required=True, type=Path)
    parser.add_argument("--prefix", default="risu")
    parser.add_argument("--keep", type=int, default=30)
    args = parser.parse_args()

    db: Path = args.db.expanduser()
    dest: Path = args.dest.expanduser()
    prefix: str = args.prefix
    dest.mkdir(parents=True, exist_ok=True)

    if not db.is_file():
        print(f"no database at {db}; skip", file=sys.stderr)
        return 0

    tmp = dest / "latest.db.tmp"
    hot_backup(db, tmp, prefix)
    digest = sha256_file(tmp)
    short = digest[:12]
    existing = sorted(dest.glob(f"{prefix}-*-{short}.db"))
    if existing:
        tmp.unlink()
        snap = existing[-1]
    else:
        snap = dest / f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%d')}-{short}.db"
        tmp.replace(snap)

    latest = dest / "latest.db"
    if not latest.is_file() or sha256_file(latest) != digest:
        shutil.copy2(snap, latest)

    (dest / "LATEST").write_text(digest + "\n", encoding="utf-8")
    prune(dest, prefix, args.keep)
    print(digest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
