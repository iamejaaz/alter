# Connections and sign in

A connection is where Alter sends a chat. Settings, Connections lists them. The selected one is used for new chats, and each chat remembers its own connection, model and effort.

There are three kinds.

## 1. OpenAI compatible endpoint

Fields: Name, Base URL, Model, API key. Requests go through the Rust backend to `<Base URL>/chat/completions` with streaming on, so any host that speaks the OpenAI format works.

Presets fill the URL and a model: DeepSeek (`https://api.deepseek.com`), Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`), OpenRouter (`https://openrouter.ai/api/v1`). **Custom** adds an empty one.

- Keys are stored only on this device, in the app's web storage.
- **Test** sends one small request and lists the models the endpoint returns. `Connected. (No model list returned.)` means the endpoint answered but has no models route, which is fine.
- Gemini models run without tools, because the OpenAI format cannot carry the thought signature Gemini needs for tool round trips.
- When the active connection fails before any text streams, Alter retries the first reply on every other saved HTTP connection and tells you which one it switched to.

## 2. Claude Code

A connection with base URL `claude-code://local`. Alter runs the `claude` CLI with your Claude subscription. No key or URL.

**How Alter finds the CLI:** it checks PATH, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`.

**Status:** Settings runs `claude auth status --json` and shows `Signed in · <email>` with the version, or `Not signed in`.

**Sign in:** the button runs `claude auth login --claudeai` in the background, opens the login URL in your browser, and waits up to 5 minutes. If the browser did not open, click **Open the sign in page**. If that fails, **Sign in from Terminal instead** opens Terminal on the same command.

**Models:** the composer offers Opus, Sonnet and Haiku plus an effort level per chat.

**Permissions:** see [chat.md](chat.md). In Auto mode Claude Code runs with bypassed permissions. In Ask first mode every command or edit shows a card you must answer.

**Session continuity:** each chat keeps its Claude session id and resumes it, so follow ups are fast. The session is tied to the folder the chat runs in.

## 3. Codex

A connection with base URL `codex://local`. Alter runs `codex app-server` over stdio with your ChatGPT plan.

**How Alter finds it:** the same directories as above, then `/Applications/Codex.app/Contents/Resources/codex`.

**Status:** Settings runs `codex login status`, then makes one real request (`codex exec` with a read only sandbox, up to 90 seconds) because Codex can report signed in after its login expired. `Login expired` means that request failed.

**Sign in:** the button runs `codex login` and waits for the browser flow, same as Claude Code.

**Plan requirement:** Codex needs a ChatGPT Plus, Pro, Team or Enterprise plan. A free account shows `This ChatGPT account can't use Codex`.

**Modes:** Auto maps to `approvalPolicy: never` with full access, Ask first to `untrusted` with workspace write, Plan and Chat only to read only. Questions and approvals show as cards.

## Switching connection for a chat

Use the connection menu in the composer. It changes that chat only and is remembered on it. A message scheduled or queued into a chat you are not looking at uses that chat's own connection.

## Deleting a connection

Settings, Connections, Delete connection. Chats that used it keep their history and fall back to the selected connection when you continue them. The last connection cannot be deleted.

## Related

- Errors from sign in and connections: [troubleshooting.md](troubleshooting.md#connections-and-sign-in)
- The extension picks a connection per action: [bridge-and-extension.md](bridge-and-extension.md)
