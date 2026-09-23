#!/usr/bin/env python3
"""One-shot ticket context for the support agent.

Usage: context.py <ticket id> [--site <fr profile>] [--json]

Runs the handful of `fr` calls a diagnosis needs, in parallel, and prints one
markdown bundle: the ask, the site and its installed apps (live from Frappe
Cloud, else the snapshot stored on the ticket), the thread with a trust label
per message, bot output kept apart as unverified hypotheses, and up to five
similar resolved tickets with their most useful staff reply. Deterministic, no
model calls, ~1-2s.

`fr` is run bare when FRAPPE_SITE/FRAPPE_API_KEY are set (the agent env);
otherwise pass --site, or it falls back to `-s support.frappe.io`.
"""
import html
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

STAFF_DOMAINS = ("@frappe.io", "@erpnext.com")
AUTOMATION = ("support-bot@", "cloud@frappe.io", "noreply@", "no-reply@", "notifications@")
CAP_CUSTOMER, CAP_STAFF, CAP_BOT, CAP_TOTAL = 3000, 1500, 600, 14000


def fr_args(site):
    if site:
        return ["fr", "-s", site]
    if os.environ.get("FRAPPE_SITE") and os.environ.get("FRAPPE_API_KEY"):
        return ["fr"]
    return ["fr", "-s", "support.frappe.io"]


