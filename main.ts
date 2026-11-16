// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` on Node 22 (erasable TypeScript
// only). It reads every case from $MAKEFUN_INPUT_DIR/cases.json (default
// /input) -- a JSON array of {id, markdown} -- renders each case alone
// with parse() from ./parse.js, and writes the HTML strings, in the
// cases' order, as a JSON array to $MAKEFUN_OUTPUT_DIR/html.json
// (default /output). Outside a container the two environment variables
// stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
