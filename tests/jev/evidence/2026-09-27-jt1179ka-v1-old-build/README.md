# Dated test evidence — NOT a product implementation

Old JEV build (jt1179ka-v1, emitted `dist/jev/`), preserved byte-unchanged on 2026-09-27.
Imported ONLY by `r2-before-after.test.mjs` and `r2-acceptance-delta.test.mjs` as the
"before" side of before/after comparisons. It is never the implementation under test and
never a fallback: every NEW-side import is `../../dist/src/jev/*.js`, the real tsc output.

| file | sha256 |
|---|---|
| contracts.js | `debecb30812a8a2a7bdf68bec550704ae8f8b1206bfb429e6a9c9b90f0ecc1be` |
| price-table.js | `4dff221ef032dac33be8f3c23a52cb24e036caed0a828ecc38b146102f0ef1a7` |
| reserve.js | `51a2f601e89143fd69c0609da48d429809a4d360ce4b13ab928431d4f2353554` |

Do not edit. Do not import from any other suite.
