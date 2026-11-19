import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  RefreshCw,
  UserPlus,
  UserRoundPlus,
  Users,
} from "lucide-react";
import axios from "axios";
import {
  api,
  getApiErrorMessage,
  type ApiResponse,
  type MemberPagination,
  type MembershipStatus,
  type OrganizationMember,
  type OrganizationRole,
  type OrganizationSummary,
} from "../lib/api";

type AddMode = "existing" | "new";

interface MemberListData {
  members: OrganizationMember[];
  pagination: MemberPagination;
}

interface MemberListState extends MemberListData {
  key: string;
  loading: boolean;
  error: string;
}

interface OrganizationMembersProps {
  organization: OrganizationSummary;
  currentUserId: string;
}

const pageSize = 10;

function formatName(name: string | null, email: string): string {
  return name?.trim() || email;
}

function initials(name: string | null, email: string): string {
  const displayName = formatName(name, email);
  const words = displayName.split(/\s+/).filter(Boolean);
  return words.length > 1
    ? `${words[0][0]}${words[1][0]}`.toUpperCase()
    : displayName.slice(0, 2).toUpperCase();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function roleClass(role: OrganizationRole): string {
  return role === "ADMIN"
    ? "bg-violet-50 text-violet-700 ring-violet-600/15"
    : "bg-slate-100 text-slate-700 ring-slate-600/10";
}

function statusClass(status: MembershipStatus): string {
  if (status === "ACTIVE") return "bg-emerald-50 text-emerald-700 ring-emerald-600/15";
  if (status === "SUSPENDED") return "bg-amber-50 text-amber-800 ring-amber-600/15";
  return "bg-slate-100 text-slate-600 ring-slate-500/10";
}

interface MemberActionProps {
  member: OrganizationMember;
  busy: boolean;
  disabledReason: string;
  onChangeStatus: (member: OrganizationMember) => void;
}

function MemberAction({
  member,
  busy,
  disabledReason,
  onChangeStatus,
}: MemberActionProps) {
  if (member.status === "INVITED") {
    return <span className="text-xs text-slate-400">No actions available</span>;
  }

  const suspending = member.status === "ACTIVE";

  return (
    <button
      type="button"
      onClick={() => onChangeStatus(member)}
      disabled={busy || Boolean(disabledReason)}
      title={disabledReason || undefined}
      aria-label={`${suspending ? "Suspend" : "Reactivate"} ${formatName(
        member.name,
        member.email
      )}`}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition focus:outline-none focus:ring-4 disabled:cursor-not-allowed disabled:opacity-50 ${
        suspending
          ? "border-amber-200 bg-white text-amber-800 hover:bg-amber-50 focus:ring-amber-100"
          : "border-emerald-200 bg-white text-emerald-800 hover:bg-emerald-50 focus:ring-emerald-100"
      }`}
    >
      {busy ? (
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      ) : suspending ? (
        <ArrowDown size={14} aria-hidden="true" />
      ) : (
        <ArrowUp size={14} aria-hidden="true" />
      )}
      {suspending ? "Suspend" : "Reactivate"}
    </button>
  );
}

function OrganizationMembers({
  organization,
  currentUserId,
}: OrganizationMembersProps) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<MemberListState | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("existing");
  const [existingEmail, setExistingEmail] = useState("");
  const [existingRole, setExistingRole] = useState<OrganizationRole>("MEMBER");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<OrganizationRole>("MEMBER");
  const [savingMember, setSavingMember] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  const queryKey = `${organization.id}:${page}:${revision}`;
  const currentResult = result?.key === queryKey ? result : null;
  const members = currentResult?.members ?? [];
  const pagination = currentResult?.pagination ?? null;
  const loading = currentResult?.loading ?? true;
  const listError = currentResult?.error ?? "";
  const activeAdminCount = members.filter(
    (member) => member.role === "ADMIN" && member.status === "ACTIVE"
  ).length;
  const listContainsAllMembers =
    pagination !== null && pagination.total === members.length;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    api
      .get<ApiResponse<MemberListData>>(
        `/api/organization/${encodeURIComponent(organization.id)}/members`,
        {
          params: { page, limit: pageSize },
          signal: controller.signal,
        }
      )
      .then(({ data }) => {
        if (!active) return;
        setResult({
          key: queryKey,
          loading: false,
          error: "",
          members: data.data.members,
          pagination: data.data.pagination,
        });
      })
      .catch((error: unknown) => {
        if (!active || axios.isCancel(error)) return;
        setResult({
          key: queryKey,
          loading: false,
          error: getApiErrorMessage(
            error,
            "Unable to load organization members."
          ),
          members: [],
          pagination: { page, limit: pageSize, total: 0, totalPages: 0 },
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [organization.id, page, queryKey]);

  function refreshMembers() {
    setRevision((value) => value + 1);
  }

  function closeForm() {
    setShowAddForm(false);
    setFormError("");
    setExistingEmail("");
    setNewName("");
    setNewEmail("");
    setNewPassword("");
  }

  async function handleAddExisting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setNotice("");
    setSavingMember(true);

    try {
      const { data } = await api.post<ApiResponse<{ member: OrganizationMember }>>(
        `/api/organization/${encodeURIComponent(organization.id)}/members`,
        { email: existingEmail.trim(), role: existingRole }
      );
      setNotice(data.message || "Member added successfully.");
      closeForm();
      refreshMembers();
    } catch (error) {
      setFormError(getApiErrorMessage(error, "Unable to add this user."));
    } finally {
      setSavingMember(false);
    }
  }

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setNotice("");

    if (newName.trim().length < 2) {
      setFormError("Name must contain at least 2 non-whitespace characters.");
      return;
    }

    setSavingMember(true);

    try {
      const { data } = await api.post<ApiResponse<{ member: OrganizationMember }>>(
        `/api/organization/${encodeURIComponent(organization.id)}/members/create`,
        {
          name: newName.trim(),
          email: newEmail.trim(),
          password: newPassword,
          role: newRole,
        }
      );
      setNotice(data.message || "User created and added successfully.");
      closeForm();
      refreshMembers();
    } catch (error) {
      setFormError(getApiErrorMessage(error, "Unable to create this user."));
    } finally {
      setNewPassword("");
      setSavingMember(false);
    }
  }

  async function handleStatusChange(member: OrganizationMember) {
    if (member.userId === currentUserId) {
      setNotice("You cannot change your own organization membership status.");
      return;
    }

    const suspending = member.status === "ACTIVE";
    if (suspending) {
      if (
        member.role === "ADMIN" &&
        listContainsAllMembers &&
        activeAdminCount <= 1
      ) {
        setNotice("The last active organization admin cannot be suspended.");
        return;
      }

      const displayName = formatName(member.name, member.email);
      if (
        !window.confirm(
          `Suspend ${displayName} from ${organization.name}? They will immediately lose access to this organization.`
        )
      ) {
        return;
      }
    }

    setNotice("");
    setFormError("");
    setUpdatingUserId(member.userId);

    try {
      const { data } = await api.patch<ApiResponse<{ member: OrganizationMember }>>(
        `/api/organization/${encodeURIComponent(
          organization.id
        )}/members/${encodeURIComponent(member.userId)}/status`,
        { status: suspending ? "SUSPENDED" : "ACTIVE" }
      );
      setNotice(data.message || "Membership status updated.");
      refreshMembers();
    } catch (error) {
      setFormError(
        getApiErrorMessage(error, "Unable to update this membership.")
      );
    } finally {
      setUpdatingUserId(null);
    }
  }

  function disabledActionReason(member: OrganizationMember): string {
    if (member.userId === currentUserId) {
      return "You cannot change your own membership status.";
    }
    if (
      member.status === "ACTIVE" &&
      member.role === "ADMIN" &&
      listContainsAllMembers &&
      activeAdminCount <= 1
    ) {
      return "The last active organization admin cannot be suspended.";
    }
    return "";
  }

  const totalPages = pagination?.totalPages ?? 0;
  const firstItem = pagination && pagination.total > 0
    ? (page - 1) * pageSize + 1
    : 0;
  const lastItem = pagination
    ? Math.min(page * pageSize, pagination.total)
    : 0;

  return (
    <section className="space-y-6" aria-labelledby="members-heading">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-blue-700">
            <Users size={16} aria-hidden="true" />
            Organization
          </div>
          <h1
            id="members-heading"
            className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl"
          >
            Members
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage who has access to {organization.name}.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshMembers}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:opacity-50"
          >
            <RefreshCw
              size={16}
              aria-hidden="true"
              className={loading ? "animate-spin" : ""}
            />
            Refresh
          </button>
          {organization.role === "ADMIN" && (
            <button
              type="button"
              onClick={() => {
                setShowAddForm((value) => !value);
                setFormError("");
                setNotice("");
              }}
              aria-expanded={showAddForm}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-200"
            >
              <Plus size={17} aria-hidden="true" />
              Add member
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {notice}
        </div>
      )}
      {formError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {formError}
        </div>
      )}

      {showAddForm && organization.role === "ADMIN" && (
        <section
          aria-labelledby="add-member-heading"
          className="rounded-xl border border-blue-100 bg-white p-5 shadow-sm sm:p-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2
                id="add-member-heading"
                className="font-semibold text-slate-900"
              >
                Add to {organization.name}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Add an existing TenantDrive account or create a new one.
              </p>
            </div>
            <div
              className="inline-flex rounded-lg bg-slate-100 p-1"
              aria-label="Choose member creation method"
            >
              <button
                type="button"
                aria-pressed={addMode === "existing"}
                onClick={() => {
                  setAddMode("existing");
                  setFormError("");
                }}
                className={`rounded-md px-3 py-2 text-xs font-semibold transition focus:outline-none focus:ring-4 focus:ring-blue-100 ${
                  addMode === "existing"
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Existing user
              </button>
              <button
                type="button"
                aria-pressed={addMode === "new"}
                onClick={() => {
                  setAddMode("new");
                  setFormError("");
                }}
                className={`rounded-md px-3 py-2 text-xs font-semibold transition focus:outline-none focus:ring-4 focus:ring-blue-100 ${
                  addMode === "new"
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Create user
              </button>
            </div>
          </div>

          {addMode === "existing" ? (
            <form
              onSubmit={handleAddExisting}
              className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
            >
              <div>
                <label
                  htmlFor="existing-member-email"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Email address
                </label>
                <input
                  id="existing-member-email"
                  type="email"
                  autoComplete="off"
                  required
                  maxLength={255}
                  value={existingEmail}
                  onChange={(event) => setExistingEmail(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
                  placeholder="person@company.com"
                />
              </div>
              <div>
                <label
                  htmlFor="existing-member-role"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Organization role
                </label>
                <RoleSelect
                  id="existing-member-role"
                  value={existingRole}
                  onChange={setExistingRole}
                />
              </div>
              <div className="flex items-end gap-2">
                <button
                  type="submit"
                  disabled={savingMember}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-200 disabled:opacity-50"
                >
                  {savingMember ? (
                    <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <UserPlus size={16} aria-hidden="true" />
                  )}
                  Add user
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="min-h-10 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus:ring-4 focus:ring-slate-100"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <form
              onSubmit={handleCreateUser}
              className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
            >
              <div>
                <label
                  htmlFor="new-member-name"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Full name
                </label>
                <input
                  id="new-member-name"
                  type="text"
                  autoComplete="name"
                  required
                  minLength={2}
                  maxLength={100}
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
                  placeholder="Full name"
                />
              </div>
              <div>
                <label
                  htmlFor="new-member-email"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Email address
                </label>
                <input
                  id="new-member-email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={255}
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
                  placeholder="person@company.com"
                />
              </div>
              <div>
                <label
                  htmlFor="new-member-password"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Temporary password
                </label>
                <input
                  id="new-member-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
                  placeholder="At least 12 characters"
                />
              </div>
              <div>
                <label
                  htmlFor="new-member-role"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Organization role
                </label>
                <RoleSelect
                  id="new-member-role"
                  value={newRole}
                  onChange={setNewRole}
                />
              </div>
              <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
                <button
                  type="submit"
                  disabled={savingMember}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-200 disabled:opacity-50"
                >
                  {savingMember ? (
                    <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <UserRoundPlus size={16} aria-hidden="true" />
                  )}
                  Create and add user
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="min-h-10 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-100 focus:outline-none focus:ring-4 focus:ring-slate-100"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <h2 className="font-semibold text-slate-900">Organization members</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {pagination
                ? `${pagination.total} ${
                    pagination.total === 1 ? "person" : "people"
                  } in this organization`
                : "People with access to this organization"}
            </p>
          </div>
          {organization.role === "MEMBER" && (
            <span className="text-xs font-medium text-slate-500">
              View-only access
            </span>
          )}
        </div>

        {loading ? (
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-56 flex-col items-center justify-center gap-3 px-5 text-sm text-slate-500"
          >
            <LoaderCircle
              size={24}
              className="animate-spin text-blue-700"
              aria-hidden="true"
            />
            Loading organization members...
          </div>
        ) : listError ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center">
            <p role="alert" className="text-sm font-medium text-red-700">
              {listError}
            </p>
            <button
              type="button"
              onClick={refreshMembers}
              className="mt-3 rounded-lg px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-4 focus:ring-blue-100"
            >
              Try again
            </button>
          </div>
        ) : members.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-700">
              <Users size={22} aria-hidden="true" />
            </div>
            <h3 className="mt-4 font-semibold text-slate-900">
              No members on this page
            </h3>
            <p className="mt-1 max-w-sm text-sm text-slate-500">
              {pagination && pagination.total > 0
                ? "There are no members on this page. Go back to a previous page."
                : "Add people to give them access to this organization."}
            </p>
            {organization.role === "ADMIN" &&
              (!pagination || pagination.total === 0) && (
                <button
                  type="button"
                  onClick={() => setShowAddForm(true)}
                  className="mt-4 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-200"
                >
                  Add the first member
                </button>
              )}
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-6 py-3.5">Member</th>
                    <th scope="col" className="px-4 py-3.5">Role</th>
                    <th scope="col" className="px-4 py-3.5">Status</th>
                    <th scope="col" className="px-4 py-3.5">Joined</th>
                    {organization.role === "ADMIN" && (
                      <th scope="col" className="px-6 py-3.5 text-right">Actions</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {members.map((member) => (
                    <tr key={member.userId} className="hover:bg-slate-50/70">
                      <td className="px-6 py-4">
                        <MemberIdentity member={member} />
                      </td>
                      <td className="px-4 py-4">
                        <RoleBadge role={member.role} />
                      </td>
                      <td className="px-4 py-4">
                        <StatusBadge status={member.status} />
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-600">
                        {formatDate(member.createdAt)}
                      </td>
                      {organization.role === "ADMIN" && (
                        <td className="px-6 py-4 text-right">
                          <MemberAction
                            member={member}
                            busy={updatingUserId === member.userId}
                            disabledReason={disabledActionReason(member)}
                            onChangeStatus={handleStatusChange}
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-slate-100 md:hidden">
              {members.map((member) => (
                <li key={member.userId} className="space-y-4 p-4">
                  <MemberIdentity member={member} />
                  <div className="flex flex-wrap items-center gap-2">
                    <RoleBadge role={member.role} />
                    <StatusBadge status={member.status} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-slate-500">
                      Joined {formatDate(member.createdAt)}
                    </span>
                    {organization.role === "ADMIN" && (
                      <MemberAction
                        member={member}
                        busy={updatingUserId === member.userId}
                        disabledReason={disabledActionReason(member)}
                        onChangeStatus={handleStatusChange}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {!loading && !listError && pagination && pagination.totalPages > 0 && (
          <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-xs text-slate-500" aria-live="polite">
              Showing {firstItem}–{lastItem} of {pagination.total} members
            </p>
            <nav aria-label="Member list pages" className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft size={16} aria-hidden="true" />
                Previous
              </button>
              <span className="min-w-16 text-center text-xs text-slate-600">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                disabled={page >= totalPages}
                aria-label="Next page"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </nav>
          </div>
        )}
      </div>
    </section>
  );
}

interface RoleSelectProps {
  id: string;
  value: OrganizationRole;
  onChange: (value: OrganizationRole) => void;
}

function RoleSelect({ id, value, onChange }: RoleSelectProps) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => {
        const selectedRole = event.target.value;
        if (selectedRole === "ADMIN" || selectedRole === "MEMBER") {
          onChange(selectedRole);
        }
      }}
      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
    >
      <option value="MEMBER">Member</option>
      <option value="ADMIN">Admin</option>
    </select>
  );
}

function MemberIdentity({ member }: { member: OrganizationMember }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-700"
      >
        {initials(member.name, member.email)}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">
          {formatName(member.name, member.email)}
        </p>
        <p className="truncate text-sm text-slate-500">{member.email}</p>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: OrganizationRole }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${roleClass(
        role
      )}`}
    >
      {role === "ADMIN" ? "Admin" : "Member"}
    </span>
  );
}

function StatusBadge({ status }: { status: MembershipStatus }) {
  const labels: Record<MembershipStatus, string> = {
    ACTIVE: "Active",
    INVITED: "Invited",
    SUSPENDED: "Suspended",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${statusClass(
        status
      )}`}
    >
      {labels[status]}
    </span>
  );
}

export default OrganizationMembers;
