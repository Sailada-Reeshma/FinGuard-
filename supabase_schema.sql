create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null default '',
  country text not null default '',
  currency text not null default 'INR',
  monthly_income numeric(14,2) not null default 0,
  setup_completed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'Bank account',
  balance numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  amount numeric(14,2) not null default 0,
  unique(user_id, category)
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_amount numeric(14,2) not null,
  saved_amount numeric(14,2) not null default 0,
  target_date date,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete set null,
  goal_id uuid references public.goals(id) on delete set null,
  type text not null check (type in ('income', 'expense', 'goal_contribution')),
  amount numeric(14,2) not null check (amount > 0),
  category text not null default 'General',
  custom_category text,
  description text not null,
  date date not null default current_date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.goal_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  transaction_id uuid references public.transactions(id) on delete cascade,
  date date not null default current_date,
  created_at timestamptz not null default now()
);

create table if not exists public.recurring_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric(14,2) not null check (amount > 0),
  due_date date not null,
  frequency text not null check (frequency in ('Weekly', 'Monthly', 'Yearly')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.goal_contributions add column if not exists transaction_id uuid references public.transactions(id) on delete cascade;

alter table public.profiles enable row level security;
alter table public.accounts enable row level security;
alter table public.budgets enable row level security;
alter table public.goals enable row level security;
alter table public.transactions enable row level security;
alter table public.goal_contributions enable row level security;
alter table public.recurring_payments enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['profiles','accounts','budgets','goals','transactions','goal_contributions','recurring_payments'] loop
    execute format('drop policy if exists "Users manage own %1$s" on public.%1$s', table_name);
    execute format('create policy "Users manage own %1$s" on public.%1$s for all using (auth.uid() = user_id) with check (auth.uid() = user_id)', table_name);
  end loop;
end $$;

create index if not exists accounts_user_id_idx on public.accounts(user_id);
create index if not exists transactions_user_id_date_idx on public.transactions(user_id, date);
create index if not exists goals_user_id_idx on public.goals(user_id);
create index if not exists contributions_user_id_idx on public.goal_contributions(user_id);
create index if not exists recurring_payments_user_id_idx on public.recurring_payments(user_id);
