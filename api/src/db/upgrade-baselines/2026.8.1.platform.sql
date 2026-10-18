insert into orgs (id,name,slug,db_name) values
 ('00000000-0000-4000-8000-0000000000a1','One','one','db_one'),
 ('00000000-0000-4000-8000-0000000000a2','Two','two','db_two');
insert into users (id,email,password_hash,display_name) values
 ('00000000-0000-4000-8000-0000000000b1','a@example.test','x','A'),
 ('00000000-0000-4000-8000-0000000000b2','b@try.invalid','x','B'),
 ('00000000-0000-4000-8000-0000000000b3','c@example.test','x','C');
insert into org_memberships (user_id,org_id,role)
 select '00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a1',r from unnest(array['owner']) r;
insert into org_memberships (user_id,org_id,role) values
 ('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000a1','admin'),
 ('00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000a1','editor'),
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a2','member'),
 ('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000a2','guest');
insert into workspace_invites (org_id,invited_by_user,token,role) values
 ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1','t1','member'),
 ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1','t2','editor');
insert into user_credentials (id,user_id,provider_id,credentials_encrypted) values
 ('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000b1','anthropic','x'),
 ('00000000-0000-4000-8000-0000000000c2','00000000-0000-4000-8000-0000000000b1','openai','x');
insert into user_credential_orgs (credential_id,org_id,rank,capability) values
 ('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000a1',1,null),
 ('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000a2',2,'identify-image'),
 ('00000000-0000-4000-8000-0000000000c2','00000000-0000-4000-8000-0000000000a1',null,'chat');
insert into notifications (org_id,user_id,event_type,message)
 select '00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1','x.y','m' from generate_series(1,5);
insert into feedback (message,org_id,user_id) values
 ('one','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b2'),
 ('two',null,'00000000-0000-4000-8000-0000000000b1'),
 ('three','00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1');
insert into api_tokens (user_id,name,token_hash,token_prefix) values
 ('00000000-0000-4000-8000-0000000000b1','t','h','p');
insert into module_field_defs (org_id,entity_kind,name,display_label,type)
 select '00000000-0000-4000-8000-0000000000a1','inventory:part','f_'||t,t,t from unnest(array['text','number','boolean','date','url','computed','relation','richtext','member']) t;
