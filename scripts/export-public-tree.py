#!/usr/bin/env python3
"""Materialize the current tracked/untracked worktree with archive exclusions.
Does not write Git metadata, follow symlinks or include ignored dependencies.
"""
from pathlib import Path
import fnmatch, shutil, subprocess, sys
root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve()
if target == root or root in target.parents:
    raise SystemExit("export target must be outside the source worktree")
if target.exists() and any(target.iterdir()):
    raise SystemExit("export target must be empty")
patterns = []
for line in (root / ".gitattributes").read_text().splitlines():
    words = line.split()
    if words and not words[0].startswith("#") and "export-ignore" in words[1:]:
        patterns.append(words[0].lstrip("/"))
def ignored(name):
    if name == "node_modules" or name.startswith("node_modules/"):
        return True
    return any(name.startswith(p) if p.endswith("/") else fnmatch.fnmatchcase(name, p) for p in patterns)
result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root, capture_output=True, check=True)
files = sorted(set(result.stdout.decode().split("\0")) - {""})
target.mkdir(parents=True, exist_ok=True)
count = 0
for name in files:
    source = root / name
    if ignored(name) or not source.exists():
        continue
    if source.is_symlink():
        raise SystemExit("export refuses symlinks: " + name)
    if not source.is_file():
        continue
    dest = target / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    count += 1
print(f"export-public: materialized {count} current-worktree files in {target}; no Git metadata written")
