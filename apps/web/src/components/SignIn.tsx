import { useState, type FormEvent } from "react";
import { ArrowRight, HardDrive, LockKeyhole } from "lucide-react";

interface SignInProps {
  busy: boolean;
  error: string;
  onSubmit: (email: string, password: string) => Promise<void>;
}

function SignIn({ busy, error, onSubmit }: SignInProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      await onSubmit(email.trim(), password);
    } finally {
      setPassword("");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-700 text-white shadow-lg shadow-blue-900/15">
            <HardDrive size={25} aria-hidden="true" />
          </div>
          <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">
            TenantDrive
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Sign in to your organization workspace
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        >
          <h2 className="text-lg font-semibold text-slate-900">Welcome back</h2>
          <p className="mt-1 text-sm text-slate-500">
            Use your TenantDrive account to continue.
          </p>

          {error && (
            <div
              role="alert"
              className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              {error}
            </div>
          )}

          <div className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="signin-email"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Email address
              </label>
              <input
                id="signin-email"
                type="email"
                name="email"
                autoComplete="username"
                required
                maxLength={255}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none transition focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
                placeholder="you@company.com"
              />
            </div>

            <div>
              <label
                htmlFor="signin-password"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Password
              </label>
              <div className="relative">
                <LockKeyhole
                  size={17}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                />
                <input
                  id="signin-password"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 py-2.5 pl-10 pr-3.5 text-sm outline-none transition focus:border-blue-600 focus:ring-4 focus:ring-blue-100"
                  placeholder="Enter your password"
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Signing in..." : "Sign in"}
            {!busy && <ArrowRight size={17} aria-hidden="true" />}
          </button>
        </form>

        <p className="mt-5 text-center text-xs leading-5 text-slate-500">
          Your password is used only to authenticate and is not saved in this
          browser.
        </p>
      </div>
    </main>
  );
}

export default SignIn;
