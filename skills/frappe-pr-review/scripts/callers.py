"""List the callers of every function a PR changes, across all apps on the bench.

Usage: python3 -I callers.py <app_path> <base_ref> [head_ref]
Prints, per changed function, whether its signature changed or it was removed,
and the call sites in files the PR does not touch. One command, capped output.
"""

import os
import re
import subprocess
import sys

CODE = (".py", ".js", ".ts", ".vue")
PY_DEF = re.compile(r"^(\s*)(?:async\s+)?def\s+(\w+)\s*\(")
JS_DEF = re.compile(
	r"^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)\s*\(|(\w+)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)|(\w+)\s*\([^)]*\)\s*\{)"
)
JS_KEYWORDS = {"if", "for", "while", "switch", "catch", "function", "return", "else"}
HOOK_NAMES = {
	"validate", "before_validate", "before_save", "after_save", "before_insert", "after_insert", "on_update",
	"on_submit", "on_cancel", "on_trash", "after_delete", "before_submit", "before_cancel", "on_change",
	"onload", "refresh", "setup", "execute", "run", "main", "get", "set", "update", "init", "render",
	"make", "load", "save", "submit", "cancel", "delete", "before_rename", "after_rename", "on_update_after_submit",
	"autoname", "before_naming", "db_insert", "db_update", "get_context", "get_list", "get_data",
}
TEST_FILE = re.compile(r"(^|/)(tests?|cypress)/|(^|/)test_[^/]*$|\.(spec|test)\.[jt]s$")
PER_NAME = 8
MAX_NAMES = 40
MAX_FILES = 150
TOO_COMMON = 60
MAX_LINES = 160


def git(cwd, *args):
	return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True).stdout


def defs_in(path, source):
	found = {}
	for number, line in enumerate(source.splitlines(), 1):
		name, indent = def_at(path, line)
		if name:
			found.setdefault(name, (number, line.strip(), indent))
	return found


def def_at(path, line):
	if path.endswith(".py"):
		m = PY_DEF.match(line)
		return (m.group(2), len(m.group(1))) if m else (None, 0)
	m = JS_DEF.match(line)
	if not m:
		return None, 0
	name = m.group(2) or m.group(3) or m.group(4)
	return (None, 0) if name in JS_KEYWORDS else (name, len(m.group(1)))


def enclosing(path, lines, number):
	line = lines[number - 1] if 0 < number <= len(lines) else ""
	name, _ = def_at(path, line)
	if name:
		return name
	indent = len(line) - len(line.lstrip()) if line.strip() else 10**6
	for index in range(number - 2, -1, -1):
		name, def_indent = def_at(path, lines[index])
		if name and def_indent < indent:
			return name
	return None


