import type { DigifabFleetConnection, DigifabFleetDevice, EdgeBridge } from "./api";
import { bridgeDisplayName } from "./bridge-choice";

export function fabricationMachineName(connection: DigifabFleetConnection, device: DigifabFleetDevice): string {
  return device.linked_machine?.name || (connection.type === "edge_adapter" && connection.devices.length === 1 ? connection.label : device.name);
}

export function fabricationBridgeName(connection: DigifabFleetConnection, bridges: EdgeBridge[]): string {
  return connection.type === "edge_adapter" ? bridgeDisplayName(bridges.find(b => b.bridge === connection.bridge) || { bridge: connection.bridge ?? null, name: null }) : connection.label;
}

/** A machine and the connection it is reached through, as one line. A laser
 *  connected under its own name ("Shop laser" through "Shop laser") is named
 *  once: the doubled form read as a glitch on the station and in the planner. */
export function fabricationFullName(machine: string, bridge: string): string {
  return bridge && machine.trim().toLowerCase() !== bridge.trim().toLowerCase() ? `${machine} · ${bridge}` : machine;
}

/** The bridge line under a machine's name, or null when it would repeat it. */
export function fabricationBridgeLine(machine: string, bridge: string): string | null {
  return fabricationFullName(machine, bridge) === machine ? null : bridge;
}

export function laserState(state: string): string {
  return /^(printing|print)$/i.test(state) ? "Running" : state;
}
