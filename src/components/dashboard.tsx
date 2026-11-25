"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { ThemeProvider } from "@openuidev/dashboard-library";
import { LiveArtifactRenderer, useArtifactRenderer } from "@openuidev/react-ui/cloud";
import { ArrowClockwise, ArrowRight, CircleNotch, Lightning, Warning } from "@phosphor-icons/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { library } from "../library";
import { Notch } from "./notch";
import { withBase } from "../lib/base-path";
import { rememberChat, rememberChatOf } from "./threads";

/** What the renderer streams: a tool call's result, as is, or for a dashboard from the list, its id.
 * `pending` is a create_dashboard call that hasn't returned yet: nothing to stream so far. */
export type DashboardSource = { response: string } | { id: string } | { pending: true };

/** The dashboard in the side panel: the card or list row that opened it, and what to render.
 * `edit` marks an edit_dashboard result, so the panel says it is updating, not building.
 * `rev` counts refreshes: bumping it remounts the panel, which runs its queries again.
 * `mount` is the panel an edit took over: it stays mounted, so the dashboard on screen stays
 * until the new version is ready. */
type Open = DashboardSource & { key: string; edit?: boolean; rev?: number; mount?: string };

const OpenDashboard = createContext<{
  open: Open | null;
  setOpen: (open: Open | null) => void;
  /** The open dashboard's artifact id, once its renderer knows it. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
  /** Bumped when a dashboard finishes generating and is saved, so the lists load it. */
  saved: number;
  onSaved: () => void;
}>({
  open: null,
  setOpen: () => {},
  openId: null,
  setOpenId: () => {},
  saved: 0,
  onSaved: () => {},
});

let openNow: string | null = null;

/** The open dashboard's artifact id, for the chat's requests: "it" in a message means this one. */
export const openDashboardId = () => openNow;

export function OpenDashboardProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [saved, setSaved] = useState(0);
  const onSaved = useCallback(() => setSaved((count) => count + 1), []);
  useEffect(() => {
    openNow = openId;
  }, [openId]);

  // A chat that starts while a dashboard picked from the list is open becomes that dashboard's
  // chat, so picking the dashboard again opens it. A chat gets its id when it sends its first message.
  const chatId = useAuiState((state) => state.threadListItem.remoteId);
  const chatBefore = useRef(chatId);
  useEffect(() => {
    if (chatBefore.current === undefined && chatId && open && "id" in open) {
      rememberChatOf(open.id, chatId);
    }
    chatBefore.current = chatId;
  }, [chatId, open]);
  return (
    <OpenDashboard.Provider value={{ open, setOpen, openId, setOpenId, saved, onSaved }}>
      {children}
    </OpenDashboard.Provider>
  );
}

export const useOpenDashboard = () => useContext(OpenDashboard);

type DashboardToolProps = ToolCallMessagePartProps<
  { title?: string; prompt?: string; id?: string },
  string
>;

/**
 * The card in the chat for a create_dashboard or edit_dashboard call. Its result is OpenUI
 * Cloud's response, which the panel passes to the renderer as is. The tool streams two: the first
 * as soon as the dashboard has an id, and the last one once it's saved or failed, which the open
 * panel gets too. A new dashboard opens beside the chat as soon as the call starts, an edit with
 * its first result.
 */
