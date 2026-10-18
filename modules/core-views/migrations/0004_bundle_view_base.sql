-- core-views: a bundle's view keeps the bundle's own copy beside the person's.
--
-- bundle_key  : the view's stable identity inside its bundle, the name the
--               bundle gave it. A person can rename the view; the key does not
--               move, so an update still finds it.
-- bundle_base : the view exactly as the bundle last installed it
--               ({name, view_type, config, is_default, pinned}). What a person
--               changed is the difference between the row and this copy, so an
--               update keeps it, a conflict is found by comparing the three, and
--               "reset to the bundle's version" is putting this copy back.
--
-- Additive and nullable: a view with no bundle has neither. Views a bundle
-- already installed take their current state as the base, so nothing is read as
-- an edit that was not one; a change made before this cannot be recovered and is
-- treated as the bundle's, as every update treated it until now.

alter table core_views_views
  add column bundle_key text,
  add column bundle_base jsonb;

update core_views_views
   set bundle_key = name,
       bundle_base = jsonb_build_object(
         'name', name,
         'view_type', view_type,
         'config', config,
         'is_default', is_default,
         'pinned', pinned
       )
 where bundle_id is not null
   and bundle_key is null;

create index core_views_views_bundle_key_idx
  on core_views_views(bundle_id, entity_kind, bundle_key)
  where bundle_key is not null;
