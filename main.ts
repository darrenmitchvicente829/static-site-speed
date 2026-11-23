// The program the harness runs: node /bot/main.ts (Node 22). It reads every case from /input/cases.json, answers each
// one alone with run() from solve.js, and writes /output/answers.json: the answers, one per case and in the cases'
// order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { setFlagsFromString } from 'node:v8';

// V8 tuned before solve.js is read, as the rules allow. A run is one pass over a few megabytes, too short for the
// optimizing compiler to pay for itself on large functions: only solve.js's kernels (k_*, the small loops that
// touch every byte) are optimized, and solve.js asks for each of them once, with V8's own syntax for it.
setFlagsFromString('--allow-natives-syntax');
setFlagsFromString('--turbo-filter=k_*');

const { answers, cases, run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  cases: () => Iterable<unknown>;
  run: (input: unknown) => unknown;
  answers: (list: unknown[]) => void;
};

const out: unknown[] = [];
for (const c of cases()) out.push(run(c));
answers(out);
