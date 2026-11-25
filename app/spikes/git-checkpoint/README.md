# Spike S4 · Git checkpoint with a temporary index

Question: can Blue snapshot the state of a folder (tracked and untracked files) before and after each turn, to get per-turn diffs and restores, without touching the user's index, working tree and branch?

## How to run

```bash
node run.ts                      # synthetic repos
node run.ts <repo> [<repo> …]    # also timings on local clones of real repos (the original is not touched)
```

Results in `results/run.json`.

## How it works

`checkpoint.ts`:

1. copies the user's index to a temporary file (`GIT_INDEX_FILE`), so git reuses the stat information;
2. `git add -A` on the temporary index: untracked files get in, ignored ones stay out;
3. `write-tree` and `commit-tree` with HEAD as parent, "Blue" identity;
4. `update-ref refs/blue/<session>/<label>`: the commit is not on any branch.

Restore first saves the current state in a safety checkpoint, then writes the checkpoint's files with a temporary index and removes those created afterwards.

## Results (2026-11-07, arm64 MacBook)

| Check | Outcome |
|---|---|
| User's index, status, stage, HEAD, branch and working tree unchanged | ✅ |
| Untracked files included, ignored files excluded | ✅ |
| The private ref does not show up among the branches | ✅ |
| Diff between two checkpoints = only the turn's changes (including deletions) | ✅ |
| Exact restore, index unchanged, previous state saved | ✅ |
| Cleanup of a session's refs | ✅ |

| Time per checkpoint | read-tree | index copy |
|---|---|---|
| Synthetic, 5,000 files | 425 ms | 80 ms |
| monorepo A, 1,675 files | 265 ms | 72 ms |
| repository B, 2,701 files | 380 ms | 77 ms |

## Conclusions for Blue

- Always use the index copy: it is 4–5 times faster and stays under 100 ms on the real repos tested. It can be done at every turn start and end without being noticed.
- In a worktree `rev-parse --absolute-git-dir` returns the worktree's git folder, with its index: the same code works.
- Checkpoint commits stay reachable as long as the ref exists. When a session is archived, Blue deletes `refs/blue/<session>/*`; the normal `git gc` then frees the space.
- To handle in phase 2: very large untracked files (a size limit beyond which the file is excluded and reported) and repos without an initial commit (today `HEAD` is mandatory).
- The clones used for the timings contain neither `node_modules` nor builds: in real repos they are ignored, and git does not enter ignored folders, so the timings should not change much. To be measured again inside the app.
