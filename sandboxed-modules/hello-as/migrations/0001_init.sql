-- hello-as tenant schema. The TENANT_QUERY op enforces the
-- hello_as_ prefix; this is the table the sample queries against.
CREATE TABLE hello_as_demo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed a row so query_self has something to count.
INSERT INTO hello_as_demo (label) VALUES ('default-seed');
