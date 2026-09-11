<!-- fork: begin -->
## Fork rules (appended by fork/bootstrap.sh; the full model is in fork/README.md)

- This checkout is a fork that carries its own patches on the `patched` branch. Never run `node update-system.mjs apply`, `npm run update`, or the `update` mode here: their raw checkout freezes every locally changed system file and commits a history that no longer rebases. When I ask for an update, run `fork/sync-upstream.sh` and show me its output.
- Before editing any file that upstream ships (anything tracked in git outside `fork/`), read `fork/README.md` and pick the lowest layer that can hold the change. A change to an upstream file is one commit with an `Upstream-Status:` trailer.
- Fork-only modes live in `fork/modes/`. When I invoke a mode you do not know, look for `fork/modes/<name>.md` before saying it does not exist.
<!-- fork: end -->
