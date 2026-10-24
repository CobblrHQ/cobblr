import { escapeIdentifier as identifier, type Client } from "pg";

/** Explicit restored values do not advance nextval. Include sequences used by
 * defaults without OWNED BY, as well as serial and identity columns. */
export async function advanceRestoredSequences(client: Pick<Client, "query">, tables: string[]): Promise<void> {
  for (const table of tables) {
    const { rows } = await client.query<{ column_name: string; sequence_schema: string; sequence_name: string }>(`
      select distinct a.attname as column_name, ns.nspname as sequence_schema, s.relname as sequence_name
      from pg_class t
      join pg_namespace nt on nt.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      join pg_attrdef ad on ad.adrelid = t.oid and ad.adnum = a.attnum
      join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_class'::regclass
      join pg_class s on s.oid = d.refobjid and s.relkind = 'S'
      join pg_namespace ns on ns.oid = s.relnamespace
      where nt.nspname = 'public' and t.relname = $1
      union
      select a.attname, ns.nspname, s.relname
      from pg_class t
      join pg_namespace nt on nt.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid and a.attidentity <> ''
      join pg_class s on s.oid = pg_get_serial_sequence(format('%I.%I', nt.nspname, t.relname), a.attname)::regclass
      join pg_namespace ns on ns.oid = s.relnamespace
      where nt.nspname = 'public' and t.relname = $1
    `, [table]);
    for (const row of rows) {
      const sequence = `${identifier(row.sequence_schema)}.${identifier(row.sequence_name)}`;
      await client.query(`
        select setval($1::regclass, restored.maximum, true)
        from ${sequence}
        cross join (select max(${identifier(row.column_name)})::bigint as maximum from public.${identifier(table)}) restored
        where restored.maximum >= last_value
      `, [sequence]);
    }
  }
}
