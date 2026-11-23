# static-site-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/darrenmitchvicente829/static-site-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/darrenmitchvicente829/static-site-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, make.fun's reference static site generator. `solve.js` exports `run(input)`, which returns the same output tree as makefun-site's build for every input, and `main.ts` is the driver the harness runs. A case read from `cases.json` is answered bytes to bytes: front matter, Markdown and templates are read from the JSON text as it stands, each site's templates are compiled once so that what every page shares is rendered once, and the answer is written as JSON text straight toward `answers.json`, so nothing is parsed into strings and stringified again. The few loops that touch every byte are small kernels the driver has V8 optimize up front; everything else stays in V8's cheap tiers, since a run is too short to pay for more. A parsed input, or one the byte path does not read, is answered by `build()`, a plain reading of the same rules.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir holding cases.json> MAKEFUN_OUTPUT_DIR=<dir for answers.json> node main.ts
```

Node 22.18 or later runs `main.ts` as it is.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
