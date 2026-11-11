-- 0008 の検証
set role authenticated;
set request.jwt.sub = '00000000-0000-0000-0000-00000000000b';
insert into push_subscriptions(endpoint,user_id,p256dh,auth) values ('https://push.example/b','00000000-0000-0000-0000-00000000000b','k','a');
\echo '--- expect error: register a device for someone else'
insert into push_subscriptions(endpoint,user_id,p256dh,auth) values ('https://push.example/x','00000000-0000-0000-0000-00000000000a','k','a');
\echo '--- expect error: non-https endpoint'
insert into push_subscriptions(endpoint,user_id,p256dh,auth) values ('http://evil/x','00000000-0000-0000-0000-00000000000b','k','a');
set request.jwt.sub = '00000000-0000-0000-0000-00000000000a';
select count(*) as a_sees_b_devices from push_subscriptions;
