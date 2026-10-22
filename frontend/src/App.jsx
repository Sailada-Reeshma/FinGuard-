import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useEffect, useState } from "react";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { supabase, supabaseConfigured } from "./supabaseClient";
import "./App.css";

const CURRENCIES = [
  ["INR", "â‚¹", "Indian Rupee"],
  ["USD", "$", "US Dollar"],
  ["EUR", "â‚¬", "Euro"],
  ["GBP", "Â£", "British Pound"],
  ["AUD", "A$", "Australian Dollar"],
  ["CAD", "C$", "Canadian Dollar"],
  ["JPY", "Â¥", "Japanese Yen"],
  ["SGD", "S$", "Singapore Dollar"],
  ["AED", "Ø¯.Ø¥", "UAE Dirham"],
  ["CHF", "CHF", "Swiss Franc"],
];
const COUNTRIES = [
  "Australia", "Austria", "Bangladesh", "Belgium", "Brazil", "Canada", "China", "Denmark", "Egypt", "Finland", "France", "Germany", "Greece", "India", "Indonesia", "Ireland", "Israel", "Italy", "Japan", "Kenya", "Malaysia", "Mexico", "Netherlands", "New Zealand", "Nigeria", "Norway", "Pakistan", "Philippines", "Poland", "Portugal", "Singapore", "South Africa", "South Korea", "Spain", "Sri Lanka", "Sweden", "Switzerland", "Thailand", "Turkey", "United Arab Emirates", "United Kingdom", "United States", "Vietnam",
];
const CATEGORIES = [
  "Food",
  "Shopping",
  "Housing",
  "Transport",
  "Health",
  "Education",
  "Entertainment",
  "Subscriptions",
  "Bills",
  "Finance",
  "Gifts",
  "Travel",
  "General",
  "Other",
];
const ACCOUNT_TYPES = [
  "Bank account",
  "Savings account",
  "Cash",
  "Debit card",
  "Credit card",
  "Digital wallet",
  "Investment",
  "Fixed deposit",
  "Loan / debt",
  "Other",
];
const currencyInfo = (code) =>
  CURRENCIES.find((item) => item[0] === code) || CURRENCIES[0];
const money = (value, code) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code || "USD",
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const monthKey = (date) => String(date || "").slice(0, 7);
const monthLabel = () =>
  new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });

let currentUser = null;
let userListeners = new Set();
let currentSession = null;
let saveQueue = Promise.resolve();
let recurringPersistenceAvailable = true;
const notifyUser = () => userListeners.forEach((listener) => listener(currentUser));
const errorMessage = (error) => error?.message || "Something went wrong. Please try again.";

function logSupabaseError(operation, error) {
  if (error) console.error(`[FinGuard Supabase ${operation}]`, error);
  return errorMessage(error);
}

function authErrorMessage(error, fallback) {
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) return "Email sending is temporarily rate-limited by Supabase. Wait before requesting another code, or configure custom SMTP in Supabase.";
  if (normalized.includes("expired")) return "That verification code has expired. Request a new code and try again.";
  if (normalized.includes("invalid") || normalized.includes("token")) return "Incorrect verification code. Enter the latest 6-digit code from your email.";
  if (normalized.includes("already") || normalized.includes("registered")) return "An account with this email already exists. Sign in or verify the existing signup.";
  if (normalized.includes("confirm") || normalized.includes("not confirmed")) return "Please verify your email before signing in.";
  return fallback || message;
}

function loginErrorMessage(error) {
  const normalized = errorMessage(error).toLowerCase();
  if (normalized.includes("confirm") || normalized.includes("not confirmed")) return "Please verify your email before signing in.";
  if (normalized.includes("rate limit") || normalized.includes("too many requests")) return authErrorMessage(error);
  return "Account not found or password is incorrect. If you're new to FinGuard, create an account.";
}

function routeAfterAuth(navigate) {
  navigate(currentUser?.setup ? "/dashboard" : "/setup");
}

async function ensureProfile(session, fallbackName = "") {
  if (!supabase || !session?.user) throw new Error("No authenticated Supabase session is available.");
  const { data: existingProfile, error: profileError } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (existingProfile) return;
  const profile = {
    user_id: session.user.id,
    full_name: session.user.user_metadata?.full_name || fallbackName,
    country: "",
    currency: "INR",
    monthly_income: 0,
    setup_completed: false,
  };
  const { error } = await supabase.from("profiles").upsert(profile, { onConflict: "user_id" });
  if (error) throw error;
}

async function loadUser() {
  if (!supabase || !currentSession) return null;
  const userId = currentSession.user.id;
  const [profile, accounts, budgets, goals, transactions, contributions, recurring] = await Promise.all([
    supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("accounts").select("*").eq("user_id", userId).order("created_at"),
    supabase.from("budgets").select("*").eq("user_id", userId),
    supabase.from("goals").select("*").eq("user_id", userId).order("created_at"),
    supabase.from("transactions").select("*").eq("user_id", userId).order("date", { ascending: false }),
    supabase.from("goal_contributions").select("*").eq("user_id", userId).order("date", { ascending: false }),
    supabase.from("recurring_payments").select("*").eq("user_id", userId).order("due_date"),
  ]);
  if (recurring.error) {
    const missingTable = recurring.error.code === "42P01" || recurring.error.code === "PGRST205" || recurring.error.message?.toLowerCase().includes("recurring_payments");
    if (missingTable) recurringPersistenceAvailable = false;
  }
  const firstError = [profile, accounts, budgets, goals, transactions, contributions].find((result) => result.error)?.error;
  if (firstError) {
    logSupabaseError("loadUser", firstError);
    throw firstError;
  }
  const accountRows = accounts.data || [];
  const goalRows = goals.data || [];
  const accountName = Object.fromEntries(accountRows.map((account) => [account.id, account.name]));
  const goalName = Object.fromEntries(goalRows.map((goal) => [goal.id, goal.name]));
  const goalContributions = (contributions.data || []).map((item) => ({
    id: item.id, transactionId: item.transaction_id, date: item.date, amount: Number(item.amount), accountId: item.account_id,
    accountName: accountName[item.account_id], goalId: item.goal_id, goalName: goalName[item.goal_id],
  }));
  currentUser = {
    id: userId, name: profile.data?.full_name || currentSession.user.user_metadata?.full_name || "", email: currentSession.user.email,
    country: profile.data?.country || "", currency: profile.data?.currency || "INR", monthlyIncome: Number(profile.data?.monthly_income || 0),
    setup: Boolean(profile.data?.setup_completed), accounts: accountRows.map((item) => ({ id: item.id, name: item.name, type: item.type, balance: Number(item.balance) })),
    budgets: Object.fromEntries((budgets.data || []).map((item) => [item.category, Number(item.amount)])),
    transactions: (transactions.data || []).map((item) => ({ id: item.id, userId, name: item.description, description: item.description, category: item.category, customCategory: item.custom_category, amount: Number(item.amount), type: item.type, accountId: item.account_id, accountName: accountName[item.account_id], goalId: item.goal_id, goalName: goalName[item.goal_id], date: item.date })),
    goals: goalRows.map((item) => ({ id: item.id, name: item.name, target: Number(item.target_amount), saved: Number(item.saved_amount), targetDate: item.target_date, status: item.status, contributions: goalContributions.filter((contribution) => contribution.goalId === item.id) })),
    recurring: (recurring.data || []).map((item) => ({ id: item.id, name: item.name, amount: Number(item.amount), due: item.due_date, frequency: item.frequency, active: item.active })),
  };
  notifyUser();
  return currentUser;
}

async function persistUser(user) {
  if (!supabase || !currentSession || !user) return;
  const userId = currentSession.user.id;
  const profile = { user_id: userId, full_name: user.name, country: user.country || "", currency: user.currency, monthly_income: Number(user.monthlyIncome || 0), setup_completed: Boolean(user.setup) };
  const accountRows = (user.accounts || []).map((item) => ({ id: item.id, user_id: userId, name: item.name, type: item.type || "Bank account", balance: Number(item.balance) || 0 }));
  const budgetRows = Object.entries(user.budgets || {}).map(([category, amount]) => ({ user_id: userId, category, amount: Number(amount) || 0 }));
  const goalRows = (user.goals || []).map((item) => ({ id: item.id, user_id: userId, name: item.name, target_amount: Number(item.target) || 0, saved_amount: Number(item.saved) || 0, target_date: item.targetDate || null, status: item.status || "active" }));
  const contributionRows = (user.goals || []).flatMap((goal) => (goal.contributions || []).map((item) => ({ id: item.id, user_id: userId, goal_id: goal.id, account_id: item.accountId, transaction_id: item.transactionId || null, amount: Number(item.amount), date: item.date })));
  const transactionRows = (user.transactions || []).map((item) => ({ id: item.id, user_id: userId, account_id: item.accountId || null, goal_id: item.goalId || null, type: item.type, amount: Number(item.amount), category: item.category || "General", custom_category: item.customCategory || null, description: item.description || item.name, date: item.date, notes: item.notes || null }));
  const recurringRows = recurringPersistenceAvailable ? (user.recurring || []).map((item) => ({ id: item.id, user_id: userId, name: item.name, amount: Number(item.amount), due_date: item.due, frequency: item.frequency, active: item.active !== false })) : [];
  const deleteResults = await Promise.all([
    supabase.from("transactions").delete().eq("user_id", userId),
    supabase.from("goal_contributions").delete().eq("user_id", userId),
    supabase.from("goals").delete().eq("user_id", userId),
    supabase.from("budgets").delete().eq("user_id", userId),
    supabase.from("accounts").delete().eq("user_id", userId),
    ...(recurringPersistenceAvailable ? [supabase.from("recurring_payments").delete().eq("user_id", userId)] : []),
  ]);
  const deleteError = deleteResults.find((result) => result.error)?.error;
  if (deleteError) throw deleteError;
  const baseResults = await Promise.all([
    supabase.from("profiles").upsert(profile, { onConflict: "user_id" }),
    supabase.from("accounts").insert(accountRows),
    supabase.from("budgets").insert(budgetRows),
    supabase.from("goals").insert(goalRows),
    ...(recurringPersistenceAvailable ? [supabase.from("recurring_payments").insert(recurringRows)] : []),
  ]);
  const baseError = baseResults.find((result) => result.error)?.error;
  if (baseError) throw baseError;
  const results = await Promise.all([
    supabase.from("goal_contributions").insert(contributionRows),
    supabase.from("transactions").insert(transactionRows),
  ]);
  const error = results.find((result) => result.error)?.error;
  if (error) throw error;
}

function updateUser(mutator) {
  if (!currentUser) return null;
  mutator(currentUser);
  notifyUser();
  saveQueue = saveQueue.then(() => persistUser(currentUser)).catch((error) => console.error("Could not save workspace", error));
  return saveQueue;
}
function useUser() {
  const [user, setUser] = useState(currentUser);
  useEffect(() => { userListeners.add(setUser); return () => userListeners.delete(setUser); }, []);
  return [user, () => notifyUser()];
}
function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
function Brand() {
  return (
    <div className="brand auth-brand">
      <span className="brand-mark">F</span>
      <b>
        Fin<span>Guard</span>
      </b>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => localStorage.getItem("finguard-theme") === "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("finguard-theme", dark ? "dark" : "light");
    const sync = (event) => setDark(Boolean(event.detail));
    window.addEventListener("finguard-theme", sync);
    return () => window.removeEventListener("finguard-theme", sync);
  }, [dark]);
  function toggle() {
    const next = !dark;
    setDark(next);
    window.dispatchEvent(new CustomEvent("finguard-theme", { detail: next }));
  }
  return <button className="theme-toggle" type="button" onClick={toggle} aria-label="Toggle color theme">{dark ? "Light mode" : "Dark mode"}</button>;
}

