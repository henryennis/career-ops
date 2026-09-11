# Fork rules for agents

This checkout is a fork of career-ops-hq/career-ops. The `patched` branch carries the fork's changes as a rebased patch stack on top of `main`, which mirrors upstream exactly. `fork/README.md` explains the model. The rules below are the part you need before you touch a file.

1. Never run `node update-system.mjs apply`, `npm run update`, or the `update` mode in this checkout. To take upstream changes run `fork/sync-upstream.sh` and show its output.
2. Never commit to `main`.
3. Before editing a file upstream ships (anything tracked in git outside `fork/`), pick the lowest layer that holds the change, using the table in `fork/README.md`: personal data in the data root, configuration in the gitignored user-layer files, new files under `fork/`, and only then a patch to an upstream file.
4. Every commit on `patched` is one concern, subject in conventional-commit form, body ending with a trailer `Upstream-Status: Pending`, `Submitted <url>`, `Denied`, or `Inappropriate <reason>`.
5. `fork/status.sh` shows the stack and which patches keep conflicting. Three conflicts on the same patch means: upstream it, re-express it in a lower layer, or drop it.
6. Fork-only modes live in `fork/modes/`. When asked for a mode you do not know, look for `fork/modes/<name>.md` before saying it does not exist.
