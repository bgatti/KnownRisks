import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL not set'); process.exit(1) }
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()

const v = await client.query('SELECT version()')
console.log('VERSION:', v.rows[0].version)

const dbsize = await client.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size")
console.log('DB SIZE:', dbsize.rows[0].size)

const tables = await client.query(`
  SELECT n.nspname AS schema, c.relname AS tbl,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
         pg_total_relation_size(c.oid) AS bytes
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')
  ORDER BY pg_total_relation_size(c.oid) DESC
`)
console.log('\nTABLES:')
for (const r of tables.rows) console.log(`  ${r.schema}.${r.tbl}  ${r.size}`)

for (const r of tables.rows) {
  const cnt = await client.query(`SELECT count(*)::bigint AS n FROM "${r.schema}"."${r.tbl}"`)
  const cols = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position`, [r.schema, r.tbl])
  console.log(`\n── ${r.schema}.${r.tbl}  rows=${cnt.rows[0].n}  size=${r.size}`)
  for (const c of cols.rows) console.log(`    ${c.column_name.padEnd(24)} ${c.data_type}`)
}

await client.end()
