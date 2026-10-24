from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path

from code_review_graph.graph import GraphStore
from code_review_graph.search import hybrid_search


def hit(results: list[dict], question: dict) -> bool:
    paths = [str(item.get("file_path", "")) for item in results]
    names = [str(item.get("qualified_name", item.get("name", ""))) for item in results]
    return any(any(path == expected or path.endswith(expected) for path in paths) for expected in question.get("expectedPaths", [])) or any(any(name == expected or name.endswith(f".{expected}") or expected in name for name in names) for expected in question.get("expectedSymbols", []))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--questions", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    repo = Path(args.repo).resolve()
    db = repo / ".code-review-graph" / "graph.db"
    questions = json.loads(Path(args.questions).read_text())
    store = GraphStore(db)
    rows = []
    try:
        for question in questions:
            query = question["query"]
            warm = hybrid_search(store, query, limit=20)
            timings = []
            result = warm
            for _ in range(7):
                started = time.perf_counter()
                result = hybrid_search(store, query, limit=20)
                timings.append((time.perf_counter() - started) * 1000)
            payload = json.dumps(result, ensure_ascii=False, default=str).encode()
            rows.append({
                "query": query,
                "hit": hit(result, question),
                "medianMs": sorted(timings)[len(timings) // 2],
                "minMs": min(timings),
                "resultCount": len(result),
                "resultBytes": len(payload),
                "topResults": result[:5],
            })
    finally:
        store.close()
    conn = sqlite3.connect(db)
    stats = {
        "dbBytes": db.stat().st_size,
        "nodes": conn.execute("select count(*) from nodes").fetchone()[0],
        "edges": conn.execute("select count(*) from edges").fetchone()[0],
        "files": conn.execute("select count(distinct file_path) from nodes").fetchone()[0],
        "fts": conn.execute("select count(*) from nodes_fts").fetchone()[0],
    }
    conn.close()
    report = {
        "tool": "code-review-graph",
        "repo": str(repo),
        "stats": stats,
        "questions": {"total": len(rows), "hits": sum(row["hit"] for row in rows), "recall": sum(row["hit"] for row in rows) / len(rows)},
        "aggregate": {
            "medianMs": sorted(row["medianMs"] for row in rows)[len(rows) // 2],
            "resultBytes": sum(row["resultBytes"] for row in rows),
            "medianResultBytes": sorted(row["resultBytes"] for row in rows)[len(rows) // 2],
        },
        "rows": rows,
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("stats", "questions", "aggregate")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
