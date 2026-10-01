-- core-documents holds items from any outside library, not documents alone
-- (#4489, RomM as the second library): each kept item says what it is and
-- what heading its kind goes under on a record, its second line (a game's
-- platform), and what its open link says. Additive: a row from before is a
-- document from a document system, which is what the defaults say.

alter table core_documents_suggestions
  add column item_type       text not null default 'document',
  add column item_type_label text not null default 'Documents',
  add column subtitle        text,
  add column open_label      text;

alter table core_documents_linked
  add column item_type       text not null default 'document',
  add column item_type_label text not null default 'Documents',
  add column subtitle        text,
  add column open_label      text;
