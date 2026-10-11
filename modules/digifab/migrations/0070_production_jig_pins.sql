-- A jig's fixture pins: the net names plans drive and watch, wired to the fixture I/O controller's GPIOs (#5255).
ALTER TABLE digifab_test_jigs ADD COLUMN IF NOT EXISTS pins jsonb NOT NULL DEFAULT '[]';
