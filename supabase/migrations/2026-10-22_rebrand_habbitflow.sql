-- Rebrand: HabitFlow -> HabbitFlow in the test-notification text.
-- (Internal names such as the habitflow.local login domain and the
-- habitflow.* session settings are unchanged so existing accounts keep working.)

create or replace function public.send_test_notification()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.notifications where user_id = auth.uid() and kind = 'test' and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You can send 5 test notifications an hour.';
  end if;
  insert into public.notifications (user_id, kind, title, body, link)
  values (auth.uid(), 'test', 'Test notification', 'Notifications from HabbitFlow reach you here.', '/settings');
end;
$$;
revoke execute on function public.send_test_notification() from public, anon;
grant execute on function public.send_test_notification() to authenticated;