function CountryPicker({ value, onChange }) {
  const [query, setQuery] = useState(value || "");
  const [open, setOpen] = useState(false);
  const matches = COUNTRIES.filter((country) => country.toLowerCase().includes(query.toLowerCase()));
  function selectCountry(country) {
    onChange(country);
    setQuery(country);
    setOpen(false);
  }
  return (
    <div className="country-picker">
      <input
        required
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          if (event.target.value !== value) onChange("");
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search countries..."
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (
        <div className="country-options" role="listbox">
          {matches.length ? matches.map((country) => (
            <button type="button" role="option" aria-selected={country === value} key={country} onClick={() => selectCountry(country)}>
              {country}
            </button>
          )) : <span className="country-empty">No countries found</span>}
        </div>
      )}
    </div>
  );
}

function Auth({ signup = false }) {
  const navigate = useNavigate();
  const [isSignup, setIsSignup] = useState(signup);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verification, setVerification] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => { if (!cooldown) return undefined; const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000); return () => clearInterval(timer); }, [cooldown]);
  async function submit(event) {
    event.preventDefault();
    setError("");
    if (!supabaseConfigured) return setError("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to frontend/.env.");
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) return setError("Enter your email and password.");
    if (isSignup) {
      if (!name.trim()) return setError("Enter your full name.");
      if (password.length < 6) return setError("Use a password with at least 6 characters.");
      if (password !== confirmPassword) return setError("Passwords do not match.");
      const { data, error: signupError } = await supabase.auth.signUp({ email: normalizedEmail, password, options: { data: { full_name: name.trim() } } });
      if (signupError) {
        const message = logSupabaseError("signUp", signupError);
        return setError(authErrorMessage(signupError, message));
      }
      if (!data.user) return setError("The account could not be created.");
      if (data.user.identities && data.user.identities.length === 0) return setError("An account with this email already exists. Sign in or verify the existing signup.");
      setSignupEmail(normalizedEmail);
      setVerificationCode("");
      setVerification(true);
      setCooldown(60);
      return;
    }
    const { data, error: loginError } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
    if (loginError) {
      logSupabaseError("signInWithPassword", loginError);
      return setError(loginErrorMessage(loginError));
    }
    currentSession = data.session;
    try {
      await ensureProfile(currentSession, name.trim());
      await loadUser();
      routeAfterAuth(navigate);
    } catch (profileError) {
      return setError(logSupabaseError("create profile after signIn", profileError));
    }
  }
  async function verify(event) {
    event.preventDefault(); setError("");
    const token = verificationCode.trim();
    if (!/^\d{6}$/.test(token)) return setError("Enter the 6-digit verification code from your email.");
    const { data, error: verifyError } = await supabase.auth.verifyOtp({ email: signupEmail, token, type: "email" });
    if (verifyError) {
      const message = logSupabaseError("verifyOtp", verifyError);
      return setError(authErrorMessage(verifyError, message));
    }
    currentSession = data.session;
    if (!currentSession) {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) { logSupabaseError("getSession after verifyOtp", sessionError); return setError(authErrorMessage(sessionError)); }
      currentSession = sessionData.session;
    }
    try {
      await ensureProfile(currentSession, name.trim());
      await loadUser();
      routeAfterAuth(navigate);
    } catch (profileError) {
      const message = logSupabaseError("create profile after verifyOtp", profileError);
      setError(authErrorMessage(profileError, message));
    }
  }
  async function resend() {
    if (cooldown) return;
    const { error: resendError } = await supabase.auth.resend({ type: "signup", email: signupEmail });
    if (resendError) return setError(authErrorMessage(resendError, logSupabaseError("resend", resendError)));
    setCooldown(60); setError("");
  }
  return (
    <div className="auth-page">
      <div className="auth-card">
        <Brand />
        <p className="eyebrow">PERSONAL FINANCE OS</p>
        <h1>{verification ? "Verify your email." : isSignup ? "Build a clearer money life." : "Welcome back."}</h1>
        <p className="auth-copy">
          {isSignup
            ? "Your accounts, decisions and progress in one private workspace."
            : "Continue to your personal financial workspace."}
        </p>
        {verification ? <form onSubmit={verify}><p className="auth-copy">Enter the 6-digit verification code sent to <strong>{signupEmail}</strong>.</p><label>Verification code<input required type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} placeholder="6-digit code" /></label>{error && <div className="error-box">{error}</div>}<button className="primary-button wide">Verify email</button><button type="button" className="text-button" onClick={resend}>{cooldown ? `Resend code in ${cooldown}s` : "Resend code"}</button></form> : <form onSubmit={submit}>
          {isSignup && (
            <label>
              Full name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isSignup ? "At least 6 characters" : "Your password"}
            />
          </label>
          {isSignup && <label>Confirm password<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat your password" /></label>}
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button wide">
            {isSignup ? "Create workspace" : "Sign in"} <span>â†’</span>
          </button>
        </form>}
        {!verification && <button
          className="text-button"
          onClick={() => {
            setIsSignup(!isSignup);
            setError("");
          }}
        >
          {isSignup
            ? "Already have an account? Sign in"
            : "New to FinGuard? Create an account"}
        </button>}
      </div>
    </div>
  );
}

function Setup() {
  const [user] = useUser();
  const navigate = useNavigate();
  const [country, setCountry] = useState(user?.country || "");
  const [currency, setCurrency] = useState(user?.currency || "INR");
  const [name, setName] = useState("Main account");
  const [type, setType] = useState("Bank account");
  const [balance, setBalance] = useState("");
  const [income, setIncome] = useState("");
  const [budget, setBudget] = useState("");
  if (!user) return <Navigate to="/login" />;
  if (user.setup) return <Navigate to="/dashboard" />;
  async function finish(event) {
    event.preventDefault();
    if (!country.trim() || !name.trim() || balance === "" || income === "") return;
    await updateUser((item) => {
      item.country = country.trim();
      item.currency = currency;
      item.setup = true;
      item.accounts = [
        { id: uid(), name: name.trim(), type, balance: Number(balance) },
      ];
      item.monthlyIncome = Number(income) || 0;
      item.budgets = { overall: Number(budget) || 0 };
    });
    navigate("/dashboard");
  }
  return (
    <div className="setup-page">
      <div className="setup-card">
        <Brand />
        <p className="eyebrow">FIRST-TIME SETUP</p>
        <h1>Start with what is real.</h1>
        <p className="auth-copy">
          Add your starting point and FinGuard will build every insight from
          your own numbers.
        </p>
        <form onSubmit={finish}>
          <label>Country<CountryPicker value={country} onChange={setCountry} /></label>
          <label>
            Primary currency
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.map((item) => (
                <option value={item[0]} key={item[0]}>
                  {item[0]} â€” {item[2]} ({item[1]})
                </option>
              ))}
            </select>
          </label>
          <div className="form-grid">
            <label>
              First account
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Everyday account"
              />
            </label>
            <label>
              Account type
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                {ACCOUNT_TYPES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-grid">
            <label>
              Current balance
              <input
                required
                type="number"
                min="0"
                step="0.01"
                value={balance}
                onChange={(event) => setBalance(event.target.value)}
                placeholder="0.00"
              />
            </label>
            <label>
              Monthly income <span className="optional">required</span>
              <input
                required
                type="number"
                min="0"
                value={income}
                onChange={(event) => setIncome(event.target.value)}
                placeholder="0.00"
              />
            </label>
          </div>
          <label>
            Monthly spending budget <span className="optional">optional</span>
            <input
              type="number"
              min="0"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="0.00"
            />
          </label>
          <button className="primary-button wide">
            Open my workspace <span>â†’</span>
          </button>
        </form>
      </div>
    </div>
  );
}

