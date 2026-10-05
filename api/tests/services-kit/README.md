# Services conformance kit (vendored)

The fake service and the reference signer the Services kernel is tested
against. Vendored unchanged from the kit's source, commit 51d3389
(`conformance/ts/fake-service.ts`, `conformance/ts/hmac.ts`,
`conformance/vectors.json`). Update by copying the files again from a newer
commit and noting it here; never edit them in place, so a test that passes
here passes against the kit.

And `fake-service.ts` opens with `// @ts-nocheck`: the kit is written for a
looser tsconfig than this repo's tests typecheck (`noUncheckedIndexedAccess`),
and it is somebody else's code, checked by its own suite.
