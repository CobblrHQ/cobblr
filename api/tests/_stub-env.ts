// Import FIRST in a pure test whose import chain reaches src/env.ts (which
// process.exit(1)s on a missing api env). Import order is preserved for side
// effects, so these land before env.ts is evaluated — letting a pure suite run
// on a laptop with no stack, exactly as it does in CI with real values.
// `||=` never overwrites a real value, so CI is unaffected.
process.env.DATABASE_URL ||= "postgres://stub:stub@127.0.0.1:5/stub";
process.env.SUPERUSER_DATABASE_URL ||= "postgres://stub:stub@127.0.0.1:5/stub";
process.env.JWT_SECRET ||= "stub-secret-16-chars!";
process.env.TENANT_CREDS_ENCRYPTION_KEY ||= "stub-key-16-chars!!";
