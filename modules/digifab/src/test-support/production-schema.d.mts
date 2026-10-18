export function applyProductionSchema(pg: { exec(sql: string): Promise<unknown> }): Promise<void>;
