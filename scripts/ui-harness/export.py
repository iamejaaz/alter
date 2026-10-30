import glob
import json
import os
import sqlite3
import sys

here = os.path.dirname(os.path.abspath(__file__))
app = os.path.expanduser("~/Library/Application Support/com.ejaaz.alter")
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 40

order = json.load(open(os.path.join(app, "chats", "_order.json")))[:limit]
chats = []
for cid in order:
    try:
        chats.append(json.load(open(os.path.join(app, "chats", f"{cid}.json"))))
    except (OSError, ValueError):
        pass

db = glob.glob(os.path.expanduser("~/Library/WebKit/com.ejaaz.alter/WebsiteData/Default/*/*/LocalStorage/localstorage.sqlite3"))
storage = {}
if db:
    for key, value in sqlite3.connect(db[0]).execute("select key, value from ItemTable"):
        storage[key] = value.decode("utf-16-le") if isinstance(value, bytes) else value
if "alter.settings" in storage:
    settings = json.loads(storage["alter.settings"])
    settings["apiKey"] = "sk-harness" if settings.get("apiKey") else ""
    for c in settings.get("connections", []):
        c["apiKey"] = "sk-harness" if c.get("apiKey") else ""
    storage["alter.settings"] = json.dumps(settings)
storage.pop("alter.localAllowed", None)

out = os.path.join(here, "data")
os.makedirs(out, exist_ok=True)
json.dump(chats, open(os.path.join(out, "chats.json"), "w"))
json.dump(storage, open(os.path.join(out, "storage.json"), "w"))
print(f"Exported {len(chats)} chats and {len(storage)} settings keys to {out} (API keys replaced).")
