-- Marketplace v0.3 PoC migration. Demonstrates that sandboxed
-- modules can ship tenant-side schema; the kernel runs the SQL on
-- the module's behalf (the wasm doesn't touch the DB directly —
-- it'll go through TENANT_QUERY op codes in a future iteration).
--
-- Table prefix convention: <module_name_with_underscores>_<thing>.
-- For "hello-wasm" → "hello_wasm_*".

CREATE TABLE hello_wasm_greetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
