"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { ThemeProvider } from "@openuidev/dashboard-library";
import { useArtifactStream } from "@openuidev/react-headless";
import { LiveArtifactRenderer, useArtifactRenderer } from "@openuidev/react-ui/cloud";
import { ArrowClockwise, CircleNotch, Lightning, Warning } from "@phosphor-icons/react";
import { ArrowRightIcon, CheckIcon, RefreshCwIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { library } from "../library";
import { withBase } from "../lib/base-path";
import { reportCall, reportStream, useBuild } from "../lib/build-tracker";
import { BuildFeedCard, BuildFeedPanel, Glyph, buildActive } from "./build-feed";
import { DashboardSkeleton } from "./dashboard-skeleton";
import { Notch } from "./notch";
import { rememberChat, rememberChatOf } from "./threads";

/** What the renderer streams: a tool call's result, as is, or for a dashboard from the list, its id.
 * `pending` is a create_dashboard call that hasn't returned yet: nothing to stream so far. */
export type DashboardSource = { response: string } | { id: string } | { pending: true };

/** The dashboard in the side panel: the card or list row that opened it, and what to render.
 * `edit` marks an edit_dashboard result, so the panel says it is updating, not building.
 * `rev` counts refreshes: bumping it remounts the renderer, which runs its queries again. */
type Open = DashboardSource & { key: string; edit?: boolean; rev?: number };

/** A refresh of the open dashboard's live data: underway, or just done. It never generates anything. */
type Refresh = { key: string; state: "running" | "done"; by?: string };

// Where the open dashboard was scrolled when a refresh was asked for: the renderer remounts to
// run its queries again, and the new one goes back there, so a refresh doesn't move the page.
let scrollBack: number | null = null;

const OpenDashboard = createContext<{
  open: Open | null;
  setOpen: (open: Open | null) => void;
  /** The open dashboard's artifact id, once its renderer knows it. */
  openId: string | null;
  setOpenId: (id: string | null) => void;
  /** Bumped when a dashboard finishes generating and is saved, so the lists load it. */
  saved: number;
  onSaved: () => void;
  refresh: Refresh | null;
  /** Reloads `target`'s live data, opening it first if it isn't the one on screen. `by` is the
   * card that asked, which shows the progress. */
  refreshDashboard: (target: Open, by?: string) => void;
  /** The panel says the reload's queries are back. */
  onRefreshed: () => void;
}>({
  open: null,
  setOpen: () => {},
  openId: null,
  setOpenId: () => {},
  saved: 0,
  onSaved: () => {},
  refresh: null,
  refreshDashboard: () => {},
  onRefreshed: () => {},
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

  const [refresh, setRefresh] = useState<Refresh | null>(null);
  const refreshDashboard = useCallback((target: Open, by?: string) => {
    scrollBack = document.querySelector(".dashboard-content")?.scrollTop ?? null;
    setOpen({ ...target, rev: (target.rev ?? 0) + 1 });
    setRefresh({ key: target.key, state: "running", by });
  }, []);
  const onRefreshed = useCallback(
    () => setRefresh((current) => (current?.state === "running" ? { ...current, state: "done" } : current)),
    [],
  );
  // "Updated" shows for a moment, then the button is itself again.
  useEffect(() => {
    if (refresh?.state !== "done") return;
    const timer = window.setTimeout(() => setRefresh(null), 2400);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  // A refresh belongs to the dashboard it was asked for: opening another one drops it.
  useEffect(() => {
    setRefresh((current) => (current && current.key !== open?.key ? null : current));
  }, [open?.key]);

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
    <OpenDashboard.Provider
      value={{ open, setOpen, openId, setOpenId, saved, onSaved, refresh, refreshDashboard, onRefreshed }}
    >
      {children}
    </OpenDashboard.Provider>
  );
}

export const useOpenDashboard = () => useContext(OpenDashboard);

/** The dashboard a tool result is for, read from the reference line OpenUI Cloud writes. */
function referenceOf(response: string | undefined): { id: string; version?: string } | undefined {
  const id = response?.match(/artifact_id=(art_[A-Za-z0-9_-]+)/)?.[1];
  if (!id) return undefined;
  const version = response?.match(/[?&]version=([^&\s]+)/)?.[1];
  return { id, version: version ? decodeURIComponent(version) : undefined };
}

type DashboardToolProps = ToolCallMessagePartProps<
  { title?: string; prompt?: string; id?: string },
  string
>;

/**
 * The card in the chat for a create_dashboard or edit_dashboard call. The tool streams its
 * results: the first as soon as the dashboard has an id, the last once it's saved or failed. Each
 * is OpenUI Cloud's response, which the panel passes to the renderer as is.
 *
 * The card follows the build on its own, so the chat tells the whole story with the panel closed:
 * Thinking, each tool the build calls by name, Building dashboard, and how it ended. It shares
 * that record with the panel (src/lib/build-tracker.ts), so the two always agree.
 *
 * Two separate actions sit under it. "Open dashboard" shows it beside the chat. "Refresh data"
 * runs the open dashboard's queries again; it never generates anything.
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
  const { open, setOpen, openId, refresh, refreshDashboard } = useOpenDashboard();
  const response = !isError && typeof result === "string" ? result : undefined;
  const edit = toolName === "edit_dashboard";
  const reference = referenceOf(response);
  // An edit names its dashboard in its arguments, before any result.
  const targetId = reference?.id ?? (edit && /^art_[A-Za-z0-9_-]+$/.test(args?.id ?? "") ? args?.id : undefined);
  const running = status?.type === "running";
  /** The tool's last result is in: the build is over. */
  const final = response !== undefined && !isPreliminary;
  // On screen: this card opened the panel, or the panel shows the dashboard this card is for.
  const isOpen = open?.key === toolCallId || (!!targetId && openId === targetId);

  // So the dashboard list can open this chat for the dashboard it made.
  const chatId = useAuiState((state) => state.threadListItem.remoteId);
  useEffect(() => {
    if (!edit && response && chatId) rememberChat(response, chatId);
  }, [edit, response, chatId]);

  // A card that was seen working in this session has a build to follow. One that loads with its
  // result, from a chat's history, doesn't: it's just the dashboard's card.
  const [live] = useState(() => !final && !isError);

  // The tool call's side of the build: it started, it has its dashboard's id, it ended.
  const failure = isError
    ? typeof result === "string"
      ? result
      : "The dashboard couldn't be started."
    : final && /^Couldn['\u2019]t/i.test(response)
      ? response.split("\n")[0]
      : !final && status?.type === "incomplete" && status.reason !== "cancelled"
        ? "The build ended before the dashboard was saved."
        : undefined;
  const outcome = failure ? "failed" : final ? "ready" : !running ? "stopped" : undefined;
  useEffect(() => {
    if (!live) return;
    reportCall(toolCallId, { edit, artifactId: targetId, outcome, error: failure });
  }, [live, toolCallId, edit, targetId, outcome, failure]);

  // The stream's side, read here too so the card needs no panel: every renderer and card of one
  // dashboard shares a single stream. Only while this card's build runs.
  const build = useBuild(toolCallId);
  const following = live && !!reference && !!build && buildActive(build);
  const stream = useArtifactStream({
    id: following ? reference.id : null,
    version: reference?.version,
  });
  const streamError = stream.error && stream.error.code !== "network-error" ? stream.error.message : null;
  useEffect(() => {
    if (!following) return;
    reportStream(reference.id, {
      step: stream.step,
      hasContent: !!stream.program,
      isStreaming: stream.isStreaming,
      error: streamError,
    });
  }, [following, reference?.id, stream.step, !!stream.program, stream.isStreaming, streamError]);

  // Opens once, while you watch: a new dashboard as soon as the call starts, an edit when its
  // first result arrives. Opening another dashboard afterwards sticks. A later result goes to the
  // panel only while it shows this card's dashboard. A card from a chat's history doesn't open:
  // the panel keeps the dashboard that was picked.
  const opened = useRef(false);
  const sent = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!live) return;
    if (!opened.current) {
      if (!response && (edit || !running)) return;
      opened.current = true;
      sent.current = response;
      if (!response) setOpen({ key: toolCallId, pending: true });
      // An edit of the dashboard on screen stays in the same panel, so that dashboard stays readable.
      else if (edit && open && reference && openId === reference.id) {
        setOpen({ key: open.key, rev: open.rev, response, edit: true });
      } else setOpen({ key: toolCallId, response, edit });
    } else if (response && response !== sent.current && isOpen && open) {
      sent.current = response;
      setOpen({ key: open.key, rev: open.rev, response, edit });
    }
  }, [live, response, running, edit, isOpen, open, openId, reference, toolCallId, setOpen]);

  const title = args?.title ?? (edit ? "Dashboard change" : "New dashboard");
  const canOpen = !!response;
  // Refresh reloads live data, so it waits for a dashboard that's built.
  const canRefresh = canOpen && (build ? build.phase === "ready" : true);
  const refreshing =
    isOpen && refresh?.key === open?.key && refresh?.by === toolCallId ? refresh?.state : undefined;
  // Nothing to open or refresh for a build that ended without a dashboard.
  const actions = build ? buildActive(build) || build.phase === "ready" : canOpen || running;

  return (
    <div data-build-card className="my-3 w-full max-w-md overflow-hidden rounded-xl border bg-background">
      <div className="px-4 pt-3.5 pb-3.5">
        <p className="truncate text-sm font-semibold tracking-[-0.005em]" title={title}>
          {title}
        </p>
        <div className="mt-2.5">
          {build ? (
            <BuildFeedCard build={build} />
          ) : (
            // A card from a chat's history: how its call ended, in the feed's words.
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <StatusDot tone={isError ? "error" : response ? "live" : running ? "busy" : "idle"} />
              {isError ? "Couldn't start" : response ? (edit ? "Updated" : "Ready") : running ? "Thinking…" : "Stopped"}
            </span>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex items-center gap-2 border-t bg-foreground/[0.015] px-3 py-2">
          {isOpen ? (
            // This card's dashboard is the one in the panel now; for any other, "Open dashboard".
            <span className="inline-flex h-7 items-center px-1 text-xs text-muted-foreground">Viewing</span>
          ) : (
            <button
              type="button"
              disabled={!canOpen}
              onClick={() => response && setOpen({ key: toolCallId, response, edit })}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition-opacity duration-150 hover:opacity-85 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:opacity-35"
            >
              Open dashboard
              <Glyph icon={ArrowRightIcon} size={12} />
            </button>
          )}
          <button
            type="button"
            disabled={!canRefresh || refreshing === "running"}
            onClick={() => {
              if (!response) return;
              refreshDashboard(isOpen && open ? open : { key: toolCallId, response, edit }, toolCallId);
            }}
            title={
              canRefresh
                ? "Load this dashboard's live data again. Nothing is rebuilt."
                : "Available once the dashboard is ready"
            }
            className="ml-auto inline-flex shrink-0 whitespace-nowrap h-7 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium text-foreground transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default disabled:text-muted-foreground/60 disabled:hover:bg-background"
          >
            {refreshing === "done" ? (
              <Glyph icon={CheckIcon} size={14} className="text-emerald-600 dark:text-emerald-500" />
            ) : (
              <Glyph
                icon={RefreshCwIcon}
                size={14}
                className={cn(refreshing === "running" && "animate-spin motion-reduce:animate-none")}
              />
            )}
            <span aria-live="polite">
              {refreshing === "running" ? "Refreshing…" : refreshing === "done" ? "Updated" : "Refresh data"}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The open dashboard, full size beside the chat. No header: the dashboard carries its own
 * title, and its top-bar tab (or the chat card) closes it. `buildKey` is the tool call that
 * opened it, when one did: the panel shows that build's progress. */
export function DashboardPanel({
  edit = false,
  buildKey,
  ...source
}: DashboardSource & { edit?: boolean; buildKey?: string }) {
  const mode = useColorScheme();
  const frame = useRef<HTMLDivElement>(null);
  // After a refresh, back to where the dashboard was scrolled, once it's tall enough again.
  useEffect(() => {
    const target = scrollBack;
    scrollBack = null;
    if (!target) return;
    let raf = 0;
    let tries = 0;
    const restore = () => {
      const content = frame.current?.querySelector(".dashboard-content");
      if (content) content.scrollTop = target;
      if ((!content || content.scrollTop < target) && ++tries < 90) raf = window.requestAnimationFrame(restore);
    };
    restore();
    return () => window.cancelAnimationFrame(raf);
  }, []);
  // Pending passes neither `response` nor `id`: the renderer is pending until the card hands
  // over the call's first result.
  const stream = "pending" in source ? {} : source;

  // LiveArtifactRenderer streams the dashboard from OpenUI Cloud and runs its Query() calls
  // through /api/interpreter. `preview={false}` renders it in place, framed by our Chrome. Every
  // renderer of one dashboard shares a stream, and an edit's response tells it a newer version
  // exists. The kit's components follow the system's light or dark mode.
  return (
    <ThemeProvider mode={mode}>
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
            <DashboardNotch frame={frame} edit={edit} buildKey={buildKey} />
            <LiveArtifactRenderer.Content className="dashboard-content relative h-full overflow-y-auto p-4 sm:p-6">
              {/* The skeleton and the build's progress are BuildCover, over this area, so the
                  renderer's own loader stays out and nothing here moves when content arrives. */}
              <LiveArtifactRenderer.Pending>
                <span hidden />
              </LiveArtifactRenderer.Pending>
              <LiveArtifactRenderer.Error>
                <DashboardError />
              </LiveArtifactRenderer.Error>
            </LiveArtifactRenderer.Content>
            <BuildCover frame={frame} buildKey={buildKey} />
            <EditFeed buildKey={buildKey} />
          </div>
        </LiveArtifactRenderer.Chrome>
      </LiveArtifactRenderer>
    </ThemeProvider>
  );
}

/**
 * Tells the lists which dashboard is open, by the id the renderer read from its source, and when
 * it finishes generating: OpenUI Cloud saves it then. Reports the dashboard's stream to its build,
 * and tells the card when a refresh's queries are back.
 */
function PanelReport() {
  const { id, isStreaming, isFetching, error } = useArtifactRenderer();
  // The dashboard's stream itself, shared with the renderer: `isPending` can't stand in for
  // "has content", since it's also false in the moment between the tool's result and the stream.
  const stream = useArtifactStream({ id });
  const { onSaved, setOpenId, refresh, onRefreshed } = useOpenDashboard();
  useEffect(() => {
    setOpenId(id);
    return () => setOpenId(null);
  }, [id, setOpenId]);
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) onSaved();
    wasStreaming.current = isStreaming;
  }, [isStreaming, onSaved]);

  // A failed query isn't a failed build; a dropped connection reconnects.
  const failed =
    error && "source" in error && error.source === "artifact" && !("code" in error && error.code === "network-error")
      ? error.message
      : null;
  useEffect(() => {
    if (!id) return;
    reportStream(id, {
      step: stream.step,
      hasContent: !!stream.program,
      isStreaming: stream.isStreaming,
      error: failed,
    });
  }, [id, stream.step, !!stream.program, stream.isStreaming, failed]);

  // A refresh remounted this renderer: its queries run again. Done when they're back, held long
  // enough to be seen; a dashboard with no queries is done after a beat.
  const refreshing = refresh?.state === "running";
  const fetched = useRef(false);
  useEffect(() => {
    if (!refreshing) return;
    if (isFetching) {
      fetched.current = true;
      return;
    }
    const timer = window.setTimeout(onRefreshed, fetched.current ? 500 : 1500);
    return () => window.clearTimeout(timer);
  }, [refreshing, isFetching, onRefreshed]);
  return null;
}

/** Whether the dashboard area has drawn something: a child of real height, not just an empty program. */
function useHasPixels(frame: RefObject<HTMLDivElement | null>, watch: boolean): boolean {
  const [pixels, setPixels] = useState(false);
  useEffect(() => {
    if (!watch) {
      setPixels(false);
      return;
    }
    let raf = 0;
    const check = () => {
      const content = frame.current?.querySelector(".dashboard-content");
      const drawn =
        !!content && Array.from(content.children).some((child) => (child as HTMLElement).offsetHeight >= 48);
      if (drawn) setPixels(true);
      else raf = window.requestAnimationFrame(check);
    };
    check();
    return () => window.cancelAnimationFrame(raf);
  }, [frame, watch]);
  return pixels;
}

const COVER_EXIT_MS = 320;

/**
 * Over the dashboard area until there's a dashboard to show: the skeleton, and on it what the
 * build is doing. It's an overlay, so the area underneath is laid out as it will be and nothing
 * shifts when the content arrives; it leaves, fading, once the content has drawn. A build that
 * was stopped or failed before anything was written stays here and says so.
 */
function BuildCover({
  frame,
  buildKey,
}: {
  frame: RefObject<HTMLDivElement | null>;
  buildKey?: string;
}) {
  const { id, isPending, error } = useArtifactRenderer();
  const stream = useArtifactStream({ id });
  const build = useBuild(buildKey, id);
  const hasContent = !!stream.program;
  // Nothing to show yet: a build that hasn't started writing, or a saved dashboard on its way in.
  const waiting = isPending || (!hasContent && stream.isStreaming);
  // Once it has covered, it holds until the content has drawn: no blank frame in between.
  const [covered, setCovered] = useState(waiting);
  if (waiting && !covered) setCovered(true);
  const pixels = useHasPixels(frame, covered && hasContent);
  // The renderer's own error (a dashboard that can't be loaded) shows in the area underneath.
  const blocked = !!error && "source" in error && error.source === "artifact";
  // With content, until it has drawn. Without any and nothing more coming, only to say how a
  // build ended.
  const show = !blocked && (waiting || (covered && (hasContent ? !pixels : !!build)));

  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true);
  useEffect(() => {
    if (show || !mounted) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setCovered(false);
    }, COVER_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [show, mounted]);
  if (!mounted) return null;

  const over = !!build && !buildActive(build);
  return (
    <div
      data-build-cover
      className={cn(
        "absolute inset-0 z-10 bg-background transition-opacity duration-300 ease-out",
        show ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <DashboardSkeleton still={over} />
      {build && (
        <div className="absolute inset-x-0 top-[22%] z-10 flex justify-center px-4">
          <BuildFeedPanel build={build} className="animate-in fade-in zoom-in-[0.98] duration-300" />
        </div>
      )}
    </div>
  );
}

/**
 * An edit's progress: the dashboard on screen stays as it is, readable and scrollable, and the
 * build's feed floats over its bottom edge until the new version is in.
 */
function EditFeed({ buildKey }: { buildKey?: string }) {
  const { id, isPending } = useArtifactRenderer();
  const build = useBuild(buildKey, id);
  const showing = !!build && build.edit && !isPending;
  const active = showing && buildActive(build);
  // "Updated", "Stopped" or "Couldn't update" stays a moment, then leaves.
  const [lingering, setLingering] = useState(false);
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) {
      setLingering(true);
      const timer = window.setTimeout(() => setLingering(false), build?.phase === "ready" ? 2200 : 6000);
      wasActive.current = active;
      return () => window.clearTimeout(timer);
    }
    wasActive.current = active;
  }, [active, build?.phase]);
  if (!showing || !(active || lingering)) return null;
  return (
    <div data-build-edit-feed className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-4">
      <BuildFeedPanel
        build={build}
        className="pointer-events-auto animate-in fade-in slide-in-from-bottom-2 duration-300"
      />
    </div>
  );
}

