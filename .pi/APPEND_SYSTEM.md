# Pi Effect repo rules

This repo builds a Pi package. Pi source is canonical for extension APIs.

Before editing Pi extension/package code here, reference the local shallow Pi source mirror:

- Check `.agent-source/pi/` first.
- If missing, create it:
  `mkdir -p .agent-source && git clone --depth 1 --filter=blob:none https://github.com/earendil-works/pi-mono.git .agent-source/pi`
- Keep source mirrors out of commits. Add `.agent-source/` and `.agent-sources/` to `.git/info/exclude`, not `.gitignore`, unless Joel explicitly wants those paths committed.
- Search `.agent-source/pi/packages/coding-agent/src/`, docs, and examples before calling something a Pi best practice.

Effect source follows the same source-first rule at `.agent-sources/effect/` inside target repos.

For GitHub comments and PR reviews, prefer ShitRatGit (`shitratgit[bot]`) through the ShitRat tooling when the app is installed for the repo owner. If ShitRat cannot access `joelhooks/pi-effect`, say that plainly instead of silently using Joel for bot-authored comments/reviews.
