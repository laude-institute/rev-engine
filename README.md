# rev-engine-prime

![RevEngine](.github/banner.png)

RevEngine is a code reviewer you can run as a GitHub Action on your own pull requests. This is still early work, and the prompts and settings may change.

## How it reviews

![RevEngine Diagram](.github/revengine-diagram.png)

1. **Review.** A strong model reads the change with read-only tools. It is asked to understand the system before judging the change.
2. **Verify.** A second pass checks every proposed finding against the code, rejects the ones that do not hold, and marks repeats.
3. **Rank.** Duplicates are merged, and the remaining findings are ranked by severity and confidence.

The pull request's text and code are treated as untrusted input throughout. The project's own instruction files, such as `AGENTS.md` and `CONTRIBUTING.md`, are read from the base revision and given to the reviewer as the rules the change should follow.

## Use it as a GitHub Action

A person with write access starts a review by commenting `/review` on a pull request, and the findings come back as one review with comments on the changed lines. See [docs/INSTALL.md](docs/INSTALL.md) to set it up.

## More

- [docs/SETTINGS.md](docs/SETTINGS.md) lists the settings the reviewer reads.
- [docs/REVIEWBENCH.md](docs/REVIEWBENCH.md) covers how the reviewer runs in [ReviewBench](https://github.com/review-bench/ReviewBench), an open benchmark for AI code review, and how to run the benchmark locally.
- [evals/README.md](evals/README.md) covers our own evals, which check severity, merge advice and known false positives on pull requests a person has labeled.

## License

Apache 2.0. See [LICENSE](LICENSE).
