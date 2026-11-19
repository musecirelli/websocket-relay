# Collaboration workflow — GitHub fork and pull request

This project lives on GitHub so it can be worked on from any
computer.

- **Canonical repo:** https://github.com/scirelli/websocket-relay
  (Steve's). `main` there is the source of truth.
- **Muse's fork:** https://github.com/musecirelli/websocket-relay
- Steve works directly on the canonical repo (or his own branches).
- Muse works on the fork and opens pull requests against
  `scirelli/websocket-relay:main`; Steve reviews and merges.

## Working flow

```sh
# clone your copy and keep the canonical repo as `upstream`
git clone git@github.com:<you>/websocket-relay.git
cd websocket-relay
git remote add upstream git@github.com:scirelli/websocket-relay.git

# stay current, branch, commit, push, open a PR
git fetch upstream && git rebase upstream/main
git switch -c my-change
git commit -s -m "area: short imperative summary"
git push origin my-change
# open the PR on GitHub against scirelli/websocket-relay:main
```

## Conventions

- One logical change per commit; a step = a small series of commits.
- Commit subjects: short, imperative, prefixed by area when useful
  (`server:`, `client:`, `rpc:`, `build:`, `docs:`).
- `Signed-off-by:` on commits (`git commit -s`).

## History

Until 2026-11-19 the project used a Linux-kernel-style patch flow
(`git format-patch` series numbered globally 0001–0011, exchanged in
chat, applied with `git am`, bootstrap via `git bundle`). Steve
switched it to GitHub for multi-computer access; the patch series
and the commits are the same history — the first GitHub PR carries
everything past the last commit he had pushed (`2788929`).
