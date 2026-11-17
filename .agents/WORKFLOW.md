# Collaboration workflow — Linux kernel style

This project is developed the way the Linux kernel is: **distributed,
patch-based, no GitHub.** There is no canonical hosted remote and no
pull requests. (The kernel's GitHub presence is a read-only mirror;
patches there are ignored. The real flow is `git format-patch` →
email → `git am`, with maintainers' trees on kernel.org.)

Our equivalent of the mailing list is this chat + email between Steve
and Muse. Our equivalent of kernel.org is a `git bundle` for the
initial clone.

## Bootstrap (once)

Muse sends `websocket-relay.bundle` (full history, exact commit IDs).

```sh
git clone websocket-relay.bundle websocket-relay
cd websocket-relay
git log --oneline   # should match the maintainer tree exactly
```

A bundle is a single file that acts as a read-only remote:
later you can also `git fetch ../websocket-relay.bundle` from a newer one.

## Receiving work (applying a patch series)

For each step, Muse sends a numbered patch series
(`0001-....patch`, `0002-....patch`, …) produced with `git format-patch`.

```sh
git am 00*.patch        # applies in order, preserves author + message
git log --oneline       # review what landed
```

If a patch doesn't apply cleanly, `git am --abort`, and we discuss —
same as a maintainer asking for a resend.

## Sending work (your changes back to Muse)

```sh
git add -A
git commit -s -m "relay: short imperative summary"
# -s adds Signed-off-by (kernel DCO convention)

git format-patch -1                 # one patch for the last commit
# or: git format-patch main~3..main # a series for the last 3
```

Send the `.patch` files back in chat or by email. Muse reviews them
(reply = review), then applies them to the maintainer tree with
`git am`. Review happens *before* applying, like LKML.

## Conventions

- One logical change per commit; a step = a small series.
- Commit subjects: short, imperative, prefixed by area when useful
  (`server:`, `client:`, `rpc:`).
- `Signed-off-by:` on commits (`git commit -s`).
- The maintainer tree lives on the MacBook Dev machine
  (`~/Sync/projects/websocket-relay/`); Muse is maintainer for now.
- Syncthing is *not* the sharing mechanism for this repo — it's just
  how files reach the Mac. Don't commit in a Syncthing-synced copy;
  work in your own clone.

## Why not GitHub?

No central host to depend on, full history on both sides, patches are
reviewable artifacts in the conversation itself, and it scales from
two devs to thousands — the kernel is the proof.
