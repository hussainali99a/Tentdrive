import { useEffect, useState, type ReactNode } from "react";
import axios from "axios";
import {
  ArrowUpRight,
  Files,
  Folder,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Share2,
  ShieldCheck,
  Users,
} from "lucide-react";
import OrganizationMembers from "./components/OrganizationMembers";
import SignIn from "./components/SignIn";
import {
  api,
  AUTH_EXPIRED_EVENT,
  getAccessToken,
  getApiErrorMessage,
  setAccessToken,
  type ApiResponse,
  type AuthenticatedUser,
  type HealthResponse,
  type OrganizationSummary,
} from "./lib/api";

type AuthState = "checking" | "signedOut" | "signingIn" | "signedIn";
type Page = "overview" | "members";

const selectedOrganizationKey = "tenantdrive.selectedOrganizationId";

function resolveSelectedOrganizationId(
  organizations: OrganizationSummary[]
): string | null {
  const storedId = window.sessionStorage.getItem(selectedOrganizationKey);
  const selectedOrganization =
    organizations.find((organization) => organization.id === storedId) ??
    organizations[0];

  if (selectedOrganization) {
    window.sessionStorage.setItem(
      selectedOrganizationKey,
      selectedOrganization.id
    );
    return selectedOrganization.id;
  }

  window.sessionStorage.removeItem(selectedOrganizationKey);
  return null;
}

