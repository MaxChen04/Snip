# Contributing to Snip

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Issues

- **Bug:** use the bug report template. Include the URL you captured (if it's public), what you expected, and what happened. Capture agent logs help a lot.
- **Idea:** use the feature request template and describe the problem before the solution.
- **Security:** don't open a public issue. Use [GitHub's private vulnerability reporting](https://github.com/MaxChen04/Snip/security/advisories/new).

## Pull requests

1. Fork the repo and branch from `main`.
2. Set up local development as described in the [README](README.md#running-from-source). `npm run doctor` checks it.
3. Keep each PR to one change. For anything large, open an issue first so we can agree on the approach.
4. Run the same checks CI runs:
   ```bash
   npm run typecheck
   npm run build -w web
   npm test
   ```
5. Open the PR and fill in the template. The `core` check has to pass.

Only the maintainer ([@MaxChen04](https://github.com/MaxChen04)) merges into `main`. Contributors who help regularly may be given triage or write access.

## Contributor License Agreement

Before your first PR can be merged, you need to agree to the [Contributor License Agreement](CLA.md). A bot comments on your first PR with instructions: reply with the sentence it gives you. You only do this once.

The CLA lets the maintainer keep licensing Snip, including changing its license in the future, without tracking down every contributor. You keep the copyright to your work.

## License

Snip is source-available under the [Apache License 2.0 with the Commons Clause](LICENSE). By contributing, you agree your contributions are covered by the CLA and are distributed under that license.