def changed_lines(diff):
	files, path, old = {}, None, None
	for line in diff.splitlines():
		if line.startswith("--- "):
			old = line[6:] if line.startswith("--- a/") else None
		elif line.startswith("+++ "):
			path = line[6:] if line.startswith("+++ b/") else old
			if path is not None:
				files.setdefault(path, {"new": set(), "old": set()})
		elif line.startswith("@@") and path:
			m = re.match(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
			o, oc, n, nc = int(m.group(1)), int(m.group(2) or 1), int(m.group(3)), int(m.group(4) or 1)
			files[path]["old"].update(range(o, o + oc))
			files[path]["new"].update(range(n, n + nc))
	return files


def main():
	if len(sys.argv) < 3:
		sys.exit("usage: callers.py <app_path> <base_ref> [head_ref]")
	app = os.path.abspath(sys.argv[1])
	base_ref, head = sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "HEAD"
	merge_base = git(app, "merge-base", base_ref, head).strip()
	if not merge_base:
		sys.exit(f"no merge base between {base_ref} and {head}")
	diff = git(app, "diff", "-U0", "--no-renames", f"{merge_base}..{head}", "--", *[f"*{ext}" for ext in CODE])
	touched = set(git(app, "diff", "--name-only", f"{merge_base}..{head}").split())
	changes = {}
	changed = changed_lines(diff)
	if len(changed) > MAX_FILES:
		print(f"{len(changed)} code files changed, too many to trace callers; check the PR's base branch, then review by area.")
		return
	for path, lines in changed.items():
		if not path.endswith(CODE) or TEST_FILE.search(path):
			continue
		head_src = git(app, "show", f"{head}:{path}")
		base_src = git(app, "show", f"{merge_base}:{path}")
		head_lines, base_lines = head_src.splitlines(), base_src.splitlines()
		head_defs, base_defs = defs_in(path, head_src), defs_in(path, base_src)
		names = {enclosing(path, head_lines, n) for n in lines["new"]} | {enclosing(path, base_lines, n) for n in lines["old"]}
		for name in filter(None, names):
			if name.startswith("__") or len(name) < 4:
				continue
			if name in base_defs and name not in head_defs:
				state = "removed"
			elif name not in base_defs:
				continue
			elif re.sub(r"\s+", "", base_defs[name][1]) != re.sub(r"\s+", "", head_defs[name][1]):
				state = "signature changed"
			else:
				state = "body changed"
			changes.setdefault(name, (path, state, base_defs[name][1]))

	if not changes:
		print("No changed functions that existed before this PR.")
		return
	apps_dir = os.path.dirname(app)
	apps = sorted(d for d in os.listdir(apps_dir) if os.path.isdir(os.path.join(apps_dir, d, ".git")))
	own = os.path.basename(app)
	head_sha = git(app, "rev-parse", head).strip()
	tree = [] if head_sha == git(app, "rev-parse", "HEAD").strip() else [head]
	listed = [n for n in changes if n not in HOOK_NAMES]
	if len(listed) > MAX_NAMES:
		listed = [n for n in listed if changes[n][1] != "body changed"][:MAX_NAMES]
		print(f"{len(changes)} functions changed: listing callers only for removed and signature changed ones.")
		changes = {n: changes[n] for n in listed}
	words = {n: re.compile(rf"(?<![\w]){re.escape(n)}(?![\w])") for n in listed}
	hits = {n: [] for n in listed}
	for other in apps if listed else []:
		args = ["grep", "-n", "-w", "-I", "-F"] + [x for n in listed for x in ("-e", n)] + (tree if other == own else [])
		for hit in git(os.path.join(apps_dir, other), *args).splitlines():
			if other == own and tree and hit.startswith(f"{head}:"):
				hit = hit[len(head) + 1 :]
			file, _, rest = hit.partition(":")
			number, _, text = rest.partition(":")
			if not file.endswith(CODE) or (other == own and file in touched):
				continue
			defined = def_at(file, text)[0]
			for n, word in words.items():
				if defined != n and word.search(text):
					hits[n].append(f"  {other}/{file}:{number}: {text.strip()[:110]}")
	out = []
	order = {"removed": 0, "signature changed": 1, "body changed": 2}
	for name, (path, state, signature) in sorted(changes.items(), key=lambda c: (order[c[1][1]], c[0])):
		if name in HOOK_NAMES:
			out.append(f"{name} [{state}] {path}: framework hook name, called by the framework, not listed")
			continue
		found = hits[name]
		header = f"{name} [{state}] {path}  base: {signature[:110]}"
		if not found:
			out.append(f"{header}\n  no callers outside the files this PR changes")
		elif len(found) > TOO_COMMON:
			out.append(f"{header}\n  {len(found)} matches, name too common to list; grep a qualified use only if the contract changed")
		else:
			out.append("\n".join([header, *found[:PER_NAME]] + ([f"  ... {len(found) - PER_NAME} more"] if len(found) > PER_NAME else [])))
	text = "\n".join(out).splitlines()
	print("\n".join(text[:MAX_LINES]))
	if len(text) > MAX_LINES:
		print(f"... {len(text) - MAX_LINES} more lines cut; check removed and signature changed first")


if __name__ == "__main__":
	main()
