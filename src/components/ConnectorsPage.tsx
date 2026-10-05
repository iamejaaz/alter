import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Connector, connectorKey, newId } from "../lib/store";
import { confirmDialog } from "../lib/confirm";
import Row, { action, field } from "./SettingsRow";
import Switch from "./Switch";

interface Props {
  connectors: Connector[];
  onChange: (c: Connector[]) => void;
  browserOn: boolean;
  onBrowser: (on: boolean) => void;
}

const PRESETS: { name: string; c: Omit<Connector, "id" | "enabled"> }[] = [
  {
    name: "Files in a folder",
    c: { name: "files", kind: "command", command: "npx", args: "-y @modelcontextprotocol/server-filesystem ~/Documents" },
  },
  { name: "Remote URL", c: { name: "", kind: "url", url: "https://" } },
  { name: "Command", c: { name: "", kind: "command", command: "", args: "" } },
];

export default function ConnectorsPage({ connectors, onChange, browserOn, onBrowser }: Props) {
  const [editing, setEditing] = useState<Connector | null>(null);
  const [claude, setClaude] = useState<{ name: string; what: string }[]>([]);
  useEffect(() => {
    void invoke<{ name: string; what: string }[]>("claude_mcp_servers").then(setClaude).catch(() => {});
  }, []);

  const what = (c: Connector) =>
    c.kind === "url" ? c.url || "no URL" : [c.command, c.args].filter(Boolean).join(" ") || "no command";
  const taken = (name: string, id: string) =>
    connectorKey(name) === "browser" || connectors.some((x) => x.id !== id && connectorKey(x.name) === connectorKey(name));

  if (editing) {
    const e = editing;
    const set = (patch: Partial<Connector>) => setEditing({ ...e, ...patch });
    const exists = connectors.some((x) => x.id === e.id);
    const clash = !!e.name.trim() && taken(e.name, e.id);
    const ready = !!e.name.trim() && !clash && (e.kind === "url" ? !!e.url?.trim() && e.url.trim() !== "https://" : !!e.command?.trim());
    const save = () => {
      if (!ready) return;
      onChange(exists ? connectors.map((x) => (x.id === e.id ? e : x)) : [...connectors, e]);
      setEditing(null);
    };
    return (
      <div>
        <div className="mb-1 flex items-center gap-2">
          <button onClick={() => setEditing(null)} className="text-[var(--txt-faint)] hover:text-[var(--txt)]" aria-label="Back to connectors">
            ←
          </button>
          <h1 className="text-[17px] font-semibold text-[var(--txt)]">{exists ? "Edit connector" : "New connector"}</h1>
        </div>
        <Row
          title="Name"
          desc={clash ? <span className="text-red-400">That name is already used.</span> : "Short and unique. Tools show up to the model under this name."}
          control={<input value={e.name} onChange={(ev) => set({ name: ev.target.value })} placeholder="github" className={`${field} w-72`} autoFocus />}
        />
        <Row
          title="Type"
          desc={e.kind === "url" ? "A remote MCP server reached over HTTP." : "A local MCP server Alter starts as a command."}
          control={
            <div className="flex gap-0.5 rounded-lg border border-[var(--bd)] p-0.5">
              {(["command", "url"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => set({ kind: k })}
                  className={`rounded-md px-2.5 py-1 text-[12px] ${e.kind === k ? "bg-[var(--panel-2)] text-[var(--txt)]" : "text-[var(--txt-dim)] hover:text-[var(--txt)]"}`}
                >
                  {k === "command" ? "Command" : "URL"}
                </button>
              ))}
            </div>
          }
        />
        {e.kind === "url" ? (
          <Row
            title="URL"
            control={<input value={e.url ?? ""} onChange={(ev) => set({ url: ev.target.value })} placeholder="https://example.com/mcp" className={`${field} w-72 font-mono`} />}
          />
        ) : (
          <>
            <Row
              title="Command"
              desc="The program to run, like npx, uvx or a full path."
              control={<input value={e.command ?? ""} onChange={(ev) => set({ command: ev.target.value })} placeholder="npx" className={`${field} w-72 font-mono`} />}
            />
            <Row title="Arguments" desc="Separated by spaces. Quote one that contains a space.">
              <input value={e.args ?? ""} onChange={(ev) => set({ args: ev.target.value })} placeholder="-y @scope/server-name" className={`${field} font-mono`} />
            </Row>
            <Row title="Environment" desc="One KEY=value per line, for tokens the server needs. Stored on this device.">
              <textarea value={e.env ?? ""} onChange={(ev) => set({ env: ev.target.value })} rows={3} placeholder="API_TOKEN=..." className={`${field} resize-none font-mono`} />
            </Row>
          </>
        )}
        {exists && (
          <Row
            title="Delete connector"
            control={
              <button
                onClick={async () => {
                  if (!(await confirmDialog(`Delete the connector "${e.name}"?`))) return;
                  onChange(connectors.filter((x) => x.id !== e.id));
                  setEditing(null);
                }}
                className={`${action} text-red-400`}
              >
                Delete
              </button>
            }
          />
        )}
        <div className="flex items-center justify-end gap-2 pt-4">
          <button onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 text-[13px] text-[var(--txt-dim)] hover:text-[var(--txt)]">
            Cancel
          </button>
          <button onClick={save} disabled={!ready} className={`${action} bg-[var(--panel-2)]`}>
            {exists ? "Save changes" : "Add connector"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-2 text-[17px] font-semibold text-[var(--txt)]">Connectors</h1>
      <p className="pb-1 text-[13px] text-[var(--txt-faint)]">
        MCP servers that give Claude Code and Codex chats extra tools. Turn one off and the next message in a chat runs without it. API connections use Alter's own tools.
      </p>
      <Row
        title="Browser"
        desc="Built in. Drives the agent browser window, so chats can open sites you are signed in to."
        control={<Switch on={browserOn} onChange={() => onBrowser(!browserOn)} />}
      />
      {connectors.map((c) => (
        <div key={c.id} className="flex items-center gap-4 border-b border-[var(--bd-soft)] py-3.5">
          <button onClick={() => setEditing(c)} className="min-w-0 flex-1 text-left">
            <span className={`block truncate text-[14px] ${c.enabled ? "text-[var(--txt)]" : "text-[var(--txt-dim)]"}`}>{c.name}</span>
            <span className="mt-0.5 block truncate font-mono text-[12px] text-[var(--txt-faint)]">{what(c)}</span>
          </button>
          <Switch on={c.enabled} onChange={() => onChange(connectors.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)))} />
        </div>
      ))}
      <Row title="Add a connector" desc="Start from one of these, then fill in the details.">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.name} onClick={() => setEditing({ ...p.c, id: newId(), enabled: true })} className={action}>
              {p.name}
            </button>
          ))}
        </div>
      </Row>
      {claude.length > 0 && (
        <>
          <p className="pt-6 pb-1 text-[14px] font-medium text-[var(--txt)]">Already in Claude Code</p>
          <p className="pb-1 text-[13px] text-[var(--txt-faint)]">
            Claude Code chats load these on their own. Manage them with <code className="rounded bg-[var(--input)] px-1 text-xs">claude mcp</code> in Terminal.
          </p>
          {claude.map((c) => (
            <div key={c.name} className="flex items-center gap-4 border-b border-[var(--bd-soft)] py-3 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-[var(--txt-dim)]">{c.name}</span>
                <span className="mt-0.5 block truncate font-mono text-[12px] text-[var(--txt-faint)]">{c.what}</span>
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
