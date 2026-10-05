# Contributing

Thanks for helping improve Usage Meter for Claude.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Theme ideas don't need a code change. Share your `theme.css` in an issue or discussion instead.

## Set up

Requires Node.js 20 or newer.

```bash
git clone https://github.com/ayushvjain/usage-meter-for-claude.git
cd usage-meter-for-claude
npm install
npm start
npm test
```

## Making a change

1. Create a branch from `main`, named by type: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
2. Keep pull requests focused on one change.
3. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) style, for example `fix(parser): handle limits without a reset time`.
4. Add or update tests in `test/` for any logic change. Logic lives in `src/shared/core.js` so it can be tested without Electron.
5. Run `npm test` before you push. Pull requests can't be merged until the CI check passes and the maintainer has approved them.

## If claude.ai changes its response

Most breakages will come from claude.ai changing its private usage endpoint.

1. Save the new response as a file in `test/fixtures/`, with every id replaced by a placeholder.
2. Add a test that parses it and checks the bars you expect.
3. Update `parseUsage` in `src/shared/core.js` until the test passes.

## Privacy

Never commit or paste session cookies, `sessionKey` values, request headers, or real organization ids. Fixtures must contain placeholder ids only.
