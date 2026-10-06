import { z } from "zod";

export const LASER_FIRMWARES = {
  grbl:"GRBL", "grbl-lpc":"GRBL-LPC", grblhal:"grblHAL", fluidnc:"FluidNC",
  smoothieware:"Smoothieware", marlin:"Marlin", snapmaker:"Snapmaker",
  forgefirm:"Glowforge (ForgeFIRM)",
} as const;
export type LaserFirmware = keyof typeof LASER_FIRMWARES;
export const LaserFirmwareSchema = z.enum(Object.keys(LASER_FIRMWARES) as [LaserFirmware,...LaserFirmware[]]);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const binding=z.object({sessionId:z.string().uuid(),identityHash:hash,settingsHash:hash});
const word=z.number().int().min(0).max(65535);
const delay=z.number().int().min(-65535).max(65535);
export const GalvoSettingsSchema=z.object({
  fieldWidthMm:z.number().finite().positive().max(10000),fieldHeightMm:z.number().finite().positive().max(10000),
  flipX:z.boolean(),flipY:z.boolean(),swapXY:z.boolean(),source:z.enum(["fiber","co2","uv"]),
  frequencyKhz:z.number().finite().positive().max(1000),frequencyClockKhz:z.union([z.literal(10000),z.literal(20000)]),
  pulseWidthNs:word.positive().nullable(),powerInverted:z.boolean(),
  travelSpeedMmSec:z.number().finite().positive().max(10000),frameSpeedMmSec:z.number().finite().positive().max(10000),
  laserOnDelayUs:delay,laserOffDelayUs:delay,jumpDelayUs:delay,polygonDelayUs:z.number().int().min(0).max(655350).multipleOf(10),
  guidePort:z.number().int().min(0).max(15),enablePort:z.number().int().min(0).max(15),airPort:z.number().int().min(0).max(15).nullable(),
  guideOffsetXmm:z.number().finite().min(-10000).max(10000),guideOffsetYmm:z.number().finite().min(-10000).max(10000),
  guideScaleX:z.number().finite().positive().max(10),guideScaleY:z.number().finite().positive().max(10),
  controlMode:word,laserMode:word,delayMode:word,timingMode:word,pwmHalfPeriod:word,pwmPulseWidth:word,firstPulseKiller:word,
  standby:z.tuple([z.literal(0),z.literal(0)]),fpkParameters:z.tuple([word,word,word,word]),analogPort1:word,
  moOnDelayUs:z.number().int().min(0).max(655350).multipleOf(10),
}).strict().superRefine((settings,ctx)=>{
  if(new Set([settings.guidePort,settings.enablePort,...(settings.airPort===null?[]:[settings.airPort])]).size!==(settings.airPort===null?2:3))ctx.addIssue({code:"custom",path:["guidePort"],message:"Guide, source enable and air assist need separate output ports."});
  if(settings.source==="fiber"&&(settings.frequencyClockKhz!==20000||settings.powerInverted))ctx.addIssue({code:"custom",path:["source"],message:"Fiber uses its 20 MHz Q-switch clock and current power encoding."});
  if(settings.source!=="fiber"&&settings.pulseWidthNs!==null)ctx.addIssue({code:"custom",path:["pulseWidthNs"],message:"MOPA pulse width is only supported for a fiber source."});
  if(settings.source!=="uv"&&settings.powerInverted)ctx.addIssue({code:"custom",path:["powerInverted"],message:"Confirm power inversion only for a UV source."});
});
export type GalvoSettings=z.infer<typeof GalvoSettingsSchema>;
export const LaserCommissionSchema = z.discriminatedUnion("firmware",[
  binding.extend({firmware:z.literal("marlin"),powerUnit:z.enum(["PWM","PERCENT"]),powerUnitConfirmed:z.literal(true),inlinePowerConfirmed:z.literal(true),coolantConfirmed:z.boolean().default(false)}).strict(),
  binding.extend({firmware:z.literal("smoothieware"),restartConfirmed:z.literal(true),coolantConfirmed:z.boolean().default(false)}).strict(),
  binding.extend({firmware:z.literal("forgefirm"),restartConfirmed:z.literal(true)}).strict(),
  binding.extend({firmware:z.literal("ruida"),flipX:z.boolean(),flipY:z.boolean(),axesConfirmed:z.literal(true),firstTubeConfirmed:z.literal(true)}).strict(),
  binding.extend({firmware:z.literal("galvo"),settings:GalvoSettingsSchema,correctionBase64:z.string().min(4).max(100000).regex(/^[A-Za-z0-9+/]+={0,2}$/),lensConfirmed:z.literal(true),sourceConfirmed:z.literal(true),guideConfirmed:z.literal(true)}).strict(),
]);
export type LaserCommission = z.infer<typeof LaserCommissionSchema>;
export const LaserSetupSchema = binding.extend({
  firmware:z.union([LaserFirmwareSchema,z.literal("ruida"),z.literal("galvo")]),
  bed:z.object({width:z.number().finite().positive().max(10000),height:z.number().finite().positive().max(10000)}).optional(),
  state:z.enum(["idle","homing","busy","offline","unknown"]),
  laserMode:z.boolean(),
  powerMax:z.number().finite().positive().nullable(),
  powerMin:z.number().finite().nonnegative().nullable(),
  needsHoming:z.boolean(),homed:z.boolean(),canHome:z.boolean(),
  needsCommissioning:z.boolean(),commissioned:z.boolean(),
  facts:z.array(z.string().max(1000)).max(20),
});
export type LaserSetup = z.infer<typeof LaserSetupSchema>;
export const LaserSetupRequestSchema=z.object({
  connection_id:z.string().uuid(),device_id:z.string().min(1).max(200),
  operation:z.enum(["read","home","commission"]),
  station_token:z.string().min(32).max(128).optional(),
  configuration:LaserCommissionSchema.optional(),
}).strict();
