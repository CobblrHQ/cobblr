-- Multi-instance support — see docs/architecture/instances.md.

alter table machines_machines
  add column instance text not null default 'machines';

create index machines_machines_instance_idx on machines_machines(instance);
