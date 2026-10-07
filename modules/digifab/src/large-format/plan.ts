export interface PrintGeometry { width_mm: number; height_mm: number; pages: number; copies: number; margin_mm: number }
export function planRollPrint(job: PrintGeometry, roll: {width_mm:number;remaining:number;waste:number}):number {
 if (![job.width_mm,job.height_mm,roll.width_mm].every(n=>Number.isFinite(n)&&n>0) || ![job.margin_mm,roll.remaining,roll.waste].every(n=>Number.isFinite(n)&&n>=0) || ![job.pages,job.copies].every(n=>Number.isInteger(n)&&n>0&&n<=1000)) throw new Error("Give the print and roll valid dimensions and quantities.");
 if(job.width_mm+2*job.margin_mm>roll.width_mm) throw new Error("This job is wider than the loaded roll, including both margins.");
 const used=Math.round(((job.height_mm+2*job.margin_mm)*job.pages*job.copies/1000+roll.waste)*1e9)/1e9;
 if(used>100000)throw new Error("Split a print longer than 100000 metres into separate jobs.");
 if(used>roll.remaining)throw new Error("The loaded roll does not have enough length for this job and its margins.");
 return used;
}
export function inkTransition(previous:boolean|undefined,percent:number|null,threshold:number) {
 const known=percent!=null&&Number.isFinite(percent)&&percent>=0&&percent<=100;
 const low=known?percent<=threshold:previous===true;
 return {low,notify:known&&low&&previous!==true};
}
