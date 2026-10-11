# The owner's Kingroon box labels (#5764)

What core-scan's OCR reader (`ocrImageText`, Tesseract, no model) returned for
each of the 25 box labels in the owner's five photos of his Kingroon order:
the two 10-spool multicolour packs ("Multicolor", "Multicolor-1") and the
10 kg white carton. One crop per box, as a person photographs a box's label.

The photos are attached to issue #5734 (comments 45427, 45431, 45435). To
regenerate: download them beside `crop-labels.py` as `multi-a.img`,
`multi-b.img`, `multi1-a.img`, `multi1-b.img` and `white.img`, run it to cut
the crops, then run each crop through `ocrImageText` and keep its `text`.

`expected_colour` is the colour printed on the box, read by a person.
