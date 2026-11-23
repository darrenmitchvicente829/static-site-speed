// The program the harness runs: node /bot/main.ts (Node 22). It reads every case from /input/cases.json, answers each
// one alone with run() from solve.js, and writes /output/answers.json: the answers, one per case and in the cases'
// order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { answers, cases, run } from './solve.js';

const out: unknown[] = [];
for (const c of cases()) out.push(run(c));
answers(out);