function App() {
  const [authState, setAuthState] = useState<AuthState>(() =>
    getAccessToken() ? "checking" : "signedOut"
  );
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<
    string | null
  >(null);
  const [page, setPage] = useState<Page>("overview");
  const [authError, setAuthError] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState("");

  useEffect(() => {
    function handleAuthExpired() {
      setAccessToken(null);
      setUser(null);
      setSelectedOrganizationId(null);
      window.sessionStorage.removeItem(selectedOrganizationKey);
      setPage("overview");
      setAuthError("Your session expired. Please sign in again.");
      setAuthState("signedOut");
    }

    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () =>
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, []);

  useEffect(() => {
    if (!getAccessToken()) return;

    const controller = new AbortController();

    api
      .get<ApiResponse<AuthenticatedUser>>("/api/auth/me", {
        signal: controller.signal,
      })
      .then(({ data }) => {
        setSelectedOrganizationId(
          resolveSelectedOrganizationId(data.data.organizations)
        );
        setUser(data.data);
        setAuthError("");
        setAuthState("signedIn");
      })
      .catch((error: unknown) => {
        if (axios.isCancel(error)) return;
        setUser(null);
        setAuthError(
          getApiErrorMessage(error, "Unable to restore your session.")
        );
        setAuthState("signedOut");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get<HealthResponse>("/health", { signal: controller.signal })
      .then(({ data }) => setHealth(data))
      .catch((error: unknown) => {
        if (!axios.isCancel(error)) setHealthError("Backend unavailable");
      });

    return () => controller.abort();
  }, []);

  async function handleLogin(email: string, password: string): Promise<void> {
    setAuthState("signingIn");
    setAuthError("");

    try {
      const { data } = await api.post<
        ApiResponse<{
          accessToken: string;
          user: Pick<AuthenticatedUser, "id" | "name" | "email">;
          organizations: OrganizationSummary[];
        }>
      >("/api/auth/login", { email, password });

      setAccessToken(data.data.accessToken);
      const nextUser = {
        ...data.data.user,
        organizations: data.data.organizations,
      };
      setSelectedOrganizationId(
        resolveSelectedOrganizationId(nextUser.organizations)
      );
      setUser(nextUser);
      setAuthState("signedIn");
    } catch (error) {
      setAuthError(getApiErrorMessage(error, "Unable to sign in."));
      setAuthState("signedOut");
    }
  }

  function handleLogout() {
    setAccessToken(null);
    window.sessionStorage.removeItem(selectedOrganizationKey);
    setUser(null);
    setSelectedOrganizationId(null);
    setAuthError("");
    setPage("overview");
    setAuthState("signedOut");
  }

  function handleOrganizationChange(organizationId: string) {
    const belongsToUser = user?.organizations.some(
      (organization) => organization.id === organizationId
    );
    if (!belongsToUser) return;

    window.sessionStorage.setItem(selectedOrganizationKey, organizationId);
    setSelectedOrganizationId(organizationId);
  }

  if (authState === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <div role="status" className="flex items-center gap-3 text-sm text-slate-600">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-700 border-r-transparent" />
          Restoring your session...
        </div>
      </main>
    );
  }

  if (!user || authState === "signedOut" || authState === "signingIn") {
    return (
      <SignIn
        busy={authState === "signingIn"}
        error={authError}
        onSubmit={handleLogin}
      />
    );
  }

  const selectedOrganization = user.organizations.find(
    (organization) => organization.id === selectedOrganizationId
  );
  const displayName = user.name?.trim() || user.email;

  return (
    <div className="min-h-screen bg-slate-50 md:flex">
      <aside className="border-b border-slate-200 bg-white md:fixed md:inset-y-0 md:left-0 md:flex md:w-64 md:flex-col md:border-b-0 md:border-r">
        <div className="flex items-center gap-3 px-5 py-4 md:px-6 md:py-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-700 text-white">
            <HardDrive size={21} aria-hidden="true" />
          </div>
          <div>
            <p className="text-lg font-bold tracking-tight text-slate-900">
              TenantDrive
            </p>
            <p className="text-xs text-slate-500">Organization workspace</p>
          </div>
        </div>

        <nav
          aria-label="Main navigation"
          className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-1.5 md:px-4 md:py-5"
        >
          <NavButton
            active={page === "overview"}
            icon={<LayoutDashboard size={18} aria-hidden="true" />}
            onClick={() => setPage("overview")}
          >
            Overview
          </NavButton>
          <NavButton
            active={page === "members"}
            icon={<Users size={18} aria-hidden="true" />}
            onClick={() => setPage("members")}
          >
            Organization
          </NavButton>
        </nav>

        <div className="hidden p-4 md:block">
          <div className="rounded-xl bg-slate-50 p-4">
            <HardDrive size={20} className="text-blue-700" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-slate-800">Storage</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Storage tracking is coming soon.
            </p>
          </div>
          <div className="mt-4 flex items-center gap-3 border-t border-slate-200 pt-4">
            <UserAvatar name={displayName} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-800">
                {displayName}
              </p>
              <p className="truncate text-xs text-slate-500">{user.email}</p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              aria-label="Sign out"
              title="Sign out"
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-4 focus:ring-blue-100"
            >
              <LogOut size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 md:pl-64">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                TenantDrive
              </p>
              <p className="text-sm font-semibold text-slate-800">
                {page === "members" ? "Organization members" : "Workspace overview"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label
                htmlFor="organization-switcher"
                className="text-xs font-medium text-slate-500"
              >
                Organization
              </label>
              <select
                id="organization-switcher"
                value={selectedOrganizationId ?? ""}
                onChange={(event) => handleOrganizationChange(event.target.value)}
                disabled={user.organizations.length === 0}
                className="min-w-0 max-w-[min(65vw,20rem)] rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100 disabled:bg-slate-100"
              >
                {user.organizations.length === 0 ? (
                  <option value="">No organizations</option>
                ) : (
                  user.organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))
                )}
              </select>
              {selectedOrganization && (
                <span
                  className={`hidden rounded-full px-2.5 py-1 text-xs font-semibold sm:inline-flex ${
                    selectedOrganization.role === "ADMIN"
                      ? "bg-violet-50 text-violet-700"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {selectedOrganization.role === "ADMIN" ? "Admin" : "Member"}
                </span>
              )}
              <button
                type="button"
                onClick={handleLogout}
                aria-label="Sign out"
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-4 focus:ring-blue-100 md:hidden"
              >
                <LogOut size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
          {page === "members" ? (
            selectedOrganization ? (
              <OrganizationMembers
                key={selectedOrganization.id}
                organization={selectedOrganization}
                currentUserId={user.id}
              />
            ) : (
              <NoOrganization />
            )
          ) : (
            <Overview
              organization={selectedOrganization}
              health={health}
              healthError={healthError}
              onOpenMembers={() => setPage("members")}
            />
          )}
        </main>
      </div>
    </div>
  );
}

interface NavButtonProps {
  active: boolean;
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}

function NavButton({ active, icon, onClick, children }: NavButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-4 focus:ring-blue-100 md:w-full ${
        active
          ? "bg-blue-50 text-blue-800"
          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function UserAvatar({ name }: { name: string }) {
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = parts.length > 1
    ? `${parts[0][0]}${parts[1][0]}`
    : name.slice(0, 2);

  return (
    <div
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-800"
    >
      {initials.toUpperCase()}
    </div>
  );
}

function NoOrganization() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-6 py-14 text-center shadow-sm">
      <Users size={28} className="mx-auto text-slate-400" aria-hidden="true" />
      <h1 className="mt-4 text-xl font-bold text-slate-900">
        No organization selected
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
        This account does not currently have an active organization membership.
        Ask an organization administrator to add you.
      </p>
    </section>
  );
}

interface OverviewProps {
  organization: OrganizationSummary | undefined;
  health: HealthResponse | null;
  healthError: string;
  onOpenMembers: () => void;
}

function Overview({
  organization,
  health,
  healthError,
  onOpenMembers,
}: OverviewProps) {
  return (
    <div className="space-y-7">
      <section>
        <p className="text-sm font-medium text-blue-700">Workspace</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          {organization
            ? `Welcome to ${organization.name}`
            : "Welcome to TenantDrive"}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
          Your organization’s secure home for files and collaboration.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <OverviewCard
          icon={<Files size={21} aria-hidden="true" />}
          title="My files"
          description="Your organization file workspace."
          disabled
        />
        <OverviewCard
          icon={<Share2 size={21} aria-hidden="true" />}
          title="Shared with me"
          description="Files shared with your account."
          disabled
        />
        <button
          type="button"
          onClick={onOpenMembers}
          className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-blue-200 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-blue-100"
        >
          <div className="flex items-center justify-between">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <Users size={21} aria-hidden="true" />
            </span>
            <ArrowUpRight
              size={17}
              className="text-slate-400 transition group-hover:text-blue-700"
              aria-hidden="true"
            />
          </div>
          <h2 className="mt-4 font-semibold text-slate-900">
            Organization members
          </h2>
          <p className="mt-1 text-sm leading-5 text-slate-500">
            View access, roles, and membership status.
          </p>
        </button>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
            <ShieldCheck size={23} aria-hidden="true" />
          </div>
          <div>
            <h2 className="font-semibold text-slate-900">System status</h2>
            <p className="mt-1 text-sm text-slate-500">
              Backend API: {(health?.status ?? healthError) || "Connecting..."}
            </p>
          </div>
          <span
            className={`sm:ml-auto inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${
              health?.success
                ? "bg-emerald-50 text-emerald-700"
                : healthError
                  ? "bg-red-50 text-red-700"
                  : "bg-slate-100 text-slate-600"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                health?.success
                  ? "bg-emerald-500"
                  : healthError
                    ? "bg-red-500"
                    : "bg-slate-400"
              }`}
            />
            {health?.success ? "Connected" : healthError ? "Unavailable" : "Checking"}
          </span>
        </div>
      </section>
    </div>
  );
}

function OverviewCard({
  icon,
  title,
  description,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <div
      aria-disabled={disabled}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
        {icon}
      </span>
      <h2 className="mt-4 font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-sm leading-5 text-slate-500">{description}</p>
      {disabled && (
        <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-slate-400">
          <Folder size={13} aria-hidden="true" />
          Coming soon
        </span>
      )}
    </div>
  );
}

export default App;
