import { EmbThread } from "./thread.js";

/** Janome's thread chart, as in pyembroidery. JEF files store indexes into it. */
const JEF_THREADS: [color: number, description: string, catalog: string][] = [
  [0x000000, "Black", "002"],
  [0xffffff, "White", "001"],
  [0xffff17, "Yellow", "204"],
  [0xff6600, "Orange", "203"],
  [0x2f5933, "Olive Green", "219"],
  [0x237336, "Green", "226"],
  [0x65c2c8, "Sky", "217"],
  [0xab5a96, "Purple", "208"],
  [0xf669a0, "Pink", "201"],
  [0xff0000, "Red", "225"],
  [0xb1704e, "Brown", "214"],
  [0x0b2f84, "Blue", "207"],
  [0xe4c35d, "Gold", "003"],
  [0x481a05, "Dark Brown", "205"],
  [0xac9cc7, "Pale Violet", "209"],
  [0xfcf294, "Pale Yellow", "210"],
  [0xf999b7, "Pale Pink", "211"],
  [0xfab381, "Peach", "212"],
  [0xc9a480, "Beige", "213"],
  [0x970533, "Wine Red", "215"],
  [0xa0b8cc, "Pale Sky", "216"],
  [0x7fc21c, "Yellow Green", "218"],
  [0xe5e5e5, "Silver Gray", "220"],
  [0x889b9b, "Gray", "221"],
  [0x98d6bd, "Pale Aqua", "227"],
  [0xb2e1e3, "Baby Blue", "228"],
  [0x368ba0, "Powder Blue", "229"],
  [0x4f83ab, "Bright Blue", "230"],
  [0x386a91, "Slate Blue", "231"],
  [0x071650, "Navy Blue", "232"],
  [0xf999a2, "Salmon Pink", "233"],
  [0xf9676b, "Coral", "234"],
  [0xe3311f, "Burnt Orange", "235"],
  [0xe2a188, "Cinnamon", "236"],
  [0xb59474, "Umber", "237"],
  [0xe4cf99, "Blond", "238"],
  [0xffcb00, "Sunflower", "239"],
  [0xe1add4, "Orchid Pink", "240"],
  [0xc3007e, "Peony Purple", "241"],
  [0x80004b, "Burgundy", "242"],
  [0x540571, "Royal Purple", "243"],
  [0xb10525, "Cardinal Red", "244"],
  [0xcae0c0, "Opal Green", "245"],
  [0x899856, "Moss Green", "246"],
  [0x5c941a, "Meadow Green", "247"],
  [0x003114, "Dark Green", "248"],
  [0x5dae94, "Aquamarine", "249"],
  [0x4cbf8f, "Emerald Green", "250"],
  [0x007772, "Peacock Green", "251"],
  [0x595b61, "Dark Gray", "252"],
  [0xfffff2, "Ivory White", "253"],
  [0xb15818, "Hazel", "254"],
  [0xcb8a07, "Toast", "255"],
  [0x986c80, "Salmon", "256"],
  [0x98692d, "Cocoa Brown", "257"],
  [0x4d3419, "Sienna", "258"],
  [0x4c330b, "Sepia", "259"],
  [0x33200a, "Dark Sepia", "260"],
  [0x523a97, "Violet Blue", "261"],
  [0x0d217e, "Blue Ink", "262"],
  [0x1e77ac, "Sola Blue", "263"],
  [0xb2dd53, "Green Dust", "264"],
  [0xf33689, "Crimson", "265"],
  [0xde649e, "Floral Pink", "266"],
  [0x984161, "Wine", "267"],
  [0x4c5612, "Olive Drab", "268"],
  [0x4c881f, "Meadow", "269"],
  [0xe4de79, "Mustard", "270"],
  [0xcb8a1a, "Yellow Ocher", "271"],
  [0xcba21c, "Old Gold", "272"],
  [0xff9805, "Honey Dew", "273"],
  [0xfcb257, "Tangerine", "274"],
  [0xffe505, "Canary Yellow", "275"],
  [0xf0331f, "Vermilion", "202"],
  [0x1a842d, "Bright Green", "206"],
  [0x386cae, "Ocean Blue", "222"],
  [0xe3c4b4, "Beige Gray", "223"],
  [0xe3ac81, "Bamboo", "224"],
];

export class EmbThreadJef extends EmbThread {
  constructor(color: number, description: string, catalogNumber: string) {
    super();
    this.color = color;
    this.description = description;
    this.catalog_number = catalogNumber;
    this.brand = "Jef";
    this.chart = "Jef";
  }
}

/** Index 0 is a placeholder: JEF uses it for stops. */
export function getJefThreadSet(): (EmbThreadJef | null)[] {
  return [null, ...JEF_THREADS.map(([color, description, catalog]) => new EmbThreadJef(color, description, catalog))];
}
