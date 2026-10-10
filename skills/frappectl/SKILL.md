---
name: frappectl
description: Query and operate Frappe sites from the CLI via frappectl (alias `fr`) — the REST API v2 client. Use whenever the task means reading or writing data on a Frappe site (support.frappe.io helpdesk tickets, gameplan.frappe.io posts, frappe.io reports/activity, or any Frappe DocType) without a bench. Covers doctype introspection, doc CRUD, reports, files, and whitelisted method calls.
---

# frappectl (`fr`)

Agent-friendly client for Frappe REST API v2 (Frappe v16+). Ankush's official SDK — CRUD + RPC over REST, nothing else. Full built-in primer: **run `fr guide`** (no auth needed) — read it if anything below is unclear or the CLI has changed.

## Ground rules
- Output: add `--json` (or pipe) for clean JSON. Errors + `--debug` traces go to **stderr**.
- **Access is preconfigured. Never run auth commands or touch `FRAPPE_*` env vars.** If access fails, tell the user to fix their config — don't guess credentials.
- **Several profiles may exist, so pass `-s <profile>` and never guess the site.** Run `fr auth list` to see the configured profiles and which one is the default.
- A profile can allow writes, so double-check before any `doc create/update/delete/submit/cancel`.
- **Orient before guessing** field or DocType names: `fr doctype show <DT>` first.

## Cheatsheet
```bash
# Orient
fr -s <profile> doctype list                          # all DocTypes
fr -s <profile> doctype list --module HR --custom      # narrow
fr -s <profile> doctype show "Sales Invoice"           # fields, types, links, required, child tables
fr -s <profile> doctype show "Sales Invoice" --raw     # full unprocessed meta

# Documents (CRUD + lifecycle)
fr -s <p> doc list "Sales Invoice" -f status=Overdue -f 'grand_total>1000' \
   --fields name,customer,grand_total --order-by 'creation desc' --limit 50
fr -s <p> doc list "Sales Invoice" --all --json        # auto-paginate everything
fr -s <p> doc get "Sales Invoice" SINV-0001
fr -s <p> doc create ToDo --set description="Follow up" --set priority=High
cat doc.json | fr -s <p> doc create "Sales Invoice"    # JSON for child tables / nesting
fr -s <p> doc update ToDo abc123 --set status=Closed   # optimistic; --force to overwrite
fr -s <p> doc delete ToDo abc123
fr -s <p> doc submit|cancel|amend "Sales Invoice" SINV-0001

# Filters: repeat -f field=value (also >, <, >=, <=, like), OR
#   --filters-json '[["status","in",["Paid","Overdue"]]]'
#   (object form --filters-json '{"status":"Open"}' also works)

# Reports & read-only SQL
fr -s <p> report run "Accounts Receivable" -f company="Frappe" --json
fr -s <p> query 'select count(*) as users from tabUser'   # needs System Manager/Administrator

# Files
fr -s <p> file upload ./contract.pdf --doctype "Sales Invoice" --name SINV-0001 --private
fr -s <p> file download <File name|/files/url> -o out.pdf  # -o - streams to stdout
#   file upload returns a file_url — use THAT (Frappe dedupes by content hash), not the name you passed.

# Discover & call methods (rpc = dotted path; doctype = controller method on a doc)
fr -s <p> method search --query="unread"
fr -s <p> method list                                  # global rpc + doctype index
fr -s <p> method list --doctype "User"
fr -s <p> method show frappe.tests.test_api.test       # rpc detail
fr -s <p> method show --doctype "User" add_comment
fr -s <p> method call gameplan.api.get_unread_count -F project=1
fr -s <p> method call add_comment --doctype "User" --name Administrator -F comment_type=Comment

# Raw API (escape hatch)
fr -s <p> api method/frappe.client.get_count -F doctype=User          # -F typed, -f raw string
fr -s <p> api method/frappe.client.get_list -F doctype=User -F 'filters:={"enabled":1}'  # := raw JSON
fr -s <p> api document/ToDo --method GET
```

## Field-format gotcha
`--fields` takes a **comma-separated string** (`--fields name,owner,creation`) OR a JSON array. The bracketed-quoted form `'["name","owner"]'` is what the guide shows for JSON, but a half-quoted list like `["name",owner]` throws `Invalid field format for SELECT`. When unsure, use the plain comma form.

## Debugging a failing call
Add `--debug` — it prints the actual HTTP request plus the **server-side SQL and full traceback**. Reach for this before poking blindly. Agents can also inspect the source of whitelisted methods at runtime.