export function DashboardCard({
  toolName,
  toolCallId,
  args,
  result,
  isError,
  isPreliminary,
  status,
}: DashboardToolProps) {
  const { open, setOpen, openId } = useOpenDashboard();
  const isOpen = open?.key === toolCallId;
  const response = !isError && typeof result === "string" ? result : undefined;
  const edit = toolName === "edit_dashboard";

  // So the dashboard list can open this chat for the dashboard it made.
  const chatId = useAuiState((state) => state.threadListItem.remoteId);
  useEffect(() => {
    if (!edit && response && chatId) rememberChat(response, chatId);
  }, [edit, response, chatId]);

  // Opens once, while you watch: a new dashboard as soon as the call starts, an edit when its
  // result arrives (until then the dashboard on screen says it's updating). Opening another
  // dashboard afterwards sticks. A card that loads with its result, from a chat's history,
  // doesn't open: the panel keeps the dashboard that was picked.
  const running = status?.type === "running";
  const live = useRef(!response);
  const opened = useRef(false);
  const waitingHere = open?.key === toolCallId && "pending" in open;
  useEffect(() => {
    if (!live.current) return;
    if (!opened.current) {
      if (!response && (edit || !running)) return;
      opened.current = true;
      // An edit of the dashboard on screen takes over its panel instead of opening a new one.
      const mount =
        edit && open && openId === args?.id ? { mount: open.mount ?? open.key, rev: open.rev } : {};
      setOpen(
        response ? { key: toolCallId, response, edit, ...mount } : { key: toolCallId, pending: true },
      );
    } else if (waitingHere && (response || !running)) {
      // The call the panel waits on ended. Its result fills the same panel (same key, so no
      // remount); stopped or failed, the panel closes.
      setOpen(response ? { key: toolCallId, response } : null);
    } else if (response && open && isOpen && "response" in open && open.response !== response) {
      // The last result, once the dashboard is saved or failed, goes to the panel only while it
      // shows this card's dashboard.
      setOpen({ ...open, response });
    }
  }, [response, running, edit, waitingHere, isOpen, open, openId, args?.id, toolCallId, setOpen]);

  const title =
    args?.title ?? (toolName === "edit_dashboard" ? "Dashboard change" : "New dashboard");
  const [label, tone]: [string, Tone] = isError
    ? ["Couldn't start", "error"]
    : response
      ? isPreliminary
        ? [toolName === "edit_dashboard" ? "Changing" : "Building", "busy"]
        : [toolName === "edit_dashboard" ? "Changed" : "Ready", "live"]
      : [status?.type === "running" ? "Starting" : "Waiting", "busy"];

  return (
    <div className="group relative my-3 w-full max-w-md">
      <button
        type="button"
        disabled={!response}
        // Opens only: the panel always shows a dashboard, and opening another one replaces it.
        onClick={() => response && !isOpen && setOpen({ key: toolCallId, response, edit })}
        aria-pressed={isOpen}
        title={response && !isOpen ? "Open dashboard" : undefined}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border bg-background py-3 pr-13 pl-4 text-left transition-colors duration-150",
          "hover:border-foreground/12 disabled:cursor-default disabled:hover:border-border",
          isOpen && "cursor-default",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-2.5">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center rounded-md bg-foreground/[0.05] px-1.5 py-0.5">
              Dashboard
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.05] px-1.5 py-0.5">
              <StatusDot tone={tone} />
              {label}
            </span>
          </span>
        </span>
      </button>
      {/* Beside the card, not inside it, so the refresh can be its own button. While this
          dashboard is open it reloads its live data; otherwise it's the card's open arrow. */}
      {response &&
        (isOpen ? (
          <button
            type="button"
            onClick={() => open && setOpen({ ...open, rev: (open.rev ?? 0) + 1 })}
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
            className="absolute top-1/2 right-3 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ArrowClockwise className="size-3.5" />
          </button>
        ) : (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-3 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground transition-colors duration-150 group-hover:text-foreground"
          >
            <ArrowRight className="size-3.5" />
          </span>
        ))}
    </div>
  );
}

/** The open dashboard, full size beside the chat. No header: the dashboard carries its own
 * title, and its top-bar tab (or the chat card) closes it. */
export function DashboardPanel({ edit = false, ...source }: DashboardSource & { edit?: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  // Pending passes neither `response` nor `id`: the renderer shows its Pending slot until the
  // card hands over the call's result.
  const stream = "pending" in source ? {} : source;

  // LiveArtifactRenderer streams the dashboard from OpenUI Cloud and runs its Query() calls
  // through /api/interpreter. `preview={false}` renders it in place, framed by our Chrome. Every
  // renderer of one dashboard shares a stream, and an edit's response tells it a newer version
  // exists. The demo is light only.
  return (
    <ThemeProvider mode="light">
      <LiveArtifactRenderer
        {...stream}
        library={library}
        interpreter={{ url: withBase("/api/interpreter") }}
        preview={false}
        className="h-full"
      >
        <LiveArtifactRenderer.Chrome>
          <div ref={frame} className="relative h-full w-full bg-background">
            <PanelReport />
            <DashboardNotch frame={frame} edit={edit} />
            <LiveArtifactRenderer.Content className="relative h-full overflow-y-auto p-4 sm:p-6">
              <LiveArtifactRenderer.Pending />
              <LiveArtifactRenderer.Error>
                <DashboardError />
              </LiveArtifactRenderer.Error>
            </LiveArtifactRenderer.Content>
          </div>
        </LiveArtifactRenderer.Chrome>
      </LiveArtifactRenderer>
    </ThemeProvider>
  );
}

/**
 * Tells the lists which dashboard is open, by the id the renderer read from its source, and when
 * it finishes generating: OpenUI Cloud saves it then.
 */
function PanelReport() {
  const { id, isStreaming } = useArtifactRenderer();
  const { onSaved, setOpenId } = useOpenDashboard();
  useEffect(() => {
    setOpenId(id);
    return () => setOpenId(null);
  }, [id, setOpenId]);
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) onSaved();
    wasStreaming.current = isStreaming;
  }, [isStreaming, onSaved]);
  return null;
}

