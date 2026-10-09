import { qrTokenFromScan } from "./qr-token.js";
export function matchesProductionJig(scan: string, id: string, labels: string[]): boolean {
 const value = scan.trim();
 return value === id || labels.includes(value) || !!qrTokenFromScan(value) && labels.includes(qrTokenFromScan(value)!);
}
