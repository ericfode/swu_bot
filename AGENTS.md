# Working on swu_bot

Read `CLAUDE.md` for repository architecture, constraints, and the advisory Perch
lint policy; it applies to Codex work too. `README.md` has the portable setup.

- Use Node 22 (`.nvmrc`) and `npm run setup` on macOS or Linux. It uses the
  committed lockfiles and the pinned `forceteki` submodule.
- `npm run smoke` runs the existing unit/analysis tests and builds both viewers.
  A source snapshot without Git history uses the narrower `npm run smoke:source`;
  see `README.md` for the explicit omissions and Linux build memory guidance.
  `npm run gate` checks real seeded games after card data is installed and exits
  1 if the step counts or winners drift.
- Keep changes to the engine's tracked source out of this repo's work unless the
  user authorizes them. Dependency installs, card downloads, and generated builds
  are ordinary setup operations, not engine source edits.
- Basic development needs no service credentials. Keep tokens and `.env` files
  out of Git and transfer archives. External analysis, Perch, Karabast, and Fly
  have separate authentication or cost requirements; setup does not run them.
