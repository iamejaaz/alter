---
name: plain-writing
description: Write anything another person will read under the user's name the way a careful human writes it. Use it BEFORE drafting, and always before sending, a reply to a customer or support ticket, an email, a chat message, a GitHub comment, or issue and pull request text. Short, plain, answer first, nothing a reader would skip.
---

# Plain writing

The reader is a person with their own work to do. They read your message once, often on a phone, between other things. They asked a question or reported a problem, and they want to know what happens now. Every rule below follows from that.

A message that is correct but long, technical or hedged has failed. The reader cannot tell which sentence matters, so they stop trusting all of it.

## The shape of every message

1. The answer, in the first sentence. Yes or no. Bug or not. Fixed or not, and when they get it.
2. What they need to do. If the answer is nothing, say that.
3. Stop.

Your analysis makes the message correct. It does not go in the message.

## Rules

- **Short.** A reply to a customer is usually three to five short sentences. If it does not fit on a phone screen, cut it.
- **One idea per sentence.** Plain words a non-native speaker reads once.
- **What they see, not how it works.** Say "you get an error page instead of the login screen". Never name a function, a file, a cache, a session record, a commit, a branch or a backport to someone who did not ask about code. "The fix will be in Tuesday's release" is the whole status. Match their level and never go more technical than they did.
- **No dashes as punctuation.** No em dash, no en dash, no spaced hyphen. Use a full stop or a comma.
- **No warm-up.** No "just to close the loop", no "a quick update", no "I wanted to let you know". Start with the fact.
- **No praise or thanks for the question.** No "thanks for the detailed writeup", no "great question", no "your reading was correct, and it made this quick". A greeting line is enough.
- **No commentary on your own honesty or effort.** No "I do not want to tell you it is settled when it is not", no "we have not proven the link". Say what is known.
- **One sentence for what is unknown.** "We have not found what caused it yet. I will update you here when we do." No theories, no "plausible", no list of what was ruled out.
- **At most one hedge**, and only where the doubt is real. Not "should", "expected to" and "may" in the same paragraph.
- **One link**, the one they would click. Not the fix and its backports.
- **A date you were given is stated once, plainly.** "It will be in Tuesday's release." Never promise one you were not given.
- **No lists, headings, bold or code formatting** in a short message.
- **Greeting with their name, your name at the end.** Nothing else around it.

## A reply to a customer

Answer every question they asked, in their order, one sentence each. Then, only where it applies:

1. Whether it is a bug, or the real answer if it is not.
2. The status: fixed or not, and when it reaches them.
3. What to do until then.
4. The one thing still open.

An invented example. The customer wrote that staff see an error page after being logged in for a long time, and asked what causes it.

Too long, and it reads like a machine:

> Thanks for the detailed report — it made this quick to confirm. This is a bug in the session resume path: when the cached record comes back without a user, the lookup receives an empty value instead of treating the session as invalid, which is why an error page is shown rather than a redirect. The fix is merged in #101, with the backport at #102, and is expected to go out in the next release. On your first question, we have not established the cause yet; the failed deploys are a plausible source, but we have not proven the link and I do not want to tell you it is settled when it is not.

The same reply, written for the reader:

> Hi Asha,
>
> This is a bug on our side. The fix is merged and will be in Tuesday's release. After that, staff will be taken to the login screen instead of the error page.
>
> We have not found what causes it yet. I will update you here when we do.
>
> Until the release, clearing the site cache from your dashboard gets them working again.
>
> Regards,
> Sam

Same facts. A third of the length. Nothing the reader has to decode.

## Before it goes out

- Read it as the reader. Delete every sentence they would skip.
- **Show the user the exact text and wait for their yes before sending or posting it**, unless they told you to send without review. A message to a customer cannot be taken back.
- The user's own standing preferences, from memory or their instructions file, win wherever they differ from this skill.

## Other writing under the user's name

- **Commit message:** one line, `type: what changed`, lowercase after the colon, no trailing period.
- **Pull request:** a type prefixed title and a few bullets of what changed. One line of why, only when it is not obvious. No security details in a public description.
- **Review comment:** what you saw, then the change as a question. Three sentences at most, one concern per comment.
- **Never add a line saying a tool or an AI wrote it.**
