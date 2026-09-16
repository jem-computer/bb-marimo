// bb-plugin-marimo — frontend entry.
//
// Two surfaces: a file opener that swaps BB's preview for the embedded marimo
// editor when a .py/.md file is a marimo notebook, and a Marimo page in the
// sidebar that lists projects, their servers, and their notebooks.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { MarimoInfo, ProjectSummary, ServerInfo, ServerMode, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const SERVERS_CHANGED = "servers-changed";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// File opener
// ---------------------------------------------------------------------------

type OpenerState =
  | { kind: "checking" }
  | { kind: "source" }
  | { kind: "error"; message: string }
  | { kind: "notebook"; url: string; server: ServerInfo; relativePath: string };

function ToolbarButton({
  label,
  icon,
  onClick,
  active,
  disabled,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("h-7 gap-1.5 px-2 text-xs", active && "bg-accent text-accent-foreground")}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <Icon name={icon} className="size-3.5" />
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}

function NotebookOpener({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [mode, setMode] = useState<ServerMode>("edit");
  const [showSource, setShowSource] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<OpenerState>({ kind: "checking" });

  const open = useCallback(
    async (nextMode: ServerMode) => {
      setState((previous) => (previous.kind === "notebook" ? previous : { kind: "checking" }));
      try {
        const result = await rpc.call("open", {
          sourceKind: source.kind,
          path,
          environmentId: source.environmentId,
          projectId: source.projectId,
          hostId: source.experimental_hostId ?? null,
          mode: nextMode,
        });
        if (result.kind === "notebook") {
          setState({ kind: "notebook", url: result.url, server: result.server, relativePath: result.relativePath });
        } else if (result.kind === "not-notebook") {
          setState({ kind: "source" });
        } else {
          setState({ kind: "error", message: result.reason });
        }
      } catch (cause) {
        setState({ kind: "error", message: errorMessage(cause) });
      }
    },
    [rpc, path, source.kind, source.environmentId, source.projectId, source.experimental_hostId],
  );

  useEffect(() => {
    void open(mode);
  }, [open, mode]);

  // If the server behind this tab dies, re-open to pick up a fresh one.
  useRealtime(SERVERS_CHANGED, () => {
    if (state.kind !== "notebook") return;
    rpc.call("status").then(
      ({ servers }) => {
        const still = servers.find((server) => server.id === state.server.id);
        if (still === undefined || still.status === "exited") void open(mode);
      },
      () => undefined,
    );
  });

  if (state.kind === "source" || state.kind === "checking") {
    return <Original />;
  }

  if (state.kind === "error") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <Icon name="AlertTriangle" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={state.message}>
            marimo: {state.message}
          </span>
          <ToolbarButton label="Retry" icon="RotateCcw" onClick={() => void open(mode)} />
        </div>
        <div className="min-h-0 flex-1">
          <Original />
        </div>
      </div>
    );
  }

  const { url, server, relativePath } = state;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1">
        <div className="flex items-center rounded-md border border-border p-0.5">
          <ToolbarButton label="Edit" icon="Edit" active={mode === "edit"} onClick={() => setMode("edit")} />
          <ToolbarButton label="App" icon="Play" active={mode === "run"} onClick={() => setMode("run")} />
        </div>
        <span className="ml-2 min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={relativePath}>
          {relativePath}
        </span>
        <ToolbarButton
          label={showSource ? "Notebook" : "Source"}
          icon="Code"
          active={showSource}
          onClick={() => setShowSource((value) => !value)}
        />
        <ToolbarButton label="Reload" icon="ArrowReloadHorizontal" onClick={() => setReloadKey((key) => key + 1)} />
        <ToolbarButton
          label="Restart"
          icon="RotateCcw"
          onClick={() => {
            rpc.call("restart", { id: server.id }).then(
              () => {
                void open(mode);
                toast.success("marimo server restarted");
              },
              (cause) => toast.error(errorMessage(cause)),
            );
          }}
        />
        <ToolbarButton
          label="Browser"
          icon="ExternalLink"
          onClick={() => {
            if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
          }}
        />
      </div>
      <div className="min-h-0 flex-1 bg-background">
        {showSource ? (
          <Original />
        ) : (
          <iframe
            key={`${url}#${reloadKey}`}
            src={url}
            title={`marimo: ${relativePath}`}
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marimo page
// ---------------------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: ServerInfo["status"] | "stopped" }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        status === "running" && "bg-emerald-500",
        status === "starting" && "animate-pulse bg-amber-500",
        (status === "exited" || status === "stopped") && "bg-muted-foreground/40",
      )}
      aria-label={status}
    />
  );
}