type Tone = "live" | "busy" | "error";

function StatusDot({ tone }: { tone: Tone }) {
  return (
    <span className="relative flex size-2">
      {tone === "busy" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-60" />
      )}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          tone === "live" && "bg-emerald-500",
          tone === "busy" && "bg-amber-500",
          tone === "error" && "bg-destructive",
        )}
      />
    </span>
  );
}

/**
 * The panel's status notch. While the dashboard is generated or loads its data it shows
 * progress. When a dashboard generated in this session settles, it measures how many fewer
 * tokens its OpenUI Lang program took than the HTML it rendered to, shows that for a few
 * seconds, then slides away. Opening an existing dashboard just shows loading, then leaves.
 */
function DashboardNotch({
  frame,
  edit,
}: {
  frame: RefObject<HTMLDivElement | null>;
  edit: boolean;
}) {
  const { id, isPending, isStreaming, isLoading } = useArtifactRenderer();
  // While the call that makes the dashboard runs, the Pending loader shows the status.
  const busy = isLoading && !isPending;
  // The agent is calling edit_dashboard right now: the change hasn't been saved yet, so the
  // dashboard on screen is the one being updated.
  const editing = useAuiState(
    (state) =>
      state.thread.isRunning &&
      (state.thread.messages.at(-1)?.content.some(
        (part) =>
          part.type === "tool-call" &&
          part.toolName === "edit_dashboard" &&
          (part.result === undefined || part.isPreliminary === true),
      ) ??
        false),
  );
  const generated = useRef(false);
  const [savings, setSavings] = useState<number | null>(null);
  // True between the dashboard settling and its savings arriving, so the notch stays put
  // instead of leaving and coming back.
  const [measuring, setMeasuring] = useState(false);

  useEffect(() => {
    if (isStreaming) {
      generated.current = true;
      setSavings(null);
    }
  }, [isStreaming]);

  useEffect(() => {
    if (busy || !generated.current || !id) return;
    let cancelled = false;
    let hide = 0;
    setMeasuring(true);
    // Let the last data render settle before reading the DOM.
    const start = window.setTimeout(async () => {
      const root = frame.current?.querySelector(".openui-dashboard");
      if (!root) {
        setMeasuring(false);
        return;
      }
      // Chart internals are collapsed: hand-written HTML would draw charts with a library too.
      const copy = root.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("svg").forEach((svg) => svg.replaceChildren());
      try {
        const response = await fetch(withBase("/api/token-savings"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, html: copy.outerHTML }),
        });
        const result = (await response.json()) as { pct?: number };
        if (cancelled) return;
        setMeasuring(false);
        if (!response.ok || !result.pct) return;
        generated.current = false;
        setSavings(result.pct);
        hide = window.setTimeout(() => setSavings(null), 4000);
      } catch {
        // The savings note is a nicety; a failed measurement just skips it.
        if (!cancelled) setMeasuring(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
      window.clearTimeout(hide);
    };
  }, [busy, id, frame]);

  const working = editing || busy || measuring;
  const label =
    editing || (edit && busy)
      ? "Updating your dashboard…"
      : working
        ? isStreaming
          ? "Building your dashboard…"
          : "Loading live data…"
        : savings !== null
          ? `${savings}% fewer tokens than HTML`
          : "";
  const icon = working ? (
    <CircleNotch className="size-3 animate-spin motion-reduce:animate-none" />
  ) : (
    <Lightning weight="fill" className="size-3" />
  );
  return <Notch show={working || savings !== null} icon={icon} label={label} />;
}

/** Above the dashboard when it fails. The slot shows it only then. */
function DashboardError() {
  const { error, retry } = useArtifactRenderer();
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
    >
      <Warning className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {error?.source === "query"
            ? "Some of this dashboard's data didn't load."
            : "This dashboard couldn't be shown."}
        </p>
        <p className="mt-1 break-words text-muted-foreground">{error?.message}</p>
      </div>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          <ArrowClockwise />
          Try again
        </Button>
      )}
    </div>
  );
}