const navItems = [
  ["/dashboard", "Overview", "O"],
  ["/transactions", "Transactions", "T"],
  ["/accounts", "Accounts", "A"],
  ["/planning", "Planning", "P"],
  ["/analytics", "Analytics", "C"],
  ["/reports", "Reports", "R"],
  ["/insights", "Insights", "I"],
  ["/alerts", "Alerts", "!"],
  ["/profile", "Settings", "S"],
];
function Shell() {
  const [user] = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  if (!user) return <Navigate to="/login" />;
  if (!user.setup && location.pathname !== "/setup")
    return <Navigate to="/setup" />;
  if (location.pathname === "/setup") return <Setup />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/dashboard">
          <span className="brand-mark">F</span>
          <span>
            Fin<span>Guard</span>
          </span>
        </Link>
        <div className="workspace-label">Your workspace</div>
        <nav className="side-nav">
          {navItems.map(([path, label, icon]) => (
            <Link
              className={`nav-item ${location.pathname === path ? "active" : ""}`}
              key={path}
              to={path}
            >
              <span className="nav-icon">{icon}</span>
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="logout"
            onClick={() => {
              currentSession = null;
              currentUser = null;
              supabase?.auth.signOut();
              notifyUser();
              navigate("/login");
            }}
          >
            Log out
          </button>
          <div className="user-chip">
            <span className="avatar">{initials(user.name)}</span>
            <span>
              <strong>{user.name}</strong>
              <small>{user.currency}</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            FinGuard <span>/</span>
            <strong>
              {navItems.find((item) => item[0] === location.pathname)?.[1] ||
                "Workspace"}
            </strong>
          </div>
          <span className="date-label">{monthLabel()}</span>
          <ThemeToggle />
        </header>
        <Routes>
          <Route path="/dashboard" element={<DashboardFixed />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/planning" element={<Planning />} />
          <Route path="/analytics" element={<AnalyticsFixed />} />
          <Route path="/reports" element={<ReportsPdf />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/alerts" element={<AlertsFixed />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/dashboard" />} />
        </Routes>
      </main>
    </div>
  );
}

function incomeForPeriod(user, items, start = today(), end = today()) {
  const configuredIncome = Number(user.monthlyIncome || 0);
  const currentMonth = monthKey(today());
  const includesCurrentMonth = start <= today() && end >= `${currentMonth}-01`;
  if (configuredIncome > 0 && includesCurrentMonth) return configuredIncome;
  return items
    .filter((item) => item.type === "income")
    .reduce((sum, item) => sum + Number(item.amount), 0);
}
function summarize(
  userOrItems,
  itemsOrStart = [],
  startOrEnd = today(),
  end = today(),
) {
  const legacyCall = Array.isArray(userOrItems);
  const user = legacyCall ? { monthlyIncome: 0, accounts: [] } : userOrItems;
  const items = legacyCall ? userOrItems : itemsOrStart;
  const start = legacyCall ? today() : startOrEnd;
  const income = incomeForPeriod(user, items, start, end);
  const expenses = items
    .filter((item) => item.type === "expense")
    .reduce((sum, item) => sum + Number(item.amount), 0);
  const balance = (user.accounts || []).reduce((sum, account) => sum + Number(account.balance), 0);
  const savings = balance - expenses;
  return {
    balance,
    income,
    expenses,
    savings,
    netCashFlow: savings,
    remaining: savings,
  };
}
function healthSummary(user) {
  const current = totals(user);
  const budget = Number(user.budgets?.overall || 0);
  const budgetScore = budget ? Math.max(0, Math.min(25, 25 - (current.expenses / budget) * 25)) : 12;
  const balanceScore = current.balance > 0 ? Math.min(20, 10 + Math.log10(current.balance + 1) * 2) : 0;
  const goalValues = (user.goals || []).filter((goal) => Number(goal.target) > 0);
  const goalScore = goalValues.length ? goalValues.reduce((sum, goal) => sum + Math.min(100, Number(goal.saved || 0) / Number(goal.target) * 100), 0) / goalValues.length / 4 : 12;
  const consistencyScore = current.expenses === 0 ? 20 : Math.max(0, 20 - Math.min(20, current.expenses / Math.max(current.balance, 1) * 20));
  const incomeScore = current.income > 0 ? Math.max(0, Math.min(15, current.income >= current.expenses ? 15 : (current.income / Math.max(current.expenses, 1)) * 15)) : 8;
  const score = Math.round(Math.max(0, Math.min(100, budgetScore + balanceScore + goalScore + consistencyScore + incomeScore)));
  return { score, label: score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Building" : "Needs attention", current };
}
function dashboardInsights(user) {
  const currentRange = rangeFor("current");
  const previousRange = rangeFor("previous");
  const current = rangeTransactions(user, currentRange.start, currentRange.end);
  const previous = rangeTransactions(user, previousRange.start, previousRange.end);
  const currentExpenses = current.filter((item) => item.type === "expense");
  const previousExpenses = previous.filter((item) => item.type === "expense");
  const insights = [];
  const byCategory = CATEGORIES.map((category) => ({ category, amount: currentExpenses.filter((item) => item.category === category).reduce((sum, item) => sum + Number(item.amount), 0) })).filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount);
  if (byCategory[0]) insights.push({ title: "Spending pattern", body: `You spent ${money(byCategory[0].amount, user.currency)} on ${byCategory[0].category} this month.` });
  const budgetEntries = Object.entries(user.budgets || {}).filter(([category, value]) => category !== "overall" && Number(value) > 0);
  const usedBudget = budgetEntries.map(([category, value]) => ({ category, used: byCategory.find((item) => item.category === category)?.amount || 0, budget: Number(value) })).sort((a, b) => b.used / b.budget - a.used / a.budget)[0];
  if (usedBudget && usedBudget.used > 0) insights.push({ title: "Budget pulse", body: `You have used ${Math.round((usedBudget.used / usedBudget.budget) * 100)}% of your ${usedBudget.category} budget.` });
  const goal = (user.goals || []).find((item) => Number(item.target) > 0 && Number(item.saved) < Number(item.target));
  if (goal) insights.push({ title: "Goal progress", body: `${goal.name} is ${Math.round((Number(goal.saved || 0) / Number(goal.target)) * 100)}% complete.` });
  if (user.accounts?.length) insights.push({ title: "Balance", body: `Your current total balance is ${money((user.accounts || []).reduce((sum, item) => sum + Number(item.balance), 0), user.currency)}.` });
  const currentSpend = currentExpenses.reduce((sum, item) => sum + Number(item.amount), 0);
  const previousSpend = previousExpenses.reduce((sum, item) => sum + Number(item.amount), 0);
  if (previousSpend > 0 && currentSpend > previousSpend) insights.push({ title: "Spending trend", body: `Your spending increased ${money(currentSpend - previousSpend, user.currency)} compared with last month.` });
  return insights;
}
function totals(user) {
  const currentMonth = monthKey(today());
  const transactions = user.transactions || [];
  return summarize(
    user,
    transactions.filter((item) => monthKey(item.date) === currentMonth),
    `${currentMonth}-01`,
    today(),
  );
}
function Dashboard() {
  const [user, refresh] = useUser();
  const [show, setShow] = useState(false);
  const [query, setQuery] = useState("");
  const summary = totals(user);
  const cur = user.currency;
  const visible = (user.transactions || [])
    .filter((item) =>
      `${item.name} ${item.category}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 5);
  const categorySpend = CATEGORIES.map((category) => ({
    category,
    amount: (user.transactions || [])
      .filter(
        (item) =>
          item.type === "expense" &&
          item.category === category &&
          monthKey(item.date) === monthKey(today()),
      )
      .reduce((sum, item) => sum + Number(item.amount), 0),
  }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 4);
  const budget = Number(user.budgets?.overall || 0);
  return (
    <div className="page-content dashboard-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">
            {new Date()
              .toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })
              .toUpperCase()}
          </span>
          <h1>
            Good day, {user.name.split(" ")[0]}
            <span>.</span>
          </h1>
          <p>Your financial pulse, calculated from the data you entered.</p>
        </div>
        <button
          className="add-transaction-button"
          onClick={() => setShow(true)}
        >
          + Add transaction
        </button>
      </section>
      <section className="metrics-grid">
        <Metric
          label="Total balance"
          value={money(summary.balance, cur)}
          note={`Across ${user.accounts.length} account${user.accounts.length === 1 ? "" : "s"}`}
          accent
        />
        <Metric
          label="Income this month"
          value={money(summary.income, cur)}
          note="Your recorded inflow"
        />
        <Metric
          label="Expenses this month"
          value={money(summary.expenses, cur)}
          note={
            budget
              ? `${money(Math.max(budget - summary.expenses, 0), cur)} budget remaining`
              : "Set a budget in Planning"
          }
        />
        <Metric
          label="Savings rate"
          value={`${summary.income > 0 ? Math.max(0, (summary.remaining / summary.income) * 100).toFixed(1) : "0.0"}%`}
          note="Income kept this month"
        />
      </section>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recent activity</h2>
              <p>Transactions linked to your accounts</p>
            </div>
            <Link className="quiet-link" to="/transactions">
              View all â†’
            </Link>
          </div>
          <div className="search-wrap">
            <span>âŒ•</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your activity"
            />
          </div>
          {visible.length ? (
            visible.map((item) => (
              <TransactionRow key={item.id} transaction={item} currency={cur} />
            ))
          ) : (
            <Empty text="No transactions recorded yet." />
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Spending map</h2>
              <p>{monthLabel()} by category</p>
            </div>
          </div>
          {categorySpend.length ? (
            <div className="spending-list">
              {categorySpend.map((item) => (
                <div className="spending-item" key={item.category}>
                  <div>
                    <strong>{item.category}</strong>
                    <span>{money(item.amount, cur)}</span>
                  </div>
                  <div className="progress">
                    <i
                      style={{
                        width: `${Math.min(100, summary.expenses ? (item.amount / summary.expenses) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="Add expenses to see your spending mix." />
          )}
          {budget > 0 && (
            <div className="budget-callout">
              <span>Monthly budget</span>
              <strong>
                {money(summary.expenses, cur)}{" "}
                <small>of {money(budget, cur)}</small>
              </strong>
              <div className="progress">
                <i
                  style={{
                    width: `${Math.min(100, (summary.expenses / budget) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
        </section>
      </div>
      {show && (
        <TransactionModal
          currency={cur}
          accounts={user.accounts}
          goals={user.goals}
          onClose={() => setShow(false)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
function Metric({ label, value, note, accent }) {
  return (
    <article className={`metric-card ${accent ? "balance-card" : ""}`}>
      <span>{label}</span>
      <strong className="metric-value">{value}</strong>
      <small>{note}</small>
    </article>
  );
}
function TransactionRow({ transaction, currency, accountName }) {
  const isGoalContribution = transaction.type === "goal_contribution";
  return (
    <div className="activity-row">
      <div className="merchant-icon">
        {transaction.name.charAt(0).toUpperCase()}
      </div>
      <div className="activity-name">
        <strong>{isGoalContribution ? `Goal contribution - ${transaction.goalName || transaction.name}` : transaction.name}</strong>
        <small>
          {isGoalContribution ? "Goal Contribution" : transaction.customCategory || transaction.category} Â·{" "}
          {accountName || transaction.accountName || "Account"} Â·{" "}
          {transaction.date}
        </small>
      </div>
      <span
        className={`amount ${transaction.type === "income" ? "income-amount" : ""}`}
      >
        {transaction.type === "income" ? "+" : "-"}
        {money(transaction.amount, currency)}
      </span>
    </div>
  );
}
function Empty({ text }) {
  return <div className="empty-state">{text}</div>;
}

function TransactionModal({ currency, accounts, goals = [], editing, onClose, onSaved }) {
  const [name, setName] = useState(editing?.name || "");
  const [category, setCategory] = useState(editing?.category || "General");
  const [amount, setAmount] = useState(editing?.amount || "");
  const [type, setType] = useState(editing?.type || "expense");
  const [goalId, setGoalId] = useState(editing?.goalId || goals[0]?.id || "");
  const [customCategory, setCustomCategory] = useState(editing?.customCategory || "");
  const [accountId, setAccountId] = useState(
    editing?.accountId || accounts[0]?.id || "",
  );
  const [date, setDate] = useState(editing?.date || today());
  const [error, setError] = useState("");
  function save(event) {
    event.preventDefault();
    const selectedGoal = goals.find((goal) => goal.id === goalId);
    const description = type === "goal_contribution" ? `Goal contribution - ${selectedGoal?.name || ""}` : name.trim();
    if ((!description || !amount || !accountId) || (type === "goal_contribution" && !selectedGoal))
      return setError("Add a description, amount and account.");
    if (category === "Other" && !customCategory.trim() && type !== "goal_contribution") return setError("Please specify what this transaction is for.");
    const value = Number(amount);
    if (value <= 0) return setError("Amount must be greater than zero.");
    updateUser((user) => {
      const account = user.accounts.find((item) => item.id === accountId);
      const old = user.transactions.find((item) => item.id === editing?.id);
      if (old) {
        const oldAccount = user.accounts.find(
          (item) => item.id === old.accountId,
        );
        if (oldAccount)
          oldAccount.balance +=
            old.type === "income" ? -Number(old.amount) : Number(old.amount);
      }
      if (!account || (type !== "income" && Number(account.balance) < value)) return setError("Insufficient balance in this account.");
      if (type === "goal_contribution") {
        const remaining = Math.max(Number(selectedGoal.target) - Number(selectedGoal.saved || 0), 0);
        if (value > remaining) return setError(`Only ${money(remaining, currency)} is remaining for this goal.`);
        account.balance -= value;
        selectedGoal.saved = Number(selectedGoal.saved || 0) + value;
        selectedGoal.contributions = [...(selectedGoal.contributions || []), { id: uid(), date, amount: value, accountId, accountName: account.name, goalId, goalName: selectedGoal.name }];
      } else account.balance += type === "income" ? value : -value;
      const transaction = {
        id: editing?.id || uid(),
        name: description,
        description,
        category,
        amount: value,
        type,
        accountId,
        accountName: account?.name,
        customCategory: category === "Other" ? customCategory.trim() : "",
        goalId: type === "goal_contribution" ? goalId : null,
        goalName: type === "goal_contribution" ? selectedGoal.name : null,
        date,
      };
      user.transactions = editing
        ? user.transactions.map((item) =>
            item.id === editing.id ? transaction : item,
          )
        : [transaction, ...(user.transactions || [])];
    });
    onSaved();
    onClose();
  }
  return (
    <div className="modal-overlay">
      <div className="transaction-modal">
        <div className="modal-header">
          <div>
            <p className="eyebrow">{editing ? "EDIT" : "NEW"} TRANSACTION</p>
            <h2>{editing ? "Update activity" : "Record activity"}</h2>
          </div>
          <button className="close-button" onClick={onClose}>
            Ã—
          </button>
        </div>
        <form onSubmit={save}>
          <label>
            Description
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Grocery shopping"
            />
          </label>
          <div className="form-grid">
            <label>
              Type
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
                <option value="goal_contribution">Goal Contribution</option>
              </select>
            </label>
            <label>
              Amount ({currencyInfo(currency)[1]})
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
            </label>
          </div>
          {type === "goal_contribution" && <label>Goal<select value={goalId} onChange={(event) => setGoalId(event.target.value)}>{goals.map((goal) => <option value={goal.id} key={goal.id}>{goal.name}</option>)}</select></label>}
          <div className="form-grid">
            <label>
              Account
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((account) => (
                  <option value={account.id} key={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
          </div>
          <label>
            Category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              {CATEGORIES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          {category === "Other" && type !== "goal_contribution" && <label>What is this for?<input required value={customCategory} onChange={(event) => setCustomCategory(event.target.value)} placeholder="e.g. Pet supplies" /></label>}
          {error && <div className="error-box">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="cancel-button" onClick={onClose}>
              Cancel
            </button>
            <button className="save-button">Save transaction</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Transactions() {
  const [user, refresh] = useUser();
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState("all");
  const [account, setAccount] = useState("all");
  const [category, setCategory] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState("newest");
  const [search, setSearch] = useState("");
  const list = (user.transactions || [])
    .filter(
      (item) =>
        (filter === "all" || item.type === filter) &&
        (account === "all" || item.accountId === account) &&
        (category === "all" || item.category === category) &&
        (!dateFrom || item.date >= dateFrom) &&
        (!dateTo || item.date <= dateTo) &&
        `${item.name} ${item.category} ${item.accountName}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => sort === "oldest" ? a.date.localeCompare(b.date) : sort === "highest" ? Number(b.amount) - Number(a.amount) : sort === "lowest" ? Number(a.amount) - Number(b.amount) : b.date.localeCompare(a.date));
  function remove(id) {
    if (
      window.confirm(
        "Delete this transaction? Its account balance will be restored.",
      )
    ) {
      updateUser((current) => {
        const item = current.transactions.find(
          (transaction) => transaction.id === id,
        );
        const linked = current.accounts.find(
          (itemAccount) => itemAccount.id === item?.accountId,
        );
        if (linked && item)
          linked.balance +=
            item.type === "income" ? -Number(item.amount) : Number(item.amount);
        if (item?.type === "goal_contribution") {
          const goal = current.goals.find((candidate) => candidate.id === item.goalId);
          const contribution = goal?.contributions?.find((candidate) => candidate.transactionId === item.id);
          if (goal) goal.saved = Math.max(0, Number(goal.saved || 0) - Number(item.amount));
          if (contribution) goal.contributions = goal.contributions.filter((candidate) => candidate.id !== contribution.id);
        }
        current.transactions = current.transactions.filter(
          (transaction) => transaction.id !== id,
        );
      });
      refresh();
    }
  }
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR ACTIVITY</p>
          <h1>
            Transactions<span>.</span>
          </h1>
          <p className="page-subtitle">
            Every entry updates the account it belongs to.
          </p>
        </div>
        <button className="primary-button" onClick={() => setShow(true)}>
          + Add transaction
        </button>
      </div>
      <div className="transaction-card">
        <div className="transaction-header">
          <div>
            <h2>Transaction history</h2>
            <p>
              {list.length} matching record{list.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="filters">
            <input
              placeholder="Search activity"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All types</option>
              <option value="income">Income</option>
              <option value="expense">Expenses</option>
              <option value="goal_contribution">Goal Contributions</option>
            </select>
            <select
              value={account}
              onChange={(event) => setAccount(event.target.value)}
            >
              <option value="all">All accounts</option>
              {user.accounts.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">All categories</option>
              {CATEGORIES.map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label="From date" />
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label="To date" />
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="highest">Highest amount</option><option value="lowest">Lowest amount</option>
            </select>
          </div>
        </div>
        {list.length ? (
          list.map((item) => (
            <div className="transaction-row" key={item.id}>
              <TransactionRow transaction={item} currency={user.currency} />
              <div className="row-actions">
                <button className="edit-btn" onClick={() => setEditing(item)}>
                  Edit
                </button>
                <button className="delete-btn" onClick={() => remove(item.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))
        ) : (
          <Empty text="No matching transactions." />
        )}
      </div>
      {(show || editing) && (
        <TransactionModal
          currency={user.currency}
          accounts={user.accounts}
          goals={user.goals}
          editing={editing}
          onClose={() => {
            setShow(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function Accounts() {
  const [user, refresh] = useUser();
  const [name, setName] = useState("");
  const [type, setType] = useState("Bank account");
  const [balance, setBalance] = useState("");
  const [transfer, setTransfer] = useState({ from: "", to: "", amount: "" });
  function add(event) {
    event.preventDefault();
    if (!name.trim() || balance === "") return;
    updateUser((current) =>
      current.accounts.push({
        id: uid(),
        name: name.trim(),
        type,
        balance: Number(balance),
      }),
    );
    setName("");
    setBalance("");
    refresh();
  }
  function remove(id) {
    if (user.accounts.length === 1) return;
    updateUser((current) => {
      current.accounts = current.accounts.filter(
        (account) => account.id !== id,
      );
      current.transactions = current.transactions.filter(
        (item) => item.accountId !== id,
      );
    });
    refresh();
  }
  function move(event) {
    event.preventDefault();
    const amount = Number(transfer.amount);
    if (
      !transfer.from ||
      !transfer.to ||
      transfer.from === transfer.to ||
      amount <= 0
    )
      return;
    updateUser((current) => {
      const from = current.accounts.find((item) => item.id === transfer.from);
      const to = current.accounts.find((item) => item.id === transfer.to);
      if (from && to && from.balance >= amount) {
        from.balance -= amount;
        to.balance += amount;
      }
    });
    setTransfer({ from: "", to: "", amount: "" });
    refresh();
  }
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR MONEY</p>
          <h1>
            Accounts<span>.</span>
          </h1>
          <p className="page-subtitle">
            Balances stay synchronized with every income, expense and transfer.
          </p>
        </div>
      </div>
      <div className="account-grid">
        {user.accounts.map((account) => (
          <article className="account-card" key={account.id}>
            <div>
              <span>{account.type || "ACCOUNT"}</span>
              <h3>{account.name}</h3>
            </div>
            <strong>{money(account.balance, user.currency)}</strong>
            {user.accounts.length > 1 && (
              <button onClick={() => remove(account.id)}>Remove</button>
            )}
          </article>
        ))}
        <form className="account-card add-account" onSubmit={add}>
          <h3>Add an account</h3>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Account name"
          />
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            {ACCOUNT_TYPES.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            value={balance}
            onChange={(event) => setBalance(event.target.value)}
            placeholder="Current balance"
          />
          <button className="save-button">Add account</button>
        </form>
      </div>
      {user.accounts.length > 1 && (
        <section className="panel transfer-panel">
          <div className="panel-heading">
            <div>
              <h2>Move money</h2>
              <p>
                Transfers change balances without affecting income or spending.
              </p>
            </div>
          </div>
          <form className="transfer-form" onSubmit={move}>
            <select
              value={transfer.from}
              onChange={(event) =>
                setTransfer({ ...transfer, from: event.target.value })
              }
            >
              <option value="">From account</option>
              {user.accounts.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <span>â†’</span>
            <select
              value={transfer.to}
              onChange={(event) =>
                setTransfer({ ...transfer, to: event.target.value })
              }
            >
              <option value="">To account</option>
              {user.accounts.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={transfer.amount}
              onChange={(event) =>
                setTransfer({ ...transfer, amount: event.target.value })
              }
              placeholder="Amount"
            />
            <button className="primary-button">Transfer</button>
          </form>
        </section>
      )}
    </div>
  );
}

function ContributionModal({ goal, user, onClose, onSaved }) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(user.accounts[0]?.id || "");
  const [error, setError] = useState("");
  function save(event) {
    event.preventDefault();
    const value = Number(amount);
    const account = user.accounts.find((item) => item.id === accountId);
    const remaining = Math.max(Number(goal.target) - Number(goal.saved || 0), 0);
    if (!account || !value || value <= 0) return setError("Enter a contribution amount and account.");
    if (value > Number(account.balance)) return setError("Insufficient balance in this account.");
    if (value > remaining) return setError(`Only ${money(remaining, user.currency)} is remaining for this goal.`);
    const transactionId = uid();
    updateUser((current) => {
      const currentGoal = current.goals.find((item) => item.id === goal.id);
      const currentAccount = current.accounts.find((item) => item.id === accountId);
      if (!currentGoal || !currentAccount) return;
      currentAccount.balance -= value;
      currentGoal.saved = Number(currentGoal.saved || 0) + value;
      currentGoal.contributions = [
        ...(currentGoal.contributions || []),
        { id: uid(), transactionId, date: today(), amount: value, accountId, accountName: currentAccount.name, goalId: currentGoal.id, goalName: currentGoal.name },
      ];
      current.transactions = [{ id: transactionId, userId: current.id, name: `Goal contribution - ${currentGoal.name}`, description: `Goal contribution - ${currentGoal.name}`, category: "Goal Contribution", customCategory: "", amount: value, type: "goal_contribution", accountId, accountName: currentAccount.name, goalId: currentGoal.id, goalName: currentGoal.name, date: today() }, ...(current.transactions || [])];
    });
    onSaved();
    onClose();
  }
  return <div className="modal-overlay"><div className="transaction-modal"><div className="modal-header"><div><p className="eyebrow">GOAL CONTRIBUTION</p><h2>Add contribution</h2></div><button className="close-button" onClick={onClose}>×</button></div><form onSubmit={save}><label>Amount ({currencyInfo(user.currency)[1]})<input autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label><label>From account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{user.accounts.map((account) => <option value={account.id} key={account.id}>{account.name} ({money(account.balance, user.currency)})</option>)}</select></label>{error && <div className="error-box">{error}</div>}<div className="modal-actions"><button type="button" className="cancel-button" onClick={onClose}>Cancel</button><button className="save-button">Add contribution</button></div></form></div></div>;
}

function Planning() {
  const [user, refresh] = useUser();
  const [overall, setOverall] = useState(user.budgets?.overall || "");
  const [category, setCategory] = useState("Food");
  const [categoryBudget, setCategoryBudget] = useState("");
  const [goalName, setGoalName] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [goalDate, setGoalDate] = useState("");
  const [contributingGoal, setContributingGoal] = useState(null);
  const expenses = user.transactions.filter(
    (item) =>
      item.type === "expense" && monthKey(item.date) === monthKey(today()),
  );
  const spent = (categoryName) =>
    expenses
      .filter((item) => item.category === categoryName)
      .reduce((sum, item) => sum + Number(item.amount), 0);
  function saveOverall() {
    updateUser((current) => {
      current.budgets = { ...current.budgets, overall: Number(overall) || 0 };
    });
    refresh();
  }
  function saveCategory(event) {
    event.preventDefault();
    updateUser((current) => {
      current.budgets = {
        ...current.budgets,
        [category]: Number(categoryBudget) || 0,
      };
    });
    setCategoryBudget("");
    refresh();
  }
  function addGoal(event) {
    event.preventDefault();
    if (!goalName.trim() || !goalTarget) return;
    updateUser((current) =>
      current.goals.push({
        id: uid(),
        name: goalName.trim(),
        target: Number(goalTarget),
        saved: 0,
        targetDate: goalDate || null,
        status: "active",
        contributions: [],
      }),
    );
    setGoalName("");
    setGoalTarget("");
    setGoalDate("");
    refresh();
  }
  function removeContribution(goalId, contributionId) {
    if (!window.confirm("Remove this contribution and restore the account balance?")) return;
    updateUser((current) => {
      const goal = current.goals.find((item) => item.id === goalId);
      const contribution = goal?.contributions?.find((item) => item.id === contributionId);
      const account = current.accounts.find((item) => item.id === contribution?.accountId);
      if (!goal || !contribution || !account) return;
      goal.saved = Math.max(0, Number(goal.saved || 0) - Number(contribution.amount));
      account.balance += Number(contribution.amount);
      goal.contributions = goal.contributions.filter((item) => item.id !== contributionId);
      current.transactions = (current.transactions || []).filter((item) => item.id !== contribution.transactionId);
    });
    refresh();
  }
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PLAN AHEAD</p>
          <h1>
            Planning<span>.</span>
          </h1>
          <p className="page-subtitle">
            Give your money a direction, then watch actual activity measure
            progress.
          </p>
        </div>
      </div>
      <div className="planning-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Monthly budgets</h2>
              <p>Alerts are based on this month's spending.</p>
            </div>
          </div>
          <div className="budget-editor">
            <label>
              Overall budget
              <input
                type="number"
                min="0"
                value={overall}
                onChange={(event) => setOverall(event.target.value)}
                placeholder="0.00"
              />
            </label>
            <button className="primary-button" onClick={saveOverall}>
              Save overall budget
            </button>
          </div>
          {Object.entries(user.budgets || {})
            .filter(([key]) => key !== "overall")
            .map(([key, value]) => (
              <div className="budget-line" key={key}>
                <div>
                  <strong>{key}</strong>
                  <span>
                    {money(spent(key), user.currency)} of{" "}
                    {money(value, user.currency)}
                  </span>
                </div>
                <div className="progress">
                  <i
                    className={spent(key) >= value ? "over" : ""}
                    style={{
                      width: `${Math.min(100, value ? (spent(key) / value) * 100 : 0)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          <form className="inline-form" onSubmit={saveCategory}>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              {CATEGORIES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              value={categoryBudget}
              onChange={(event) => setCategoryBudget(event.target.value)}
              placeholder="Set category budget"
            />
            <button className="save-button">Add budget</button>
          </form>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Financial goals</h2>
              <p>Track the things your savings are for.</p>
            </div>
          </div>
          <form className="goal-form" onSubmit={addGoal}>
            <input
              value={goalName}
              onChange={(event) => setGoalName(event.target.value)}
              placeholder="Goal name"
            />
            <input
              type="number"
              min="0"
              value={goalTarget}
              onChange={(event) => setGoalTarget(event.target.value)}
              placeholder="Target amount"
            />
            <input type="date" value={goalDate} onChange={(event) => setGoalDate(event.target.value)} />
            <button className="save-button">Add goal</button>
          </form>
          {user.goals.length ? (
            user.goals.map((goal) => {
              const saved = Number(goal.saved || 0);
              const target = Number(goal.target || 0);
              const progress = target ? Math.min(100, (saved / target) * 100) : 0;
              const remaining = Math.max(target - saved, 0);
              return <div className="goal" key={goal.id}>
                <div>
                  <b>{goal.name}</b>
                  <span>
                    {money(saved, user.currency)} saved of {money(target, user.currency)}
                  </span>
                </div>
                <div className="progress">
                  <i
                    style={{
                      width: `${progress}%`,
                    }}
                  />
                </div>
                <div className="goal-meta"><span>{progress.toFixed(0)}% complete</span><span>{money(remaining, user.currency)} remaining</span></div>
                {goal.targetDate && <small className="goal-due">Target date: {goal.targetDate}</small>}
                {progress === 100 ? <strong>Goal completed</strong> : <button className="primary-button" onClick={() => setContributingGoal(goal)}>Add contribution</button>}
                <div className="goal-history"><strong>Contribution history</strong>{goal.contributions?.length ? goal.contributions.map((contribution) => <div key={contribution.id}><span>{contribution.date} - {money(contribution.amount, user.currency)} - {contribution.accountName}</span><button className="delete-btn" onClick={() => removeContribution(goal.id, contribution.id)}>Reverse</button></div>) : <Empty text="No contributions yet." />}</div>
              </div>;
            })
          ) : (
            <Empty text="No goals yet." />
          )}
        </section>
      </div>
      {contributingGoal && <ContributionModal goal={contributingGoal} user={user} onClose={() => setContributingGoal(null)} onSaved={refresh} />}
    </div>
  );
}

function rangeTransactions(user, start, end) {
  return (user.transactions || []).filter(
    (item) => item.date >= start && item.date <= end,
  );
}
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
function rangeFor(value) {
  const end = new Date();
  const start = new Date(end);
  if (value === "previous") {
    start.setMonth(start.getMonth() - 1, 1);
    end.setDate(0);
  } else if (value === "3months") start.setMonth(start.getMonth() - 2, 1);
  else if (value === "6months") start.setMonth(start.getMonth() - 5, 1);
  else if (value === "year") start.setFullYear(start.getFullYear() - 1, 0, 1);
  else if (value === "currentYear") start.setMonth(0, 1);
  else start.setDate(1);
  return { start: isoDate(start), end: isoDate(end) };
}
function transactionTotals(items) {
  return {
    income: items
      .filter((item) => item.type === "income")
      .reduce((sum, item) => sum + Number(item.amount), 0),
    expenses: items
      .filter((item) => item.type === "expense")
      .reduce((sum, item) => sum + Number(item.amount), 0),
  };
}
function budgetStatus(spent, budget, currency) {
  const used = Number(budget) > 0 ? (Number(spent) / Number(budget)) * 100 : 0;
  if (spent > budget)
    return {
      label: "Exceeded",
      message: `You exceeded your budget by ${money(spent - budget, currency)}`,
      used,
    };
  if (spent === budget && budget > 0)
    return {
      label: "Budget reached",
      message: "You have used 100% of your budget.",
      used: 100,
    };
  if (used >= 90)
    return {
      label: "90% used",
      message: `You have used ${used.toFixed(1)}% of your budget.`,
      used,
    };
  if (used >= 75)
    return {
      label: "75% used",
      message: `You have used ${used.toFixed(1)}% of your budget.`,
      used,
    };
  return {
    label: "Under budget",
    message: `You have used ${used.toFixed(1)}% of your budget.`,
    used,
  };
}
function cashFlowLabel() {
  return "Savings";
}
function generateFinancialPdf({ user, items, totals, selected, categories }) {
  const document = new jsPDF();
  const currency = user.currency;
  const net = totals.savings;
  const savingsRate =
    totals.income > 0 ? `${((net / totals.income) * 100).toFixed(1)}%` : "N/A";
  const expenses = items.filter((item) => item.type === "expense");
  const income = items.filter((item) => item.type === "income");
  const categoryRows = categories.map((item) => [
    item.label,
    money(item.amount, currency),
    `${totals.expenses ? ((item.amount / totals.expenses) * 100).toFixed(1) : "0.0"}%`,
  ]);
  const budgetRows = Object.entries(user.budgets || {})
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => {
      const spent =
        label === "overall"
          ? totals.expenses
          : expenses
              .filter((item) => item.category === label)
              .reduce((sum, item) => sum + Number(item.amount), 0);
      const status = budgetStatus(spent, Number(value), currency);
      return [
        label === "overall" ? "Overall" : label,
        money(value, currency),
        money(spent, currency),
        money(Math.max(Number(value) - spent, 0), currency),
        `${status.used.toFixed(1)}%`,
        status.label,
      ];
    });
  const incomeRows = CATEGORIES.map((label) => [
    label,
    income
      .filter((item) => item.category === label)
      .reduce((sum, item) => sum + Number(item.amount), 0),
  ])
    .filter(([, amount]) => amount > 0)
    .map(([label, amount]) => [label, money(amount, currency)]);
  const insights = [
    categories[0]
      ? `Highest spending category: ${categories[0].label} (${money(categories[0].amount, currency)}).`
      : "No expense categories in this period.",
    `Savings: ${money(net, currency)} (${savingsRate} of income).`,
  ];
  const addTitle = (title) => {
    document.setFontSize(13);
    document.setTextColor(22, 55, 48);
    document.text(
      title,
      14,
      document.lastAutoTable?.finalY ? document.lastAutoTable.finalY + 14 : 28,
    );
  };
  document.setFontSize(20);
  document.setTextColor(19, 37, 42);
  document.text("FinGuard Financial Report", 14, 18);
  document.setFontSize(9);
  document.setTextColor(105, 120, 116);
  document.text(
    `Generated ${new Date().toLocaleDateString()} | ${selected.start} to ${selected.end}`,
    14,
    24,
  );
  addTitle("1. Financial Summary");
  autoTable(document, {
    startY: 34,
    head: [["Metric", "Value"]],
    body: [
      ["Total income", money(totals.income, currency)],
      ["Total expenses", money(totals.expenses, currency)],
      ["Savings", money(net, currency)],
      ["Savings rate", savingsRate],
    ],
    theme: "grid",
    headStyles: { fillColor: [22, 136, 93] },
  });
  addTitle("2. Account Summary");
  autoTable(document, {
    head: [["Account", "Type", "Current balance"]],
    body: user.accounts.map((account) => [
      account.name,
      account.type || "Account",
      money(account.balance, currency),
    ]),
    theme: "grid",
    headStyles: { fillColor: [22, 136, 93] },
  });
  addTitle("3. Expense Summary");
  autoTable(document, {
    head: [["Category", "Amount", "Percent of spending"]],
    body: categoryRows.length
      ? categoryRows
      : [["No expenses", money(0, currency), "0.0%"]],
    foot: [["Total", money(totals.expenses, currency), "100.0%"]],
    theme: "grid",
    headStyles: { fillColor: [233, 121, 98] },
  });
  if (incomeRows.length) {
    addTitle("4. Income Summary");
    autoTable(document, {
      head: [["Source / category", "Amount"]],
      body: incomeRows,
      theme: "grid",
      headStyles: { fillColor: [22, 136, 93] },
    });
  }
  addTitle("5. Budget Performance");
  autoTable(document, {
    head: [["Budget", "Budget amount", "Spent", "Remaining", "Used", "Status"]],
    body: budgetRows.length
      ? budgetRows
      : [["No budgets configured", "-", "-", "-", "-", "-"]],
    theme: "grid",
    headStyles: { fillColor: [229, 169, 62] },
  });
  addTitle("6. Transaction Details");
  autoTable(document, {
    head: [["Date", "Type", "Account", "Category", "Description", "Amount"]],
    body: items.length
      ? items.map((item) => [
          item.date,
          item.type,
          item.accountName || "Account",
          item.category,
          item.name,
          money(item.amount, currency),
        ])
      : [["No transactions", "-", "-", "-", "-", money(0, currency)]],
    theme: "striped",
    headStyles: { fillColor: [24, 45, 51] },
    styles: { fontSize: 8 },
  });
  addTitle("7. Goals Summary");
  autoTable(document, {
    head: [["Goal", "Target", "Saved", "Remaining", "Progress"]],
    body: user.goals?.length
      ? user.goals.map((goal) => [
          goal.name,
          money(goal.target, currency),
          money(goal.saved, currency),
          money(Math.max(goal.target - goal.saved, 0), currency),
          `${Math.min(100, goal.target ? (goal.saved / goal.target) * 100 : 0).toFixed(1)}%`,
        ])
      : [["No goals configured", "-", "-", "-", "-"]],
    theme: "grid",
    headStyles: { fillColor: [22, 136, 93] },
  });
  addTitle("8. Financial Insights");
  autoTable(document, {
    body: insights.map((insight) => [insight]),
    theme: "plain",
    styles: { fontSize: 10 },
  });
  const pageCount = document.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    document.setPage(page);
    document.setFontSize(8);
    document.setTextColor(120, 130, 128);
    document.text(
      `FinGuard | Page ${page} of ${pageCount}`,
      14,
      document.internal.pageSize.height - 8,
    );
  }
  document.save(
    `finguard-financial-report-${selected.start}-${selected.end}.pdf`,
  );
}
function BarList({ items, currency, color = "green" }) {
  const max = Math.max(...items.map((item) => item.amount), 1);
  return (
    <div className="bar-list">
      {items.length ? (
        items.map((item) => (
          <div className="bar-row" key={item.label}>
            <div>
              <strong>{item.label}</strong>
              <span>
                {money(item.amount, currency)}{" "}
                {item.percent !== undefined
                  ? `(${item.percent.toFixed(1)}%)`
                  : ""}
              </span>
            </div>
            <div className="bar-track">
              <i
                className={color}
                style={{ width: `${Math.max(2, (item.amount / max) * 100)}%` }}
              />
            </div>
          </div>
        ))
      ) : (
        <Empty text="Add transactions to build this view." />
      )}
    </div>
  );
}
function Analytics() {
  const [user] = useUser();
  const [period, setPeriod] = useState("current");
  const { start, end } = rangeFor(period);
  const items = rangeTransactions(user, start, end);
  const totals = summarize(user, items, selected.start, selected.end);
  const expenses = items.filter((item) => item.type === "expense");
  const byCategory = CATEGORIES.map((label) => ({
    label,
    amount: expenses
      .filter((item) => item.category === label)
      .reduce((sum, item) => sum + Number(item.amount), 0),
  }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const byAccount = user.accounts
    .map((account) => ({
      label: account.name,
      amount: expenses
        .filter((item) => item.accountId === account.id)
        .reduce((sum, item) => sum + Number(item.amount), 0),
    }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const daily = expenses
    .reduce((list, item) => {
      const found = list.find((entry) => entry.label === item.date);
      if (found) found.amount += Number(item.amount);
      else list.push({ label: item.date, amount: Number(item.amount) });
      return list;
    }, [])
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 7);
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">UNDERSTAND YOUR MONEY</p>
          <h1>
            Analytics<span>.</span>
          </h1>
          <p className="page-subtitle">
            Spending patterns calculated from your actual transactions.
          </p>
        </div>
        <select
          className="period-select"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
        >
          <option value="current">Current month</option>
          <option value="previous">Previous month</option>
          <option value="3months">Last 3 months</option>
          <option value="6months">Last 6 months</option>
          <option value="year">Last year</option>
        </select>
      </div>
      <section className="metrics-grid">
        <Metric
          label="Income"
          value={money(totals.income, user.currency)}
          note={`${items.filter((item) => item.type === "income").length} income records`}
        />
        <Metric
          label="Expenses"
          value={money(totals.expenses, user.currency)}
          note={`${expenses.length} expense records`}
        />
        <Metric
          label="Savings"
          value={money(totals.balance - totals.expenses, user.currency)}
          note="Total balance minus expenses"
          accent
        />
        <Metric
          label="Top category"
          value={byCategory[0]?.label || "None"}
          note={
            byCategory[0]
              ? money(byCategory[0].amount, user.currency)
              : "No expenses yet"
          }
        />
      </section>
      <div className="analytics-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Spending by category</h2>
              <p>Highest spending categories first</p>
            </div>
          </div>
          <BarList
            items={byCategory.map((item) => ({
              ...item,
              percent: totals.expenses
                ? (item.amount / totals.expenses) * 100
                : 0,
            }))}
            currency={user.currency}
          />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Spending by account</h2>
              <p>Where your money is leaving</p>
            </div>
          </div>
          <BarList items={byAccount} currency={user.currency} color="coral" />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Daily spending</h2>
              <p>Largest days in the selected period</p>
            </div>
          </div>
          <BarList items={daily} currency={user.currency} color="yellow" />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Monthly pulse</h2>
              <p>Income, expenses and savings</p>
            </div>
          </div>
          <MonthlyBars user={user} />
        </section>
      </div>
    </div>
  );
}
function MonthlyBars({ user }) {
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date();
    date.setMonth(date.getMonth() - (5 - index), 1);
    const key = monthKey(isoDate(date));
    const monthStart = `${key}-01`;
    const monthEnd = isoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
    const totals = summarize(
      user,
      (user.transactions || []).filter((item) => monthKey(item.date) === key),
      monthStart,
      monthEnd,
    );
    return {
      label: date.toLocaleDateString(undefined, { month: "short" }),
      ...totals,
      savings: totals.balance - totals.expenses,
    };
  });
  const max = Math.max(
    ...months.flatMap((item) => [item.income, item.expenses]),
    1,
  );
  return (
    <div className="monthly-bars">
      {months.map((item) => (
        <div className="month-bar" key={item.label}>
          <div className="bar-pair">
            <i
              className="income-bar"
              style={{ height: `${(item.income / max) * 100}%` }}
            />
            <i
              className="expense-bar"
              style={{ height: `${(item.expenses / max) * 100}%` }}
            />
          </div>
          <strong>{item.label}</strong>
          <small>{money(item.savings, user.currency)}</small>
        </div>
      ))}
    </div>
  );
}
function Reports() {
  const [user] = useUser();
  const [period, setPeriod] = useState("current");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const selected =
    period === "custom"
      ? { start: customStart || today(), end: customEnd || today() }
      : rangeFor(period);
  const items = rangeTransactions(user, selected.start, selected.end);
  const totals = summarize(user, items, selected.start, selected.end);
  const categories = CATEGORIES.map((label) => ({
    label,
    amount: items
      .filter((item) => item.type === "expense" && item.category === label)
      .reduce((sum, item) => sum + Number(item.amount), 0),
  }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  function exportCsv() {
    const rows = [
      ["FinGuard report", `${selected.start} to ${selected.end}`],
      ["Total balance", totals.balance],
      ["Income", totals.income],
      ["Expenses", totals.expenses],
      ["Savings", totals.savings],
      [],
      ["Date", "Type", "Description", "Category", "Account", "Amount"],
      ...items.map((item) => [
        item.date,
        item.type,
        item.name,
        item.category,
        item.accountName || "",
        item.amount,
      ]),
    ];
    const blob = new Blob(
      [
        rows
          .map((row) =>
            row
              .map((value) => `"${String(value).replaceAll('"', '""')}"`)
              .join(","),
          )
          .join("\n"),
      ],
      { type: "text/csv" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `finguard-report-${selected.start}-${selected.end}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="page-content report-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR MONEY, EXPLAINED</p>
          <h1>
            Reports<span>.</span>
          </h1>
          <p className="page-subtitle">
            A clean view of income, expenses, savings and budget performance.
          </p>
        </div>
        <div className="report-actions">
          <button className="secondary-button" onClick={() => window.print()}>
            Print / PDF
          </button>
          <button className="primary-button" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>
      <section className="panel report-controls">
        <label>
          Reporting period
          <select
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          >
            <option value="current">Current month</option>
            <option value="previous">Previous month</option>
            <option value="3months">Last 3 months</option>
            <option value="6months">Last 6 months</option>
            <option value="year">Last year</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {period === "custom" && (
          <>
            <label>
              From
              <input
                type="date"
                value={customStart}
                onChange={(event) => setCustomStart(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
              />
            </label>
          </>
        )}
      </section>
      <section className="report-summary">
        <Metric
          label="Income"
          value={money(totals.income, user.currency)}
          note={`${selected.start} to ${selected.end}`}
        />
        <Metric
          label="Expenses"
          value={money(totals.expenses, user.currency)}
          note={`${items.length} records`}
        />
        <Metric
          label="Savings"
          value={money(totals.balance - totals.expenses, user.currency)}
          note="Total balance minus expenses"
          accent
        />
      </section>
      <div className="report-grid">
        <section className="panel">
          <h2>Categories</h2>
          <BarList items={categories} currency={user.currency} />
        </section>
        <section className="panel">
          <h2>Accounts</h2>
          <BarList
            items={user.accounts
              .map((account) => ({
                label: account.name,
                amount: items
                  .filter(
                    (item) =>
                      item.type === "expense" && item.accountId === account.id,
                  )
                  .reduce((sum, item) => sum + Number(item.amount), 0),
              }))
              .filter((item) => item.amount)}
            currency={user.currency}
            color="coral"
          />
        </section>
        <section className="panel">
          <h2>Budget performance</h2>
          {Object.entries(user.budgets || {}).length ? (
            Object.entries(user.budgets || {}).map(([label, amount]) => {
              const spent =
                label === "overall"
                  ? totals.expenses
                  : categories.find((item) => item.label === label)?.amount ||
                    0;
              return (
                <div className="budget-line" key={label}>
                  <div>
                    <strong>
                      {label === "overall" ? "Overall budget" : label}
                    </strong>
                    <span>
                      {money(spent, user.currency)} of{" "}
                      {money(amount, user.currency)}
                    </span>
                  </div>
                  <div className="progress">
                    <i
                      className={spent > amount ? "over" : ""}
                      style={{
                        width: `${Math.min(100, amount ? (spent / amount) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })
          ) : (
            <Empty text="No budgets configured." />
          )}
        </section>
      </div>
    </div>
  );
}
function Insights() {
  const [user] = useUser();
  const current = rangeTransactions(
    user,
    rangeFor("current").start,
    rangeFor("current").end,
  );
  const previous = rangeTransactions(
    user,
    rangeFor("previous").start,
    rangeFor("previous").end,
  );
  const currentTotals = summarize(user, current, rangeFor("current").start, rangeFor("current").end);
  const previousTotals = summarize(user, previous, rangeFor("previous").start, rangeFor("previous").end);
  const currentCategories = CATEGORIES.map((label) => ({
    label,
    amount: current
      .filter((item) => item.type === "expense" && item.category === label)
      .reduce((sum, item) => sum + Number(item.amount), 0),
  })).filter((item) => item.amount);
  const previousCategories = CATEGORIES.map((label) => ({
    label,
    amount: previous
      .filter((item) => item.type === "expense" && item.category === label)
      .reduce((sum, item) => sum + Number(item.amount), 0),
  }));
  const top = currentCategories.sort((a, b) => b.amount - a.amount)[0];
  const changed = top
    ? previousCategories.find((item) => item.label === top.label)?.amount || 0
    : 0;
  const increase = changed
    ? (((top.amount - changed) / changed) * 100).toFixed(0)
    : null;
  const goal = user.goals?.find((item) => item.saved < item.target);
  const savings = currentTotals.savings;
  const monthsToGoal =
    goal && savings ? Math.ceil((goal.target - goal.saved) / savings) : null;
  const messages = [];
  if (top)
    messages.push({
      tone: "warn",
      title: `${top.label} is your highest expense category`,
      body: `${money(top.amount, user.currency)} spent this month.${increase && increase > 0 ? ` That is ${increase}% higher than last month.` : ""}`,
    });
  if (monthsToGoal)
    messages.push({
      tone: "good",
      title: `You could reach ${goal.name} in about ${monthsToGoal} month${monthsToGoal === 1 ? "" : "s"}`,
      body: "This estimate uses your current monthly savings rate.",
    });
  if (
    currentTotals.expenses > previousTotals.expenses &&
    previousTotals.expenses > 0
  )
    messages.push({
      tone: "note",
      title: "Your spending increased this month",
      body: `${money(currentTotals.expenses - previousTotals.expenses, user.currency)} more than the previous month.`,
    });
  if (!messages.length)
    messages.push({
      tone: "note",
      title: "Your financial picture is ready to learn from",
      body: "Add a few transactions and FinGuard will surface patterns here.",
    });
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">MONEY GUIDANCE</p>
          <h1>
            Insights<span>.</span>
          </h1>
          <p className="page-subtitle">
            Useful observations based on your actual financial behavior.
          </p>
        </div>
      </div>
      <div className="insight-grid">
        {messages.map((message) => (
          <article
            className={`insight-card ${message.tone}`}
            key={message.title}
          >
            <span>
              {message.tone === "good"
                ? "GOAL"
                : message.tone === "warn"
                  ? "WATCH"
                  : "TREND"}
            </span>
            <h2>{message.title}</h2>
            <p>{message.body}</p>
          </article>
        ))}
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>How these insights work</h2>
            <p>
              FinGuard compares your selected month with the previous month and
              tracks progress against your own goals and budgets.
            </p>
          </div>
        </div>
        <div className="insight-facts">
          <strong>
            {money(savings, user.currency)}
            <small>saved this month</small>
          </strong>
          <strong>
            {current.length}
            <small>records analyzed</small>
          </strong>
          <strong>
            {currentCategories.length}
            <small>active categories</small>
          </strong>
        </div>
      </section>
    </div>
  );
}
function RecurringPanel() {
  const [user, refresh] = useUser();
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(today());
  const [frequency, setFrequency] = useState("Monthly");
  function add(event) {
    event.preventDefault();
    if (!name.trim() || !amount || !due) return;
    updateUser((current) => {
      const item = { id: editingId || uid(), name: name.trim(), amount: Number(amount), due, frequency, active: editingId ? current.recurring.find((entry) => entry.id === editingId)?.active !== false : true };
      current.recurring = editingId ? (current.recurring || []).map((entry) => entry.id === editingId ? item : entry) : [...(current.recurring || []), item];
    });
    setName("");
    setAmount("");
    setDue(today());
    setEditingId(null);
    refresh();
  }
  function remove(id) {
    updateUser((current) => {
      current.recurring = (current.recurring || []).filter(
        (item) => item.id !== id,
      );
    });
    refresh();
  }
  function edit(item) {
    setEditingId(item.id);
    setName(item.name);
    setAmount(item.amount);
    setDue(item.due);
    setFrequency(item.frequency);
  }
  function toggle(id) {
    updateUser((current) => { current.recurring = (current.recurring || []).map((item) => item.id === id ? { ...item, active: !item.active } : item); });
    refresh();
  }
  return (
    <section className="panel recurring-panel">
      <div className="panel-heading">
        <div>
          <h2>Recurring payments</h2>
          <p>Track upcoming salary, rent, subscriptions and bills.</p>
        </div>
      </div>
      <form className="recurring-form" onSubmit={add}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Payment name"
        />
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="Amount"
        />
        <input
          type="date"
          value={due}
          onChange={(event) => setDue(event.target.value)}
        />
        <select
          value={frequency}
          onChange={(event) => setFrequency(event.target.value)}
        >
          <option>Weekly</option>
          <option>Monthly</option>
          <option>Yearly</option>
        </select>
        <button className="save-button">{editingId ? "Save reminder" : "Add reminder"}</button>
      </form>
      {(user.recurring || []).length ? (user.recurring || []).map((item) => (
        <div className="recurring-row" key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <span>
              {money(item.amount, user.currency)} - {item.frequency} - {item.active === false ? "Inactive" : "Active"}
            </span>
          </div>
          <span>Next due {item.due}</span>
          <button className="edit-btn" onClick={() => edit(item)}>Edit</button>
          <button className="edit-btn" onClick={() => toggle(item.id)}>{item.active === false ? "Activate" : "Pause"}</button>
          <button className="delete-btn" onClick={() => remove(item.id)}>
            Remove
          </button>
        </div>
      )) : <Empty text="No recurring payments. Add a reminder to keep upcoming bills visible." />}
    </section>
  );
}
function Alerts() {
  const [user] = useUser();
  const expenses = user.transactions.filter(
    (item) =>
      item.type === "expense" && monthKey(item.date) === monthKey(today()),
  );
  const alerts = Object.entries(user.budgets || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([label, amount]) => {
      const spent =
        label === "overall"
          ? expenses.reduce((sum, item) => sum + Number(item.amount), 0)
          : expenses
              .filter((item) => item.category === label)
              .reduce((sum, item) => sum + Number(item.amount), 0);
      const ratio = spent / Number(amount);
      const status =
        ratio >= 1
          ? "exceeded"
          : ratio >= 0.9
            ? "danger"
            : ratio >= 0.75
              ? "warning"
              : "good";
      return {
        label: label === "overall" ? "Overall budget" : label,
        spent,
        amount,
        ratio,
        status,
      };
    });
  const goalAlerts = (user.goals || [])
    .filter((goal) => goal.target > 0)
    .map((goal) => ({
      label: goal.name,
      status: goal.saved / goal.target >= 0.75 ? "good" : "note",
      message: `${Math.round((goal.saved / goal.target) * 100)}% of your goal saved`,
    }));
  const recurringAlerts = (user.recurring || [])
    .filter((item) => item.due <= today())
    .map((item) => ({
      label: item.name,
      status: "warning",
      message: `Recurring ${item.frequency.toLowerCase()} payment due today or overdue: ${money(item.amount, user.currency)}.`,
    }));
  const notices = [
    ...alerts.map((item) => ({
      ...item,
      message:
        item.status === "exceeded"
          ? `You exceeded your ${item.label} budget by ${money(item.spent - item.amount, user.currency)}.`
          : `You have used ${Math.round(item.ratio * 100)}% of your ${item.label} budget.`,
    })),
    ...goalAlerts,
    ...recurringAlerts,
  ];
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">STAY AHEAD</p>
          <h1>
            Alerts<span>.</span>
          </h1>
          <p className="page-subtitle">
            Budget warnings and progress notifications from your workspace.
          </p>
        </div>
      </div>
      <div className="alert-legend">
        <span className="good-dot">Under budget</span>
        <span className="warning-dot">75% used</span>
        <span className="danger-dot">90% used</span>
        <span className="exceeded-dot">Exceeded</span>
      </div>
      <section className="alert-list">
        {notices.length ? (
          notices.map((item) => (
            <article
              className={`alert-card ${item.status}`}
              key={`${item.label}-${item.message}`}
            >
              <span className="alert-symbol">
                {item.status === "good" ? "OK" : "!"}
              </span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.message}</p>
              </div>
              <span className="alert-amount">
                {item.amount ? money(item.spent, user.currency) : "Notice"}
              </span>
            </article>
          ))
        ) : (
          <section className="panel">
            <Empty text="No alerts right now. Add budgets and goals to activate notifications." />
          </section>
        )}
      </section>
      <section className="panel notification-panel">
        <div>
          <h2>Notification center</h2>
          <p>
            Monthly summaries, unusual spending and recurring payment reminders
            appear here as your activity changes.
          </p>
        </div>
        <Link className="primary-button" to="/transactions">
          Review transactions
        </Link>
      </section>
      <RecurringPanel />
    </div>
  );
}

function Profile() {
  const [user, refresh] = useUser();
  const [name, setName] = useState(user.name);
  const [country, setCountry] = useState(user.country);
  const [currency, setCurrency] = useState(user.currency);
  const [monthlyIncome, setMonthlyIncome] = useState(user.monthlyIncome || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [securityMessage, setSecurityMessage] = useState("");
  function save() {
    updateUser((current) => {
      current.name = name.trim() || current.name;
      current.country = country;
      current.currency = currency;
      current.monthlyIncome = Math.max(0, Number(monthlyIncome) || 0);
    });
    refresh();
  }
  async function changePassword(event) {
    event.preventDefault();
    setSecurityMessage("");
    if (!currentPassword) return setSecurityMessage("Please enter your current password.");
    if (!newPassword) return setSecurityMessage("Please enter a new password.");
    if (newPassword !== confirmPassword) return setSecurityMessage("New passwords do not match.");
    if (newPassword.length < 6) return setSecurityMessage("Use a password with at least 6 characters.");
    if (newPassword === currentPassword) return setSecurityMessage("New password must be different from your current password.");
    const { error: reauthenticationError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
    if (reauthenticationError) return setSecurityMessage("Current password is incorrect.");
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) return setSecurityMessage("Unable to change password. Please try again.");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setSecurityMessage("Password changed successfully.");
  }
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR SETTINGS</p>
          <h1>
            Profile<span>.</span>
          </h1>
          <p className="page-subtitle">
            Keep your workspace identity and display preferences current.
          </p>
        </div>
      </div>
      <section className="panel profile-card">
        <div className="profile-intro">
          <span className="avatar large-avatar">{initials(user.name)}</span>
          <div>
            <h2>{user.name}</h2>
            <p>{user.email}</p>
          </div>
        </div>
        <div className="form-grid">
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Country<CountryPicker value={country} onChange={setCountry} /></label>
          <label>
            Primary currency
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              {CURRENCIES.map((item) => (
                <option value={item[0]} key={item[0]}>
                  {item[0]} - {item[2]} ({item[1]})
                </option>
              ))}
            </select>
          </label>
          <label>Monthly income<input type="number" min="0" step="0.01" value={monthlyIncome} onChange={(event) => setMonthlyIncome(event.target.value)} /></label>
        </div>
        <p className="note">
          Changing currency changes display formatting. Existing balances are
          not converted.
        </p>
        <button className="primary-button" onClick={save}>
          Save settings
        </button>
      </section>
      <section className="panel profile-card settings-section">
        <div className="panel-heading"><div><h2>Security</h2><p>Manage access without exposing authentication secrets.</p></div></div>
        <p className="security-status">Email verification: <strong>{currentSession?.user?.email_confirmed_at ? "Verified" : "Not verified"}</strong></p>
        <form className="password-form" onSubmit={changePassword}>
          <label>Current password<input required type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Enter current password" autoComplete="current-password" /></label>
          <label>New password<input required type="password" minLength="6" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Enter new password" autoComplete="new-password" /></label>
          <label>Confirm new password<input required type="password" minLength="6" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter new password again" autoComplete="new-password" /></label>
          <button className="save-button">Change password</button>
        </form>
        {securityMessage && <p className="note">{securityMessage}</p>}
        <div className="settings-theme"><span>Theme preference</span><ThemeToggle /></div>
      </section>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState("");
  useEffect(() => {
    if (!supabase) { setReady(true); return undefined; }
    let active = true;
    let initializing = true;
    const handleSession = async (session) => {
      currentSession = session;
      if (session) await loadUser();
      else {
        currentUser = null;
        notifyUser();
      }
    };
    supabase.auth.getSession().then(async ({ data }) => {
      try {
        currentSession = null;
        currentUser = null;
        notifyUser();
      } catch (error) {
        console.error("Could not initialize the Supabase session", error);
        if (active) setStartupError("We could not load your workspace. Please refresh and try again.");
      } finally {
        initializing = false;
        if (active) setReady(true);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (initializing || event === "INITIAL_SESSION") return;
      try {
        await handleSession(session);
      } catch (error) {
        console.error("Could not load the authenticated FinGuard workspace", error);
      }
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);
  if (!ready) return <div className="auth-page"><div className="auth-card"><Brand /><p>Loading your FinGuard workspace...</p>{startupError && <div className="error-box">{startupError}</div>}</div></div>;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Auth />} />
        <Route path="/signup" element={<Auth signup />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}
export default App;

function DashboardFixed() {
  const [user, refresh] = useUser();
  const [show, setShow] = useState(false);
  const summary = totals(user);
  const health = healthSummary(user);
  const insights = dashboardInsights(user);
  const overallBudget = Number(user.budgets?.overall || 0);
  const overallStatus =
    overallBudget > 0
      ? budgetStatus(summary.expenses, overallBudget, user.currency)
      : null;
  return (
    <div className="page-content dashboard-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">
            {new Date()
              .toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })
              .toUpperCase()}
          </span>
          <h1>
            Good day, {user.name.split(" ")[0]}
            <span>.</span>
          </h1>
          <p>Your financial pulse, calculated from actual recorded activity.</p>
        </div>
        <button
          className="add-transaction-button"
          onClick={() => setShow(true)}
        >
          + Add transaction
        </button>
      </section>
      <section className="metrics-grid">
        <Metric
          label="Total balance"
          value={money(summary.balance, user.currency)}
          note={`Across ${user.accounts.length} account${user.accounts.length === 1 ? "" : "s"}`}
          accent
        />
        <Metric
          label="Income this month"
          value={money(summary.income, user.currency)}
          note="Configured monthly income"
        />
        <Metric
          label="Expenses this month"
          value={money(summary.expenses, user.currency)}
          note={
            overallStatus
              ? `${money(summary.expenses, user.currency)} of ${money(overallBudget, user.currency)} used - ${overallStatus.label}`
              : "Actual expense transactions"
          }
        />
        <Metric
          label="Savings"
          value={money(summary.savings, user.currency)}
          note="Total balance minus expenses"
        />
      </section>
      <div className="dashboard-feature-grid">
        <section className="panel health-card">
          <div className="panel-heading">
            <div><h2>Financial health</h2><p>Calculated from your current budget, balance, goals and activity.</p></div>
            <span className="health-help" title="Budget usage, balance, goal progress, spending consistency, and income versus expenses are combined.">?</span>
          </div>
          <div className="health-content">
            <div className="health-ring" style={{ "--health-progress": `${health.score * 3.6}deg` }}><strong>{health.score}</strong><small>/ 100</small></div>
            <div><strong className="health-label">{health.label}</strong><p>How is this calculated? Your score updates from real activity as your workspace changes.</p></div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>Insights</h2><p>Signals from your actual financial data.</p></div><Link className="quiet-link" to="/insights">View all</Link></div>
          {insights.length ? <div className="dashboard-insights">{insights.slice(0, 3).map((item) => <article className="dashboard-insight" key={item.title}><span>+</span><div><strong>{item.title}</strong><p>{item.body}</p></div></article>)}</div> : <Empty text="Add transactions, budgets, or goals to unlock insights." />}
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Recent activity</h2>
            <p>Income and expenses linked to your accounts</p>
          </div>
          <Link className="quiet-link" to="/transactions">
            View all
          </Link>
        </div>
        {user.transactions.length ? (
          user.transactions
            .slice(0, 6)
            .map((item) => (
              <TransactionRow
                key={item.id}
                transaction={item}
                currency={user.currency}
              />
            ))
        ) : (
          <Empty text="No transactions recorded yet." />
        )}
      </section>
      <div className="dashboard-feature-grid">
        <section className="panel">
          <div className="panel-heading"><div><h2>Budget overview</h2><p>Actual spending against your saved budgets.</p></div><Link className="quiet-link" to="/planning">Manage</Link></div>
          {Object.entries(user.budgets || {}).filter(([, value]) => Number(value) > 0).length ? Object.entries(user.budgets || {}).filter(([, value]) => Number(value) > 0).map(([label, value]) => {
            const spent = label === "overall" ? summary.expenses : (user.transactions || []).filter((item) => item.type === "expense" && item.category === label && monthKey(item.date) === monthKey(today())).reduce((sum, item) => sum + Number(item.amount), 0);
            return <div className="budget-line" key={label}><div><strong>{label === "overall" ? "Overall" : label}</strong><span>{money(spent, user.currency)} of {money(value, user.currency)}</span></div><div className="progress"><i className={spent > Number(value) ? "over" : ""} style={{ width: `${Math.min(100, spent / Number(value) * 100)}%` }} /></div></div>;
          }) : <Empty text="No budgets yet. Set a budget to track utilization." />}
        </section>
        <section className="panel">
          <div className="panel-heading"><div><h2>Goals progress</h2><p>Your active savings targets.</p></div><Link className="quiet-link" to="/planning">Plan</Link></div>
          {(user.goals || []).length ? (user.goals || []).slice(0, 3).map((goal) => { const progress = Number(goal.target) ? Math.min(100, Number(goal.saved || 0) / Number(goal.target) * 100) : 0; return <div className="budget-line" key={goal.id}><div><strong>{goal.name}</strong><span>{money(goal.saved || 0, user.currency)} / {money(goal.target, user.currency)}</span></div><div className="progress"><i style={{ width: `${progress}%` }} /></div><small>{progress.toFixed(0)}% complete</small></div>; }) : <Empty text="No goals yet. Create a savings goal to start planning." />}
        </section>
      </div>
      {show && (
        <TransactionModal
          currency={user.currency}
          accounts={user.accounts}
          goals={user.goals}
          onClose={() => setShow(false)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function AnalyticsFixed() {
  const [user] = useUser();
  const [period, setPeriod] = useState("current");
  const selected = rangeFor(period);
  const items = rangeTransactions(user, selected.start, selected.end);
  const totals = summarize(user, items, selected.start, selected.end);
  const net = totals.savings;
  const expenses = items.filter((item) => item.type === "expense");
  const byCategory = CATEGORIES.map((label) => ({
    label,
    amount: expenses
      .filter((item) => item.category === label)
      .reduce((sum, item) => sum + Number(item.amount), 0),
  }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const byAccount = user.accounts
    .map((account) => ({
      label: account.name,
      amount: expenses
        .filter((item) => item.accountId === account.id)
        .reduce((sum, item) => sum + Number(item.amount), 0),
    }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const budgetRows = Object.entries(user.budgets || {})
    .filter(([, value]) => Number(value) > 0)
    .map(([label, budget]) => {
      const spent =
        label === "overall"
          ? totals.expenses
          : expenses
              .filter((item) => item.category === label)
              .reduce((sum, item) => sum + Number(item.amount), 0);
      return {
        label: label === "overall" ? "Overall budget" : label,
        spent,
        budget,
        status: budgetStatus(spent, budget, user.currency),
      };
    });
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">UNDERSTAND YOUR MONEY</p>
          <h1>
            Analytics<span>.</span>
          </h1>
          <p className="page-subtitle">
            Actual income and expenses for the selected reporting period.
          </p>
        </div>
        <select
          className="period-select"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
        >
          <option value="current">Current month</option>
          <option value="previous">Previous month</option>
          <option value="3months">Last 3 months</option>
          <option value="6months">Last 6 months</option>
          <option value="currentYear">Current year</option>
          <option value="year">Last year</option>
        </select>
      </div>
      <section className="metrics-grid">
        <Metric
          label="Income"
          value={money(totals.income, user.currency)}
          note="Configured monthly income"
        />
        <Metric
          label="Expenses"
          value={money(totals.expenses, user.currency)}
          note={`${expenses.length} expense records`}
        />
        <Metric
          label="Savings"
          value={money(totals.savings, user.currency)}
          note="Total balance minus selected-period expenses"
          accent
        />
        <Metric
          label="Period"
          value={selected.start}
          note={`Through ${selected.end}`}
        />
      </section>
      <div className="analytics-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Spending by category</h2>
              <p>Actual spending in this period</p>
            </div>
          </div>
          <BarList
            items={byCategory.map((item) => ({
              ...item,
              percent: totals.expenses
                ? (item.amount / totals.expenses) * 100
                : 0,
            }))}
            currency={user.currency}
          />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Spending by account</h2>
              <p>Actual account outflows</p>
            </div>
          </div>
          <BarList items={byAccount} currency={user.currency} color="coral" />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Budget performance</h2>
              <p>Same period spending and saved budgets</p>
            </div>
          </div>
          {budgetRows.length ? (
            budgetRows.map((row) => (
              <div className="budget-line" key={row.label}>
                <div>
                  <strong>{row.label}</strong>
                  <span>
                    {money(row.spent, user.currency)} of{" "}
                    {money(row.budget, user.currency)} used
                  </span>
                </div>
                <div className="progress">
                  <i
                    className={row.status.label === "Exceeded" ? "over" : ""}
                    style={{ width: `${Math.min(100, row.status.used)}%` }}
                  />
                </div>
                <small>{row.status.label}</small>
              </div>
            ))
          ) : (
            <Empty text="No budgets configured." />
          )}
        </section>
      </div>
    </div>
  );
}

function AlertsFixed() {
  const [user] = useUser();
  const expenses = user.transactions.filter(
    (item) =>
      item.type === "expense" && monthKey(item.date) === monthKey(today()),
  );
  const alerts = Object.entries(user.budgets || {})
    .filter(([, amount]) => Number(amount) > 0)
    .map(([label, budget]) => {
      const spent =
        label === "overall"
          ? expenses.reduce((sum, item) => sum + Number(item.amount), 0)
          : expenses
              .filter((item) => item.category === label)
              .reduce((sum, item) => sum + Number(item.amount), 0);
      const status = budgetStatus(spent, Number(budget), user.currency);
      return {
        label: label === "overall" ? "Overall budget" : label,
        spent,
        budget: Number(budget),
        ...status,
      };
    });
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">STAY AHEAD</p>
          <h1>
            Alerts<span>.</span>
          </h1>
          <p className="page-subtitle">
            Budget status from this month's actual expense transactions.
          </p>
        </div>
      </div>
      <div className="alert-legend">
        <span className="good-dot">Under budget</span>
        <span className="warning-dot">75% used</span>
        <span className="danger-dot">90% used</span>
        <span className="exceeded-dot">Exceeded</span>
      </div>
      <section className="alert-list">
        {alerts.length ? (
          alerts.map((item) => (
            <article
              className={`alert-card ${item.label === "Exceeded" ? "exceeded" : item.label === "Budget reached" ? "warning" : item.label === "90% used" ? "danger" : "good"}`}
              key={item.label}
            >
              <span className="alert-symbol">!</span>
              <div>
                <strong>{item.label}</strong>
                <p>
                  {item.message.replace(
                    "your budget",
                    `your ${item.label} budget`,
                  )}
                </p>
                <small>
                  {money(item.spent, user.currency)} of{" "}
                  {money(item.budget, user.currency)} used.
                </small>
              </div>
              <span className="alert-amount">{item.label}</span>
            </article>
          ))
        ) : (
          <section className="panel">
            <Empty text="No budgets configured." />
          </section>
        )}
      </section>
    </div>
  );
}

function ReportsPdf() {
  const [user] = useUser();
  const [period, setPeriod] = useState("current");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [pdfError, setPdfError] = useState("");
  const selected =
    period === "custom"
      ? { start: customStart || today(), end: customEnd || today() }
      : rangeFor(period);
  const items = rangeTransactions(user, selected.start, selected.end);
  const totals = summarize(user, items, selected.start, selected.end);
  const categories = CATEGORIES.map((label) => ({
    label,
    amount: items
      .filter((item) => item.type === "expense" && item.category === label)
      .reduce((sum, item) => sum + Number(item.amount), 0),
  }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  function exportPdf() {
    try {
      setPdfError("");
      generateFinancialPdf({ user, items, totals, selected, categories });
    } catch (error) {
      console.error(error);
      setPdfError("The PDF could not be generated. Please try again.");
    }
  }
  function exportCsv() {
    const rows = [
      ["FinGuard report", `${selected.start} to ${selected.end}`],
      ["Total balance", totals.balance],
      ["Income", totals.income],
      ["Expenses", totals.expenses],
      ["Savings", totals.savings],
      [],
      ["Date", "Type", "Description", "Category", "Account", "Amount"],
      ...items.map((item) => [
        item.date,
        item.type,
        item.name,
        item.category,
        item.accountName || "",
        item.amount,
      ]),
    ];
    const blob = new Blob(
      [
        rows
          .map((row) =>
            row
              .map((value) => `"${String(value).replaceAll('"', '""')}"`)
              .join(","),
          )
          .join("\n"),
      ],
      { type: "text/csv" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `finguard-report-${selected.start}-${selected.end}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="page-content report-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR MONEY, EXPLAINED</p>
          <h1>
            Reports<span>.</span>
          </h1>
          <p className="page-subtitle">
            A clean view of income, expenses, savings and budget performance.
          </p>
        </div>
        <div className="report-actions">
          <button className="secondary-button" onClick={() => window.print()}>
            Print / PDF
          </button>
          <button className="secondary-button" onClick={exportPdf}>
            Generate PDF Report
          </button>
          <button className="primary-button" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>
      {pdfError && <div className="error-box report-error">{pdfError}</div>}
      <section className="panel report-controls">
        <label>
          Reporting period
          <select
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
          >
            <option value="current">Current month</option>
            <option value="previous">Previous month</option>
            <option value="3months">Last 3 months</option>
            <option value="6months">Last 6 months</option>
            <option value="year">Current year</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {period === "custom" && (
          <>
            <label>
              From
              <input
                type="date"
                value={customStart}
                onChange={(event) => setCustomStart(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
              />
            </label>
          </>
        )}
      </section>
      <section className="report-summary">
        <Metric
          label="Income"
          value={money(totals.income, user.currency)}
          note={`${selected.start} to ${selected.end}`}
        />
        <Metric
          label="Expenses"
          value={money(totals.expenses, user.currency)}
          note={`${items.length} records`}
        />
        <Metric
          label="Savings"
          value={money(totals.savings, user.currency)}
          note="Total balance minus selected-period expenses"
          accent
        />
      </section>
      <div className="report-grid">
        <section className="panel">
          <h2>Categories</h2>
          <BarList items={categories} currency={user.currency} />
        </section>
        <section className="panel">
          <h2>Accounts</h2>
          <BarList
            items={user.accounts
              .map((account) => ({
                label: account.name,
                amount: items
                  .filter(
                    (item) =>
                      item.type === "expense" && item.accountId === account.id,
                  )
                  .reduce((sum, item) => sum + Number(item.amount), 0),
              }))
              .filter((item) => item.amount)}
            currency={user.currency}
            color="coral"
          />
        </section>
        <section className="panel">
          <h2>Budget performance</h2>
          {Object.entries(user.budgets || {}).length ? (
            Object.entries(user.budgets || {}).map(([label, amount]) => {
              const spent =
                label === "overall"
                  ? totals.expenses
                  : categories.find((item) => item.label === label)?.amount ||
                    0;
              return (
                <div className="budget-line" key={label}>
                  <div>
                    <strong>
                      {label === "overall" ? "Overall budget" : label}
                    </strong>
                    <span>
                      {money(spent, user.currency)} of{" "}
                      {money(amount, user.currency)}
                    </span>
                  </div>
                  <div className="progress">
                    <i
                      className={spent > amount ? "over" : ""}
                      style={{
                        width: `${Math.min(100, amount ? (spent / amount) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })
          ) : (
            <Empty text="No budgets configured." />
          )}
        </section>
      </div>
    </div>
  );
}
