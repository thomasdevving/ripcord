import { createContext, useContext, useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({ plugins: [organizationClient()] });

interface OrganizationSummary { id: string; name: string; slug: string }
interface WorkspaceIdentity {
  user: { id: string; name: string; email: string };
  organization: OrganizationSummary;
  organizations: OrganizationSummary[];
  switchOrganization: (organizationId: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceIdentity | null>(null);

export function useWorkspace(): WorkspaceIdentity {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace context is unavailable");
  return value;
}

const message = (error: unknown, fallback: string): string => {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return fallback;
};

function slugFor(name: string): string {
  const stem = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "workspace";
  return `${stem}-${crypto.randomUUID().slice(0, 8)}`;
}

function AccountScreen({ allowSignup }: { allowSignup: boolean }): ReactElement {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const result = await authClient.signIn.email({ email: email.trim(), password });
        if (result.error) throw new Error(result.error.message ?? "Sign-in failed.");
      } else {
        const result = await authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
        if (result.error) throw new Error(result.error.message ?? "Account creation failed.");
        const created = await authClient.organization.create({ name: organizationName.trim(), slug: slugFor(organizationName) });
        if (created.error) throw new Error(created.error.message ?? "The organization could not be created.");
      }
      window.location.reload();
    } catch (caught) {
      setError(message(caught, mode === "login" ? "Sign-in failed." : "Account creation failed."));
      setBusy(false);
    }
  };

  const signup = mode === "signup";
  const valid = email.includes("@") && password.length >= 12 && (!signup || (name.trim().length >= 2 && organizationName.trim().length >= 2));
  return (
    <main className="auth-page">
      <section className="auth-card card">
        <a className="brand auth-brand" href="/" aria-label="Ripcord home">
          <span className="brand-mark" aria-hidden="true"><img src="/ripcord-mark.png" alt="" /></span>
          <span className="brand-copy"><span className="brand-name">RIPCORD</span><span className="brand-tagline">Private protocol intelligence</span></span>
        </a>
        <p className="section-label">{signup ? "Create your workspace" : "Private workspace"}</p>
        <h1>{signup ? "Start with an organization" : "Sign in to Ripcord"}</h1>
        <p className="note">Protocol definitions, scans and live reports are visible only to members of the active organization.</p>
        {error && <div className="banner warn">{error}</div>}
        <form onSubmit={submit}>
          {signup && <>
            <div className="field"><label htmlFor="account-name">Your name</label><input id="account-name" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={80} /></div>
            <div className="field"><label htmlFor="organization-name">Organization</label><input id="organization-name" type="text" autoComplete="organization" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} required minLength={2} maxLength={80} placeholder="e.g. Treasury risk team" /></div>
          </>}
          <div className="field"><label htmlFor="account-email">Email</label><input id="account-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
          <div className="field"><label htmlFor="account-password">Password</label><input id="account-password" type="password" autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={128} /><span className="field-help">At least 12 characters.</span></div>
          <button className="btn primary auth-submit" type="submit" disabled={!valid || busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
        </form>
        {allowSignup && <button className="link auth-mode" type="button" onClick={() => { setMode(signup ? "login" : "signup"); setError(null); }}>
          {signup ? "Already have an account? Sign in" : "New to Ripcord? Create an account"}
        </button>}
      </section>
    </main>
  );
}

function OrganizationSetup(): ReactElement {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || name.trim().length < 2) return;
    setBusy(true);
    const result = await authClient.organization.create({ name: name.trim(), slug: slugFor(name) });
    if (result.error) { setError(result.error.message ?? "The organization could not be created."); setBusy(false); return; }
    window.location.reload();
  };
  return <main className="auth-page"><section className="auth-card card">
    <p className="section-label">Organization required</p><h1>Create a private workspace</h1>
    <p className="note">Every protocol, scan, job and live report belongs to an organization.</p>
    {error && <div className="banner warn">{error}</div>}
    <form onSubmit={submit}><div className="field"><label htmlFor="new-organization-name">Organization name</label><input id="new-organization-name" type="text" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required /></div><button className="btn primary auth-submit" type="submit" disabled={busy || name.trim().length < 2}>{busy ? "Creating…" : "Create organization"}</button></form>
    <button className="link auth-mode" type="button" onClick={() => void authClient.signOut().then(() => window.location.reload())}>Sign out</button>
  </section></main>;
}

export function AuthGate({ allowSignup, children }: { allowSignup: boolean; children: ReactNode }): ReactElement {
  const session = authClient.useSession();
  const [organizations, setOrganizations] = useState<OrganizationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session.data) { setOrganizations(null); return; }
    authClient.organization.list().then((result) => {
      if (result.error) throw new Error(result.error.message ?? "Organizations could not be loaded.");
      setOrganizations((result.data ?? []).map(({ id, name, slug }) => ({ id, name, slug })));
    }).catch((caught) => setError(message(caught, "Organizations could not be loaded.")));
  }, [session.data?.user.id]);

  if (session.isPending) return <main className="auth-page"><div className="empty">Loading your workspace…</div></main>;
  if (!session.data) return <AccountScreen allowSignup={allowSignup} />;
  if (error) return <main className="auth-page"><div className="banner warn">{error}</div></main>;
  if (organizations === null) return <main className="auth-page"><div className="empty">Loading organizations…</div></main>;
  if (organizations.length === 0) return <OrganizationSetup />;

  const activeId = session.data.session.activeOrganizationId;
  const active = organizations.find((organization) => organization.id === activeId) ?? (organizations.length === 1 ? organizations[0] : null);
  if (!active) {
    return <main className="auth-page"><section className="auth-card card"><p className="section-label">Choose workspace</p><h1>Select an organization</h1><div className="organization-choices">{organizations.map((organization) => <button key={organization.id} className="btn secondary" type="button" onClick={() => void authClient.organization.setActive({ organizationId: organization.id }).then(() => window.location.reload())}>{organization.name}</button>)}</div></section></main>;
  }

  const value: WorkspaceIdentity = {
    user: { id: session.data.user.id, name: session.data.user.name, email: session.data.user.email },
    organization: active,
    organizations,
    switchOrganization: async (organizationId) => {
      const result = await authClient.organization.setActive({ organizationId });
      if (result.error) throw new Error(result.error.message ?? "The organization could not be selected.");
      window.location.reload();
    },
    signOut: async () => { await authClient.signOut(); window.location.reload(); },
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function AccountControls(): ReactElement {
  const workspace = useWorkspace();
  const [copied, setCopied] = useState(false);
  const copyOrganizationId = async () => {
    await navigator.clipboard.writeText(workspace.organization.id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return <div className="account-controls">
    {workspace.organizations.length > 1 ? <select aria-label="Active organization" value={workspace.organization.id} onChange={(event) => void workspace.switchOrganization(event.target.value)}>{workspace.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select> : <span className="organization-name">{workspace.organization.name}</span>}
    <button type="button" className="account-organization-id" title={`Copy organization ID: ${workspace.organization.id}`} onClick={() => void copyOrganizationId()}>{copied ? "Copied" : "Copy ID"}</button>
    <button type="button" className="account-signout" title={`Signed in as ${workspace.user.email}`} onClick={() => void workspace.signOut()}>Sign out</button>
  </div>;
}
