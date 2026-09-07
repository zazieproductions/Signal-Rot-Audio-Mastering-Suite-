# CI configuration

`github-actions-ci.yml` is the GitHub Actions workflow for this project. It runs the
format check, the linter, the 1,068-test Vitest suite and the production build, then runs
the Playwright browser suite in a separate job.

## Installing it

It lives here rather than in `.github/workflows/` because the automation account that
opened the initial pull request does not hold the `workflows` permission, and GitHub
rejects any push from such an account that creates or modifies a workflow file. Moving it
into place is a one-liner for anyone with normal write access:

```bash
mkdir -p .github/workflows
git mv ci/github-actions-ci.yml .github/workflows/ci.yml
git commit -m "ci: install the GitHub Actions workflow"
```

Nothing in the workflow needs editing first — it uses only `actions/checkout`,
`actions/setup-node`, `actions/upload-artifact` and `npm`, with no secrets.

## Running the same checks locally

```bash
npm run check      # format check is separate: npm run format:check
npm run test:e2e          # requires: npx playwright install chromium
npm run test:conformance  # requires: npx playwright install chromium firefox webkit
npm run lab:goldens && npm run lab:bench
```
