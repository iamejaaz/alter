"""Show how a PR's own changes differ between the commit the bot reviewed and the new head.

Usage: python3 -I interdiff.py <app_path> <base_ref> <old_head> <new_head>
Compares the PR's patch at each commit, each taken against its own merge base,
so a rebase onto a newer base branch adds no noise. Works after a force push.
"""

import difflib
import os
import subprocess
import sys

MAX_LINES = 1500


def git(cwd, *args, check=False):
	result = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
	if check and result.returncode:
		sys.exit(result.stderr.strip() or f"git {' '.join(args)} failed")
	return result.stdout


def have(app, sha):
	return subprocess.run(["git", "-C", app, "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True).returncode == 0


def patch(app, base_ref, head):
	merge_base = git(app, "merge-base", base_ref, head, check=True).strip()
	return git(app, "diff", "--no-color", "--no-renames", f"{merge_base}..{head}", check=True)


def main():
	if len(sys.argv) != 5:
		sys.exit("usage: interdiff.py <app_path> <base_ref> <old_head> <new_head>")
	app, base_ref, old, new = os.path.abspath(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
	remote = "upstream" if git(app, "remote", "get-url", "upstream").strip() else "origin"
	for sha in (old, new):
		if not have(app, sha):
			git(app, "fetch", "--quiet", "--no-tags", remote, sha)
		if not have(app, sha):
			sys.exit(f"commit {sha} is not available any more; review the whole PR as a first review")
	before, after = patch(app, base_ref, old).splitlines(), patch(app, base_ref, new).splitlines()
	delta = [line for line in difflib.unified_diff(before, after, "reviewed", "head", n=2, lineterm="")]
	changed = sum(1 for line in delta if line[:1] in "+-" and not line.startswith(("+++", "---")))
	print(f"PR patch: {len(before)} lines at {old[:10]}, {len(after)} lines at {new[:10]}; {changed} lines differ.")
	if not delta:
		print("The PR's own changes are identical: only the base moved. Re-check open findings, no new review needed.")
		return
	if changed > max(len(after), 1) * 0.6:
		print("Most of the PR changed: review the whole PR as a first review.")
		return
	print("Lines starting with '-' or '+' are patch lines that were dropped or added since the reviewed commit.")
	print("\n".join(delta[:MAX_LINES]))
	if len(delta) > MAX_LINES:
		print(f"... {len(delta) - MAX_LINES} more lines cut; read the rest with git diff on the files named above")


if __name__ == "__main__":
	main()
