export function laserLayerLabel(layer: string): string {
 const value = layer.trim();
 if (!value.startsWith("#")) return value;
 let hex = value.slice(1).toLowerCase();
 if (/^[0-9a-f]{3}$/.test(hex)) hex = [...hex].map(c => c + c).join("");
 const colours: Record<string, string> = { "000000": "layer 00 (black)", "ff0000": "red", "0000ff": "blue", "00ff00": "green", "ffff00": "yellow", "ff00ff": "magenta", "00ffff": "cyan", "ffffff": "white" };
 const colour = colours[hex];
 if (colour) return colour;
 if (/^[0-9a-f]{6}$/.test(hex)) return `colour RGB ${[0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(", ")}`;
 return "unnamed layer";
}