function ProjectCard({
  project,
  onChanged,
}: {
  project: ProjectSummary;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [notebooks, setNotebooks] = useState<{ path: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const server = project.server;
  const running = server !== null && server.status === "running";

  useEffect(() => {
    if (!running || server === null) {
      setNotebooks(null);
      return;
    }
    let cancelled = false;
    rpc.call("notebooks", { serverId: server.id }).then(
      ({ notebooks: list }) => {
        if (!cancelled) setNotebooks(list);
      },
      (cause) => {
        if (!cancelled) toast.error(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, running, server]);

  const act = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await work();
      if (success !== undefined) toast.success(success);
      onChanged();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const openNotebook = (notebookPath: string) => {
    if (project.environmentId === null) {
      toast.error("This project has no ready environment to open files in.");
      return;
    }
    const accepted = navigate.experimental_openFilePreview({
      target: { kind: "workspace", environmentId: project.environmentId, path: notebookPath },
      location: null,
    });
    if (!accepted && server !== null) {
      navigate.openUrl(`${server.url}/?file=${encodeURIComponent(notebookPath)}`);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <StatusDot status={server?.status ?? "stopped"} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{project.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={project.root ?? ""}>
            {project.root ?? "no local path"}
            {server !== null ? `  ·  ${server.url}` : ""}
          </div>
        </div>
        {server === null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || project.root === null}
            onClick={() => void act(() => rpc.call("start", { projectId: project.id }), "marimo started")}
          >
            <Icon name="Play" className="size-3.5" />
            Start
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Open in browser"
              disabled={!running}
              onClick={() => navigate.openUrl(server.url)}
            >
              <Icon name="ExternalLink" className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Restart"
              disabled={busy}
              onClick={() => void act(() => rpc.call("restart", { id: server.id }), "marimo restarted")}
            >
              <Icon name="RotateCcw" className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Stop"
              disabled={busy}
              onClick={() => void act(() => rpc.call("stop", { id: server.id }), "marimo stopped")}
            >
              <Icon name="Square" className="size-3.5" />
            </Button>
          </>
        )}
      </div>
      {running ? (
        <div className="border-t border-border px-4 py-2">
          {notebooks === null ? (
            <p className="text-xs text-muted-foreground">Loading notebooks…</p>
          ) : notebooks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No marimo notebooks found under this root. Create one with <code>marimo new</code>.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {notebooks.map((notebook) => (
                <li key={notebook.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 py-1.5 text-left text-sm hover:text-foreground"
                    onClick={() => openNotebook(notebook.path)}
                  >
                    <Icon name="Beaker" className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{notebook.path}</span>
                    <Icon name="ChevronRight" className="size-3.5 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MarimoPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [info, setInfo] = useState<MarimoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    Promise.all([rpc.call("projects"), rpc.call("status")]).then(
      ([projectResult, statusResult]) => {
        setProjects(projectResult.projects);
        setServers(statusResult.servers);
        setError(null);
      },
      (cause) => setError(errorMessage(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(SERVERS_CHANGED, refetch);

  const firstProjectId = projects?.[0]?.id ?? null;
  useEffect(() => {
    rpc.call("marimo_info", { projectId: firstProjectId }).then(setInfo, () => setInfo(null));
  }, [rpc, firstProjectId]);

  const orphanServers = useMemo(() => {
    const projectRoots = new Set((projects ?? []).map((project) => project.root));
    return servers.filter((server) => server.mode === "run" || !projectRoots.has(server.root));
  }, [projects, servers]);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Open a marimo notebook (<code>.py</code> or <code>.md</code>) from any thread to edit it here. Agents use{" "}
            <code>bb marimo</code> and the <code>marimo_*</code> tools.
          </p>
          <Button size="sm" variant="ghost" onClick={refetch} aria-label="Refresh">
            <Icon name="ArrowReloadHorizontal" className="size-3.5" />
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-card px-4 py-2 text-xs">
          {info === null ? (
            <span className="text-muted-foreground">Detecting marimo…</span>
          ) : info.error !== null ? (
            <span className="text-destructive">{info.error}</span>
          ) : (
            <span className="text-muted-foreground">
              marimo v{info.version} via {info.source} · <span className="font-mono">{info.command}</span>
            </span>
          )}
        </div>

        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {projects === null ? (
          <EmptyState>Loading projects…</EmptyState>
        ) : projects.length === 0 ? (
          <EmptyState>No projects yet.</EmptyState>
        ) : (
          <div className="space-y-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onChanged={refetch} />
            ))}
          </div>
        )}

        {orphanServers.length > 0 ? (
          <div>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Other servers</h2>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {orphanServers.map((server) => (
                <li key={server.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <StatusDot status={server.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {server.mode === "run" ? `app ${server.file ?? ""}` : "editor"} · {server.url} · {server.root}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Stop"
                    onClick={() => rpc.call("stop", { id: server.id }).then(refetch, (cause) => toast.error(errorMessage(cause)))}
                  >
                    <Icon name="Square" className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "notebook",
    title: "marimo notebook",
    extensions: ["py", "md"],
    component: NotebookOpener,
  });
  app.slots.navPanel({
    id: "marimo",
    title: "Marimo",
    icon: "Beaker",
    path: "marimo",
    component: MarimoPage,
  });
});
