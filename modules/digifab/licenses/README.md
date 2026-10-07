# Embroidery format codecs

The dependency-free PES, DST, EXP, JEF and VP3 codec subset in
`src/embroidery-codecs` comes from the MIT TypeScript port
[@guillaumemmm/tsembroidery v2.6.1](https://github.com/GuillaumeMMM/tsembroidery/tree/v2.6.1),
commit `185a354d3424a8aa365ca80a477c5ad719c6b793`.
That project ports [pyembroidery](https://github.com/EmbroidePy/pyembroidery),
also MIT. Both notices are included here and travel with the API image.

Cobblr adds strict indexed types, file-bound checks, complete PEC graphics
validation, and VP3 moves when either origin coordinate differs. Conversion
runs in workers with memory and time limits. Round-trip fixtures are synthetic
stitches generated with pyembroidery commit
`c16d1b46390a1632ee36ff98eb8b3ec01934a8e9`.

The chart contains factual catalogue numbers from the Brother Embroidery Design
Guide 2022, printed pages 46 to 49, with approximate RGB samples from the guide's
swatches. It covers Brother, Isacord Polyester, Madeira Polyneon, Madeira Rayon
and Robison-Anton Polyester. It is a cross-brand reference subset, not a complete
catalogue of every manufacturer's colours. Each code is stored once per chart.

[Brother guide distributed by a sewing supplier](https://montavilla-sewing.files.svdcdn.com/production/product-pdfs/Embroidery-Design-Guide-Final_2022-08-08-201039_ncxh.pdf?dm=1659989439).
Screen colours and nearest-colour suggestions need physical confirmation. No
chart prose or pattern artwork is included.
