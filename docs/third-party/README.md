# Nesting dependencies

The API image includes these notices at `/app/third-party`; the web image serves
copies at `/third-party/`. Cobblr keeps its FSL-1.1-ALv2 licence as a Larger Work.

| Dependency | Version | Licence | Unmodified source |
| --- | --- | --- | --- |
| jagua-rs | 1.0.0 | [MPL-2.0](MPL-2.0.txt) | [Pinned source](https://github.com/JeroenGar/jagua-rs/tree/23e3f2737065cbb4dbc8f400b622976490b2d8cd) |
| sparrow | 0.3.0 | [MIT](sparrow-MIT.txt) | [Pinned source](https://github.com/JeroenGar/sparrow/tree/5901a79b6c5a74d8b9c356ee2916736567308108) |

Cobblr's Rust adapter calls these dependencies through their public APIs and
exports a WASM entry point. No upstream implementation is copied or patched.
Any future jagua-rs patch must keep its MPL header, be published in source form
and offered upstream. A dependency upgrade updates the lockfile, the inventory,
the source links and the licence texts together.

`nesting-inventory.json` records the entire locked Rust dependency closure,
including build tools, plus the polygon union dependencies. The bundle
`nesting-licenses.txt` retains their original notices. MIT, Apache-2.0, BSD,
ISC and MPL-2.0 are permitted dependency licences. The existing locked closure
also contains Zlib, Unicode-3.0 and Unlicense notices; these permissive
transitive licences are recorded explicitly, and only for transitive
dependencies: a direct dependency (the `[dependencies]` of the nesting crate,
and polygon-clipping) takes a permitted licence. The npm half is checked the
same way as the Rust half: polygon-clipping's whole locked closure in
`pnpm-lock.yaml` must be in the inventory at the versions pnpm resolves, and
each row's licence must equal the one its installed package declares (CI
installs before it lints). The lint refuses missing inventory entries,
unreviewed licences, changed primary pins or omitted image notices.

The public exporter preserves the licence bundle byte for byte against a
reviewed SHA-256. This prevents identity sanitization from changing a third
party's copyright notice. Changed content loses that exemption; secret scans
still apply.
