# Alter browser extension

Use your Alter desktop app's models on any page. Talks to Alter's local bridge
(`localhost:8765`) — **no API keys live in the browser**, and Claude Code works
because Alter drives it. Each action remembers its own model.

## Install (Brave / Chrome, unpacked)

1. Make sure the Alter desktop app is running.
2. Open `brave://extensions` (or `chrome://extensions`), enable **Developer mode**.
3. **Load unpacked** → select this `extension/` folder.
4. Click the Alter toolbar icon → paste the **pairing token** from
   Alter → Settings → *Browser bridge* → **Save**.
5. Pick a model for **PR review** (and grammar). Done.

## PR review

Open any GitHub pull request → click **Review with Alter** (bottom-right) →
it pulls the PR diff and reviews it with a maintainer's lens using your chosen
model. Copy the result into a comment.

## Notes

- The bridge is token-gated and localhost-only.
- Private repos work — the diff is fetched with your GitHub session.
- Large diffs are truncated to 60k chars (noted in the prompt).