type Tone = "live" | "busy" | "error" | "idle";

function StatusDot({ tone }: { tone: Tone }) {
  return (
    <span className="relative flex size-2">
      {tone === "busy" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-60 motion-reduce:animate-none" />
      )}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          tone === "live" && "bg-emerald-500",
          tone === "busy" && "bg-amber-500",
          tone === "error" && "bg-destructive",
          tone === "idle" && "bg-muted-foreground/50",
        )}
      />
    </span>
  );
}

/**
 * The panel's status notch, once there's a dashboard on screen: "Building dashboard…" while it's
 * written, then its live data loading, or a refresh of it. When a dashboard generated in this
 * session settles, it measures how many fewer tokens its OpenUI Lang program took than the HTML
 * it rendered to, shows that for a few seconds, then slides away. Before there's a dashboard the
 * cover says what's happening, and during an edit the feed over the dashboard does.
 */
function DashboardNotch({
  frame,
  edit,
  buildKey,
}: {
  frame: RefObject<HTMLDivElement | null>;
  edit: boolean;
  buildKey?: string;
}) {
  const { id, isPending, isStreaming, isLoading } = useArtifactRenderer();
  const { refresh } = useOpenDashboard();
  const build = useBuild(buildKey, id);
  const editing = !!build && build.edit && buildActive(build);
  // Quiet while the cover or the edit's feed is the status: until the build starts writing, the
  // renderer can't tell a build that's thinking from a dashboard that's loading.
  const quiet = isPending || editing || build?.phase === "thinking";
  const busy = isLoading && !quiet;
  const refreshing = refresh?.state === "running";
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
    if (busy || quiet || !generated.current || !id) return;
    let cancelled = false;
    let hide = 0;
    setMeasuring(true);
    // Let the last data render settle before reading the DOM.
    const start = window.setTimeout(async () => {
      const root = frame.current?.querySelector(".openui-dashboard, .openui-dashboard-root");
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
      // A measurement cut short (an edit starting, say) mustn't leave the notch on.
      setMeasuring(false);
    };
  }, [busy, quiet, id, frame]);

  const working = busy || measuring;
  // "Building" only for a build that's writing right now: a saved dashboard streaming in from
  // OpenUI Cloud is loading, not being built.
  const label = working
    ? build?.phase === "building"
      ? edit
        ? "Updating dashboard…"
        : "Building dashboard…"
      : isStreaming
        ? "Loading dashboard…"
        : refreshing
          ? "Refreshing live data…"
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

const darkQuery = "(prefers-color-scheme: dark)";

function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(darkQuery);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => (window.matchMedia(darkQuery).matches ? "dark" : "light"),
    () => "light",
  );
}
