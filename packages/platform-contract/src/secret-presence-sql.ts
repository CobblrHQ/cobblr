import { OperationNodeTransformer, TableNode, AliasNode, IdentifierNode, AndNode, sql, type SelectQueryNode, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs } from "kysely";

export interface SecretPresence { field: string; hasValue: boolean }

class PresenceTransformer extends OperationNodeTransformer {
  private readonly table: string;
  private readonly fields: readonly SecretPresence[];
  constructor(table: string, fields: readonly SecretPresence[]) { super(); this.table = table; this.fields = fields; }
  protected override transformSelectQuery(node: SelectQueryNode): SelectQueryNode {
    let result = super.transformSelectQuery(node);
    for (const source of result.from?.froms ?? []) {
      const table = AliasNode.is(source) ? source.node : source;
      if (!TableNode.is(table) || table.table.identifier.name !== this.table) continue;
      const alias = AliasNode.is(source) && IdentifierNode.is(source.alias) ? source.alias.name : table.table.identifier.name;
      for (const field of this.fields) {
        const metadata = sql.ref(`${alias}.metadata`);
        const present = sql<boolean>`coalesce((${metadata} -> ${field.field} ->> '__cobblr_secret') = '1' and (${metadata} -> ${field.field} ->> 'has_value') is distinct from 'false', false)`;
        const condition = (field.hasValue ? present : sql<boolean>`not (${present})`).toOperationNode();
        result = { ...result, where: { kind: "WhereNode", where: result.where ? AndNode.create(result.where.where, condition) : condition } };
      }
    }
    return result;
  }
}

export class SecretPresencePlugin implements KyselyPlugin {
  readonly table: string;
  readonly fields: readonly SecretPresence[];
  constructor(table: string, fields: readonly SecretPresence[]) { this.table = table; this.fields = fields; }
  transformQuery(args: PluginTransformQueryArgs) { return new PresenceTransformer(this.table, this.fields).transformNode(args.node); }
  async transformResult(args: PluginTransformResultArgs) { return args.result; }
}
