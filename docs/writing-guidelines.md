# Writing Nightlight documentation

How we write the README and the guides. It applies to new and edited user-facing text; don't rewrite unrelated files just to match it. Code comments, API contracts and tests can be more technical.

## Who we write for

Two groups: **parents** who want a reliable, private way to keep an eye on their children, and **self-hosters** who care about Docker, networking, privacy and how it works. Assume they're smart but haven't met the underlying technology. The aim is to communicate, not to show how much we know.

## How it should sound

- Plain, natural English: short sentences, active voice, everyday words. Technical terms stay when they matter.
- Say what a thing does and why you'd want it first. How it works comes after, if the reader needs it. For remote access, say how to watch away from home before explaining STUN or UDP forwarding.
- No hype ("seamless", "powerful", "cutting-edge") and no invented backstory, promises or benchmarks.
- Be calm and honest. Put a warning where the reader needs it and link to it from elsewhere, rather than a disclaimer on every page.
- Spelling for new and edited text is Australian/British (organise, behaviour). Don't mass-rewrite older pages to match.

Instead of "Nightlight leverages WebRTC technology to facilitate low-latency video streaming", write "Watch your cameras live with very little delay."

## Where things go

| Level | What belongs there |
| --- | --- |
| **README** | The front door: what Nightlight is, a screenshot or two, what it can do, what you need, how to install it, where to read more. Roughly 150-250 lines. |
| **Guides** (`docs/*.md`) | How to set up and use a feature, in order of what the reader wants to do. |
| **Reference** | Settings and environment variables, networking detail, architecture, known limits. Today most of this is in [readme-reference.md](readme-reference.md), which is being split into guides. |

Don't add feature descriptions, environment variables or troubleshooting to the README. When a feature ships, decide: a one-line README mention, an update to an existing guide, a new guide, or nothing. Check for an existing guide before creating one, and link to the authoritative page instead of repeating it.

## Things we never lose when we shorten or move text

- **Settings** keep their default and their range, next to the setting. A setting that behaves differently from a neighbouring one says so.
- **Security and privacy** statements stay exact. Nightlight is self-hosted and sends no video to a Nightlight-hosted service, but it is not "offline": the default STUN server and any notification provider you configure are outside connections. Remote access adds risk.
- **Safety**: it is not a medical or safety device, and the docs must never suggest it can replace adult supervision.
- **Upgrade notes, compatibility limits, operational warnings and troubleshooting steps.** Move them, don't delete them. A removed section needs its links fixed (search the repo for `README.md#` and the old heading).
- **Honesty about the unknown.** If something is untested or unmeasured, say so. Describe planned features as planned. Check the code before stating a command, default or behaviour.

## Rules that are enforced

- Some README headings are pinned by tests (`Quick start` and `Running on Unraid`, in `backend/test/shutdown-grace-declared.test.js`), and `CHANGELOG.md`, `KNOWN-ISSUES.md`, `docs/recording.md` and `docs/notifications.md` are asserted on too. A change to them runs the whole test suite; it is not a docs-only change.
- Every `docker run` example in the docs must carry `--stop-timeout 30`, and the documented values must match the code.
- A user-visible change gets one `CHANGELOG.md` entry under `[Unreleased]`, under the existing heading for its type.
- Never write a child's name, or any other detail that identifies a household, into the docs. Say "a child".
- Don't hard-code one house's timezone, camera or setup into an example without saying it's an example.

## Before you finish

Read it as a newcomer. Is the benefit before the mechanism? Is anything repeated or only there for the writer? Do the links and anchors work? Do the commands and defaults match the current code? Are the warnings still there?

The test: a curious parent finds Nightlight on GitHub. Within 30 seconds they should know what it does, and within a minute find how to install it. An experienced self-hoster should find the detailed settings without digging through a giant README.
