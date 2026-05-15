-- Actions: distinguish user-invokable from wire-only.
--
-- Some actions (e.g. labels:print) are meant to be clicked by a
-- user on an entity-detail page. Others (e.g.
-- projects:set-dep-satisfied) exist only to be fired by a wire on
-- an event — clicking them manually is meaningless or surprising.
--
-- The entity-actions bar on detail pages renders only
-- user_invokable actions; the wires builder still sees all of them
-- (a wire can target a wire-only action — that's the point).
--
-- Defaults true so existing actions keep showing as buttons unless
-- their manifest opts out.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_actions DROP COLUMN IF EXISTS user_invokable;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260515-012-action-user-invokable';

alter table entity_actions
  add column user_invokable boolean not null default true;
