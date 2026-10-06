#!/usr/bin/env tsx
// Shipped nesting dependencies have pinned versions, reviewed licences and source notices in both images.
import { readFileSync, existsSync } from "node:fs";
const inventory = JSON.parse(readFileSync("docs/third-party/nesting-inventory.json","utf8")) as Array<{name:string;version:string;license:string;source:string}>;
const lock = readFileSync("modules/digifab/nesting/Cargo.lock","utf8");
const manifest = readFileSync("modules/digifab/nesting/Cargo.toml","utf8");
const errors: string[]=[];
const allowed = new Set(["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","ISC","MPL-2.0"]);
const transitive = new Set(["Zlib","Unicode-3.0","Unlicense"]);
for (const block of lock.split("[[package]]").slice(1)) {
 const name = /name = "([^"]+)"/.exec(block)?.[1], version=/version = "([^"]+)"/.exec(block)?.[1];
 if(name === "cobblr-nesting")continue;
 const row=inventory.find(p=>p.name===name&&p.version===version);
 if(!row?.license || !row.source) {errors.push(`${name}@${version} has no reviewed licence or source`);continue;}
 const groups=row.license.split(/\bAND\b/);
 if(groups.some(g=>!g.replace(/[()]/g,"").split(/\bOR\b|\//).some(l=>allowed.has(l.trim())||transitive.has(l.trim())))) errors.push(`${name} has an unreviewed licence: ${row.license}`);
}
const jagua=inventory.find(p=>p.name==="jagua-rs"),sparrow=inventory.find(p=>p.name==="sparrow");
if(jagua?.license!=="MPL-2.0"||jagua.version!=="1.0.0"||!jagua.source.endsWith("23e3f2737065cbb4dbc8f400b622976490b2d8cd")) errors.push("jagua-rs must retain its MPL licence and pinned source link");
if(sparrow?.license!=="MIT"||!sparrow.source.endsWith("5901a79b6c5a74d8b9c356ee2916736567308108")) errors.push("sparrow must retain its MIT licence and pinned source link");
if(!manifest.includes('jagua-rs = "=1.0.0"')||!manifest.includes('rev = "5901a79b6c5a74d8b9c356ee2916736567308108"')) errors.push("solver dependencies must be exactly pinned");
for(const file of ["MPL-2.0.txt","sparrow-MIT.txt","nesting-licenses.txt"]) if(!existsSync(`docs/third-party/${file}`))errors.push(`missing licence text ${file}`);
for(const file of ["docker/api.Dockerfile","docker/web.Dockerfile"]) if(!readFileSync(file,"utf8").includes("COPY docs/third-party "))errors.push(`${file} does not ship third-party notices`);
if(errors.length) {console.error(errors.join("\n"));process.exit(1);}
console.log("lint:shipped-nesting-licenses OK");
