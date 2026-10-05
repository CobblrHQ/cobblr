import type { DigifabFleetConnection, DigifabFleetDevice, EdgeBridge } from "./api";
import { bridgeDisplayName } from "./bridge-choice";

export function fabricationMachineName(connection: DigifabFleetConnection, device: DigifabFleetDevice): string {
  return device.linked_machine?.name || (connection.type === "edge_adapter" && connection.devices.length === 1 ? connection.label : device.name);
}

export function fabricationBridgeName(connection: DigifabFleetConnection, bridges: EdgeBridge[]): string {
  return connection.type === "edge_adapter" ? bridgeDisplayName(bridges.find(b => b.bridge === connection.bridge) || { bridge: connection.bridge ?? null, name: null }) : connection.label;
}

export function laserState(state: string): string {
  return /^(printing|print)$/i.test(state) ? "Running" : state;
}
