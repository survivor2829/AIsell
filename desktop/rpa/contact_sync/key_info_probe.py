#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys


HEX64 = re.compile(r"\b[a-fA-F0-9]{64}\b")


def add_candidate(candidates, value):
    if value and value not in candidates:
        candidates.append(value)


def candidates_from_value(value):
    candidates = []
    if value is None:
        return candidates

    if isinstance(value, bytes):
        text = value.decode("utf-8", "ignore")
        for match in HEX64.findall(text):
            add_candidate(candidates, match.lower())
        if len(value) == 32:
            add_candidate(candidates, value.hex())
        return candidates

    text = str(value)
    for match in HEX64.findall(text):
        add_candidate(candidates, match.lower())
    return candidates


def read_candidates(db_path):
    connection = sqlite3.connect(str(Path(db_path)))
    connection.row_factory = sqlite3.Row
    try:
        tables = [
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        ]
        rows_seen = 0
        candidates = []
        for table in tables:
            for row in connection.execute(f'SELECT * FROM "{table}"').fetchall():
                rows_seen += 1
                for value in row:
                    for candidate in candidates_from_value(value):
                        add_candidate(candidates, candidate)
        return {"rows_seen": rows_seen, "candidates": candidates}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-info", required=True)
    args = parser.parse_args()

    if not os.path.exists(args.key_info):
        print(json.dumps({"ok": False, "rows_seen": 0, "candidates": []}))
        return 2

    try:
        result = read_candidates(args.key_info)
    except Exception:
        print(json.dumps({"ok": False, "rows_seen": 0, "candidates": []}))
        return 3

    print(json.dumps({"ok": True, **result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
