# Contributing

Thanks for your interest. Issues and pull requests are welcome.

## License of contributions

By sending a contribution, you agree that it is licensed under the same
[PolyForm Noncommercial License 1.0.0](LICENSE) as the rest of the project.

## Before you open a pull request

Run the checks locally:

```
pnpm install
pnpm compile
pnpm test
pnpm scan
pnpm e2e
```

`pnpm e2e` needs Microsoft Edge installed. See the Testing section of the [README](README.md) for why.

## Test data

Never put real personal data in fixtures, tests, or anywhere else in the repository. Use invented
values such as `123-45-6789`. `pnpm scan` flags real-looking identifiers, keys, and email addresses,
and CI runs it on every push.

## Security issues

Do not report leaks in a public issue. Follow [SECURITY.md](SECURITY.md) instead.
