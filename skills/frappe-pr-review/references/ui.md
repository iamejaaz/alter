# UI and UX lens

Read this when a PR changes anything a user sees (JS, Vue, CSS, HTML and Jinja templates, print formats, labels) or when the person who asked wants a UI or UX review. Judge the change as the user who meets it, in the browser, not from the diff alone.

## Use it like a user
- Walk the real flow the PR changes, start to finish, on develop and on the PR head, and compare. Note every extra click, surprise, or dead end.
- Check the states, not just the happy path: empty (no records), loading, error (a failed request, a validation message), and long content (a long label, a long name, many rows, a value with no spaces).
- Check the narrow layouts: the side panel open, a small laptop width, and phone width where desk supports it. Nothing should overflow, overlap or scroll sideways.
- Check dark mode (`[data-theme="dark"]`): text contrast, borders, hover and selected states. Hard-coded colours usually break here.
- Check the keyboard: tab order, focus that you can see, Enter and Escape doing what a user expects in dialogs and grids.
- Check right-to-left (`frappe.utils.is_rtl`) when the change touches layout direction, alignment or icons that point somewhere.
- Check a user with fewer permissions: buttons and fields they cannot use should not show, and nothing should throw.
- Check that it matches its siblings: the same thing in list and report view, form and quick entry (`frappe.ui.form.make_quick_entry`), desk and portal. A new pattern in one place and the old one next to it is a finding.

## Desk conventions
- Components: Espresso `es-button` and `es-badge` (with `data-variant`, `data-size`, `data-theme`), not bootstrap `btn` and `badge`. Reuse desk components (tooltip, dropdown, autocomplete, `empty_state`) instead of building new ones.
- Icons: `frappe.utils.icon("name", "sm")`, never hand-written SVG.
- Colours: Espresso tokens (`--ink-gray-8`, `--outline-gray-*` and the like) instead of legacy aliases or literal colours. Gray for selection and hover, no blue or heavy black accents in desk.
- One primary button per view. No ALL CAPS labels. No inline styles or `!important`.
- CSS: extend an existing rule before adding one, define shared values once as a custom property, and remove rules the change made dead.
- Autosave and inline edits stay quiet when they succeed ("Saving..." while it runs, a lasting message only when it fails), no permanent "Saved" badge.

## Words on screen
- Every user-facing string goes through `__()` (or `_()` on the server), as a whole sentence with `{0}` placeholders, so it can be translated. Check that labels still fit when a translation is longer.
- Short, plain labels that match the ones next to them. A message tells the user what to do next, not what went wrong inside.

## Evidence
- For a visual finding, attach a screenshot of the exact spot, before and after when the change is a fix, and name the width or mode it shows.
- When the PR has no screenshots or video and changes the UI, ask for a before and after.
- Do not raise taste. A finding is a broken state, an inconsistency with the rest of desk, a convention the change breaks, or a flow that got harder. "I would use a different colour" is not one.
