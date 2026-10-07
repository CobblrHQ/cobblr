---
type: feature
scope: digifab
date: 2026-10-05
docs_target: docs/USER_GUIDE.md#LightBurn job review
docs_published: 2026-10-08
---
Added outline nesting for laser, CNC and cutter parts around used sheet areas, with rotation choices and a longer search option.

## docs

Open **Prepare laser batch** on an SVG or DXF drawing in the Library, then
choose laser, CNC or cutter as the job type. Pick the material and physical
sheets, with offcuts first. Laser batches also need a machine and material
profiles. The whole drawing is repeated as one part.

Allow rotation in steps that divide 360 degrees, or disable it. The preview
shows **Nested by outline** or **Nested by rectangle**, the portion of each
sheet occupied by parts and the time taken. **Optimize harder** gives the
search up to 30 seconds. A normal preview uses up to three seconds.

Used regions stay unavailable, including the curved footprints of earlier
cuts. Spacing and kerf reserve material without changing the drawing. Holes
inside parts cannot take another part in the current solver. Laser jobs still
need review and approval at the machine; CNC and cutter previews offer **Download SVG** for each sheet without starting hardware.