def run(base, *args):
    try:
        out = subprocess.run(base + list(args), capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    if out.returncode != 0:
        return None, (out.stderr or out.stdout).strip()[:300]
    try:
        return json.loads(out.stdout), None
    except json.JSONDecodeError:
        return None, out.stdout.strip()[:300]


def clean(s):
    if not s:
        return ""
    s = re.sub(r"<(br|/p|/div|/li|/tr)\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    # drop quoted history in email replies
    s = re.split(r"\n\s*(From:\s.+?Sent:|On .{6,80} wrote:|-{5,}\s*Original Message)", s, maxsplit=1)[0]
    s = re.sub(r"[ \t\xa0]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def role(sender):
    s = (sender or "").lower()
    if any(a in s for a in AUTOMATION):
        return "automation"
    if any(s.endswith(d) for d in STAFF_DOMAINS):
        return "staff"
    return "customer"


def parse_apps(raw):
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    if isinstance(data, dict):
        data = data.get("apps") or []
    apps = []
    for a in data or []:
        if not isinstance(a, dict) or not a.get("app"):
            continue
        apps.append({
            "app": a.get("app"),
            "branch": a.get("branch") or "",
            "version": a.get("tag") or "",
            "commit": (a.get("hash") or a.get("commit") or "")[:10],
            "repo": a.get("repository_url") or "",
        })
    return apps


IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp")


def fetch_attachments(base, ticket, rows):
    out_dir = os.path.join(os.environ.get("TMPDIR", "/tmp"), "alter-tickets", str(ticket))
    os.makedirs(out_dir, exist_ok=True)
    result = []

    def get(r):
        name = r.get("file_name") or os.path.basename(r.get("file_url") or "")
        path = os.path.join(out_dir, name)
        if not os.path.exists(path):
            try:
                subprocess.run(base + ["file", "download", r["name"], "-o", path], capture_output=True, timeout=60)
            except subprocess.TimeoutExpired:
                return None
        return (name, path if os.path.exists(path) else None)

    images = [r for r in rows if (r.get("file_name") or "").lower().endswith(IMAGE_EXT)][:6]
    others = [r for r in rows if r not in images]
    with ThreadPoolExecutor(max_workers=4) as ex:
        for got in ex.map(get, images):
            if got:
                result.append(got)
    for r in others:
        result.append((r.get("file_name"), None))
    return result


STOP = {"the", "and", "for", "with", "not", "from", "this", "that", "when", "after", "issue", "error", "problem",
        "frappe", "erpnext", "site", "help", "please", "urgent", "have", "has", "there", "their", "been", "being",
        "unable", "able", "want", "need", "getting", "give", "gives", "show", "shows", "showing", "doing", "does",
        "hello", "team", "dear", "kindly", "regards", "thanks", "thank", "support", "ticket", "customer", "client",
        "using", "used", "user", "users", "would", "could", "should", "also", "some", "same", "here", "were",
        "https", "http", "www", "com", "screenshot", "attached", "please", "re:", "fwd:"}


def keywords(text, limit=8):
    seen, out = set(), []
    for w in re.findall(r"[a-zA-Z][a-zA-Z_]{3,}", (text or "").lower()):
        if w in STOP or w in seen:
            continue
        seen.add(w)
        out.append(w)
        if len(out) >= limit:
            break
    return out


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    ticket = args[0]
    site = args[args.index("--site") + 1] if "--site" in args else None
    as_json = "--json" in args
    base = fr_args(site)

    q_comms = ("select creation, sender, sent_or_received, content from `tabCommunication` "
               f"where reference_doctype='HD Ticket' and reference_name='{ticket}' order by creation")
    q_comments = ("select creation, commented_by, content from `tabHD Ticket Comment` "
                  f"where reference_ticket='{ticket}' order by creation")
    q_files = ("select name, file_name, file_url from `tabFile` where attached_to_doctype='HD Ticket' "
               f"and attached_to_name='{ticket}' order by creation")

    with ThreadPoolExecutor(max_workers=4) as ex:
        f_doc = ex.submit(run, base, "doc", "get", "HD Ticket", ticket, "--json")
        f_comms = ex.submit(run, base, "query", q_comms, "--json")
        f_comments = ex.submit(run, base, "query", q_comments, "--json")
        f_apps = ex.submit(run, base, "method", "call", "get_installed_app_versions", "-f", f"ticket={ticket}")
        f_files = ex.submit(run, base, "query", q_files, "--json")
        doc, err_doc = f_doc.result()
        comms, _ = f_comms.result()
        comments, _ = f_comments.result()
        live, _ = f_apps.result()
        files, _ = f_files.result()
    attachments = fetch_attachments(base, ticket, files or [])

    if not doc:
        print(f"Could not read HD Ticket {ticket}: {err_doc}")
        sys.exit(1)
    doc = doc.get("data", doc)

    # apps: live first, ticket snapshot second
    apps, apps_source = [], "none"
    live_msg = (live or {}).get("message") if isinstance(live, dict) else None
    if live_msg and live_msg.get("apps"):
        apps, apps_source = parse_apps(live_msg), "Frappe Cloud (live)"
    elif doc.get("custom_installed_apps"):
        apps, apps_source = parse_apps(doc["custom_installed_apps"]), "ticket snapshot (at creation)"
    live_err = (live_msg or {}).get("error") if isinstance(live_msg, dict) else None

    # Similar resolved tickets. The old query ORed the sub-module in, so any recent
    # closed ticket in the module matched and the list was usually unrelated. Now a
    # candidate must share wording with THIS ticket, and the module only ranks it.
    sub = doc.get("custom_sub_reference_module") or ""
    app = doc.get("custom_app") or ""
    subj_kws = keywords(doc.get("subject"), 6)
    body_kws = [k for k in keywords(clean(doc.get("description")), 12) if k not in subj_kws]
    similar, best = [], {}
    if subj_kws or body_kws:
        def q_sim(cond, limit):
            return ("select name, subject, ticket_type, custom_app, custom_sub_reference_module, creation "
                    "from `tabHD Ticket` where status in ('Closed','Resolved') "
                    f"and name<>'{ticket}' and ticket_type not in ('Invalid','Duplicate','Spam') and ({cond}) "
                    f"and creation > date_sub(now(), interval 365 day) order by creation desc limit {limit}")

        # Three passes, because one broad OR capped at N rows fills up with the
        # commonest word ("backup") and never reaches the ticket that shares the
        # rare one. The narrow passes go first and the broad one only adds recall.
        queries = []
        if len(subj_kws) >= 3:
            queries.append(q_sim(" and ".join(f"subject like '%{k}%'" for k in subj_kws[:3]), 15))
        if len(subj_kws) >= 2:
            queries.append(q_sim(" and ".join(f"subject like '%{k}%'" for k in subj_kws[:2]), 15))
        queries.append(q_sim(" or ".join(f"subject like '%{k}%'" for k in subj_kws + body_kws), 50))
        with ThreadPoolExecutor(max_workers=3) as ex:
            passes = list(ex.map(lambda q: run(base, "query", q, "--json")[0] or [], queries))
        rows, seen_ids = [], set()
        for got in passes:
            for r in got:
                if r["name"] not in seen_ids:
                    seen_ids.add(r["name"])
                    rows.append(r)
        # A word that half the candidates share ("backup", "error") says nothing;
        # a rare one ("pypika", "wait_timeout") says a lot. Weight by how rare the
        # word is inside this candidate set, which needs no corpus and no model.
        import math

        subjects = [(r.get("subject") or "").lower() for r in rows]
        df = {k: sum(1 for t in subjects if k in t) or 1 for k in subj_kws + body_kws}
        idf = {k: math.log(1 + len(rows) / df[k]) for k in df}
        # Two words that sit together in this subject are a phrase worth matching.
        pairs = [f"{a} {b}" for a, b in zip(subj_kws, subj_kws[1:])
                 if f"{a} {b}" in (doc.get("subject") or "").lower()]

        def rank(r):
            subject = (r.get("subject") or "").lower()
            hits = [k for k in subj_kws if k in subject]
            weak = [k for k in body_kws if k in subject]
            score = sum(3 * idf[k] for k in hits) + sum(idf[k] for k in weak)
            score += 4 * sum(1 for p in pairs if p in subject)
            if sub and r.get("custom_sub_reference_module") == sub:
                score += 2
            if app and r.get("custom_app") == app:
                score += 1
            return score, len(hits) + len(weak), hits + weak

        scored = []
        for r in rows:
            score, n, words = rank(r)
            # One shared word is a coincidence unless the module agrees too.
            if n >= 2 or (n == 1 and sub and r.get("custom_sub_reference_module") == sub):
                r["matched"] = words
                scored.append((score, r))
        # rows already arrive newest first, so a stable sort by score keeps recency
        # as the tie-break
        scored.sort(key=lambda x: -x[0])
        similar = [r for _, r in scored[:5]]
        if similar:
            ids = ",".join(f"'{r['name']}'" for r in similar)
            q_best = ("select reference_name, content from `tabCommunication` where reference_doctype='HD Ticket' "
                      f"and reference_name in ({ids}) and sent_or_received='Sent' and length(content) > 200 "
                      "order by length(content) desc limit 25")
            rows, _ = run(base, "query", q_best, "--json")
            for r in rows or []:
                best.setdefault(r["reference_name"], clean(r["content"])[:500])

    # thread with roles
    thread, hypotheses = [], []
    for c in comms or []:
        r = role(c.get("sender"))
        text = clean(c.get("content"))
        if not text:
            continue
        if r == "automation":
            hypotheses.append(("email", c.get("sender"), text[:CAP_BOT]))
            continue
        cap = CAP_CUSTOMER if r == "customer" else CAP_STAFF
        thread.append((c.get("creation", "")[:16], r, c.get("sender"), text[:cap]))
    notes = []
    for c in comments or []:
        r = role(c.get("commented_by"))
        text = clean(c.get("content"))
        if not text:
            continue
        if r == "automation":
            hypotheses.append(("comment", c.get("commented_by"), text[:CAP_BOT]))
        else:
            notes.append((c.get("creation", "")[:16], c.get("commented_by"), text[:CAP_STAFF]))

    gaps = []
    if not doc.get("custom_site_name"):
        gaps.append("no site on the ticket")
    if not apps:
        gaps.append("no installed-apps data" + (f" ({live_err})" if live_err else ""))
    desc = clean(doc.get("description"))
    if not re.search(r"version|v1[3-6]|\b1[3-6]\.\d", desc, re.I) and not apps:
        gaps.append("version not stated")

    out = []
    out.append(f"# HD Ticket {ticket} — context")
    out.append(f"**Subject**: {doc.get('subject')}")
    meta = [f"queue: {doc.get('custom_app') or '?'}", f"type: {doc.get('ticket_type') or '?'}",
            f"team: {doc.get('agent_group') or '?'}",
            f"module: {doc.get('custom_reference_module') or '?'}/{sub or '?'}",
            f"site: {doc.get('custom_site_name') or 'not set'}", f"plan: {doc.get('custom_plan') or '?'}"]
    if doc.get("custom_pull_request"):
        meta.append(f"PR field: {doc['custom_pull_request']}")
    if doc.get("custom_is_awaiting_release"):
        meta.append("awaiting release")
    out.append("**Ticket**: " + " · ".join(meta))
    out.append("")
    out.append(f"## Site apps — source: {apps_source}")
    if apps:
        out.append("| app | branch | version | commit |\n|---|---|---|---|")
        for a in apps:
            out.append(f"| {a['app']} | {a['branch']} | {a['version'] or '-'} | {a['commit'] or '-'} |")
        out.append("Read code at these exact refs. Apps not in the local bench: fetch the repo (gh / shallow clone) at the tag or commit.")
    else:
        out.append("None available. Resolve the app and version from the customer's own words below, and say so.")
    out.append("")
    out.append("## Customer's report (description)")
    out.append(desc[:CAP_CUSTOMER] or "(empty)")
    out.append("")
    out.append("## Thread — oldest first. customer = facts; staff = claims to verify")
    for when, r, sender, text in thread:
        out.append(f"- **[{r}]** {sender} · {when}\n  {text}")
    if notes:
        out.append("")
        out.append("## Internal notes (staff)")
        for when, who, text in notes:
            out.append(f"- {who} · {when}: {text}")
    out.append("")
    out.append("## Attachments — screenshots are facts the customer is pointing at: Read each image path before concluding")
    if attachments:
        for name, path in attachments:
            out.append(f"- {name}" + (f" → Read `{path}`" if path else " (not an image; download with `fr file download` if needed)"))
    else:
        out.append("- none")
    out.append("")
    out.append("## Bot output — hypotheses only, NOT evidence. Confirm or refute each one explicitly.")
    if hypotheses:
        for kind, who, text in hypotheses:
            out.append(f"- ({kind}, {who}) {text}")
    else:
        out.append("- none")
    out.append("")
    out.append("## Similar resolved tickets (hints, not proof)")
    if similar:
        for r in similar:
            reply = best.get(r["name"])
            matched = ", ".join(r.get("matched") or [])
            out.append(f"- #{r['name']} · {r.get('ticket_type') or '?'} · {r.get('custom_app') or '?'} · {r.get('subject')}"
                       + (f" (matched: {matched})" if matched else ""))
            if reply:
                out.append(f"  staff reply: {reply}")
    else:
        out.append("- none found")
    out.append("")
    out.append("## Gaps")
    out.append("- " + ("\n- ".join(gaps) if gaps else "none"))
    text = "\n".join(out)
    if len(text) > CAP_TOTAL:
        text = text[:CAP_TOTAL] + "\n…(truncated)"
    if as_json:
        slim = {k: doc.get(k) for k in ("name", "subject", "status", "ticket_type", "custom_app", "agent_group",
                                        "custom_reference_module", "custom_sub_reference_module", "custom_site_name",
                                        "custom_plan", "custom_pull_request", "custom_is_awaiting_release")}
        print(json.dumps({"ticket": slim, "apps": apps, "apps_source": apps_source, "hypotheses": len(hypotheses),
                          "attachments": [{"name": n, "path": p} for n, p in attachments],
                          "similar": [{"name": r["name"], "subject": r.get("subject"), "type": r.get("ticket_type"),
                                     "matched": r.get("matched") or []} for r in similar],
                          "gaps": gaps, "markdown": text}, default=str))
        return
    print(text)


if __name__ == "__main__":
    main()
