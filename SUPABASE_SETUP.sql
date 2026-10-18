-- 北阿爾卑斯・信州（雲停下的地方）家庭旅行網站安全設定。請在 Supabase SQL Editor 執行一次；可重複執行。
-- 跟北海道網站共用同一個 Supabase 專案與家人帳號，資料放在獨立的 nagano_sync 表，不會互相影響。
create table if not exists public.nagano_sync (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- 一律由資料庫時鐘決定 updated_at，忽略每支手機／電腦自己送來的時間。
-- 這是修正「同步後資料消失」「家人看到的跟我不一樣」最關鍵的一步：
-- 舊版用各裝置自己的系統時間互相比較新舊，只要有一支手機時間不準（快、慢、時區錯），
-- 就可能讓比較新的資料被誤判成比較舊，整筆被舊資料蓋掉。
create or replace function public.nagano_sync_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists nagano_sync_touch_updated_at on public.nagano_sync;
create trigger nagano_sync_touch_updated_at
before insert or update on public.nagano_sync
for each row execute function public.nagano_sync_touch_updated_at();

alter table public.nagano_sync enable row level security;

drop policy if exists "nagano public read" on public.nagano_sync;
drop policy if exists "nagano public write" on public.nagano_sync;
drop policy if exists "nagano public update" on public.nagano_sync;
drop policy if exists "nagano family read" on public.nagano_sync;
drop policy if exists "nagano family insert" on public.nagano_sync;
drop policy if exists "nagano family update" on public.nagano_sync;
drop policy if exists "nagano family delete" on public.nagano_sync;

create policy "nagano family read" on public.nagano_sync
for select to authenticated using (true);
create policy "nagano family insert" on public.nagano_sync
for insert to authenticated with check (true);
create policy "nagano family update" on public.nagano_sync
for update to authenticated using (true) with check (true);
create policy "nagano family delete" on public.nagano_sync
for delete to authenticated using (true);

revoke all on table public.nagano_sync from anon;
grant select, insert, update, delete on table public.nagano_sync to authenticated;

-- 圖片網址維持可直接顯示，但只有已登入的家人可以上傳、替換或刪除。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trip-media', 'trip-media', true, 15728640, array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do update set public=true, file_size_limit=15728640,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/heic','image/heif'];

drop policy if exists "trip media authenticated insert" on storage.objects;
drop policy if exists "trip media authenticated update" on storage.objects;
drop policy if exists "trip media authenticated delete" on storage.objects;
drop policy if exists "trip media public read" on storage.objects;
drop policy if exists "trip media public insert" on storage.objects;
drop policy if exists "trip media public update" on storage.objects;
drop policy if exists "trip media public delete" on storage.objects;

create policy "trip media authenticated insert" on storage.objects
for insert to authenticated with check (bucket_id='trip-media');
create policy "trip media authenticated update" on storage.objects
for update to authenticated using (bucket_id='trip-media') with check (bucket_id='trip-media');
create policy "trip media authenticated delete" on storage.objects
for delete to authenticated using (bucket_id='trip-media');
