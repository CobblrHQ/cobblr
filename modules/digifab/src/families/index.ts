// Every family of machines in Digital Fabrication: the one list the module's
// api and boot read (docs/modules/digifab-families.md).
import type { DigifabFamily } from "../core/families.js";
import { armsFamily } from "./arms/index.js";
import { embroideryFamily } from "./embroidery/index.js";
import { kilnsFamily } from "./kilns/index.js";
import { productionFamily } from "./production/index.js";

export const FAMILIES: readonly DigifabFamily[] = [armsFamily, embroideryFamily, kilnsFamily, productionFamily];
