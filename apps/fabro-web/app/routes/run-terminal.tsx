import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import {
  ArrowPathIcon,
  ClipboardDocumentIcon,
} from "@heroicons/react/20/solid";

import { SECONDARY_BUTTON_CLASS } from "../components/ui";
import { useToast } from "../components/toast";
import { apiData, humanInTheLoopApi } from "../lib/api-client";
import { useRunState } from "../lib/queries";

export const handle = { wide: true, fullHeight: true };
export const TERMINAL_DOCK_CLEARANCE_CLASS =
  "pb-[calc(0.5rem+var(--fabro-interview-dock-clearance,0px))]";

type ConnectionStatus = "connecting" | "ready" | "closed" | "error";

interface TerminalServerMessage {
  type: "ready" | "error" | "closed";
  message?: string;
}

const TERMINAL_THEME = {
  background: "#0F1729",
  foreground: "#E8EDF3",
  cursor:     "#67B2D7",
  selectionBackground: "#357F9E66",
  black:   "#0F1729",
  red:     "#E86B6B",
  green:   "#5AC8A8",
  yellow:  "#F0A45B",
  blue:    "#67B2D7",
  magenta: "#A8B5C5",
  cyan:    "#B5DDEF",
  white:   "#F7F9FB",
};

export function buildTerminalWebSocketUrl(location: Location, runId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/v1/runs/${encodeURIComponent(runId)}/terminal`;
}

export function parseTerminalServerMessage(data: string): TerminalServerMessage | null {
  try {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return null;
    const type = (parsed as { type?: unknown }).type;
    if (type !== "ready" && type !== "error" && type !== "closed") return null;
    const message = (parsed as { message?: unknown }).message;
    return {
      type,
      message: typeof message === "string" ? message : undefined,
    };
  } catch {
    return null;
  }
}

function getObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : null;
}

function getString(value: Record<string, unknown> | null, key: string): string | null {
  const child = value?.[key];
  return typeof child === "string" ? child : null;
}

function sendResize(socket: WebSocket | null, fitAddon: XtermFitAddon | null) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !fitAddon) return;
  const proposed = fitAddon.proposeDimensions();
  if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return;
  socket.send(JSON.stringify({
    type: "resize",
    cols: proposed.cols,
    rows: proposed.rows,
  }));
}

function statusClasses(status: ConnectionStatus): string {
  switch (status) {
    case "ready":
      return "bg-teal-500 text-on-primary";
    case "error":
      return "bg-coral/20 text-coral";
    case "closed":
      return "bg-overlay-strong text-fg-3";
    case "connecting":
      return "bg-amber/20 text-amber";
  }
}

function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "ready":
      return "Connected";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
    case "connecting":
      return "Connecting";
  }
}

export default function RunTerminal({ params }: { params: { id: string } }) {
  const { push } = useToast();
  const stateQuery = useRunState(params.id);
  const sandbox = getObject(getObject(stateQuery.data, "run"), "sandbox")
    ?? getObject(stateQuery.data, "sandbox");
  const provider = getString(sandbox, "provider");
  const canCopySsh = provider === "daytona";
  const [connectionKey, setConnectionKey] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const terminalEl = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<XtermFitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalId = useMemo(
    () => `run-terminal-${params.id}`,
    [params.id],
  );

  const reconnect = useCallback(() => {
    setConnectionKey((key) => key + 1);
  }, []);

  const copySshCommand = useCallback(async () => {
    if (!canCopySsh) return;
    try {
      const response = await apiData(() =>
        humanInTheLoopApi.createRunSshAccess(params.id, { ttl_minutes: 60 }),
      );
      await navigator.clipboard.writeText(response.command);
      push({ message: "SSH command copied." });
    } catch (err) {
      push({
        tone: "error",
        message: err instanceof Error ? err.message : "Could not copy SSH command.",
      });
    }
  }, [canCopySsh, params.id, push]);

  useEffect(() => {
    if (!terminalEl.current) return undefined;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const textEncoder = new TextEncoder();
    const disposables: Array<{ dispose: () => void }> = [];

    async function connect() {
      setStatus("connecting");
      setError(null);

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !terminalEl.current) return;

      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: "\"JetBrains Mono\", ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 1.45,
        scrollback: 5000,
        theme: TERMINAL_THEME,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(terminalEl.current);
      fitAddon.fit();
      terminal.focus();
      terminalRef.current = terminal;
      fitRef.current = fitAddon;

      const socket = new WebSocket(buildTerminalWebSocketUrl(window.location, params.id));
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      disposables.push(terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(textEncoder.encode(data));
        }
      }));

      socket.addEventListener("open", () => {
        sendResize(socket, fitAddon);
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          const message = parseTerminalServerMessage(event.data);
          if (!message) return;
          if (message.type === "ready") {
            setStatus("ready");
            return;
          }
          if (message.type === "closed") {
            setStatus("closed");
            return;
          }
          setStatus("error");
          setError(message.message ?? "Terminal session failed.");
          return;
        }
        const bytes = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data;
        terminal.write(bytes);
      });
      socket.addEventListener("close", () => {
        setStatus((current) => current === "error" ? current : "closed");
      });
      socket.addEventListener("error", () => {
        setStatus("error");
        setError("Terminal WebSocket connection failed.");
      });

      resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        sendResize(socket, fitAddon);
      });
      resizeObserver.observe(terminalEl.current);
    }

    void connect();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      for (const disposable of disposables) disposable.dispose();
      socketRef.current?.send(JSON.stringify({ type: "close" }));
      socketRef.current?.close();
      socketRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [connectionKey, params.id]);

  return (
    <main
      className={`flex h-full min-h-0 flex-col ${TERMINAL_DOCK_CLEARANCE_CLASS}`}
      aria-labelledby={terminalId}
    >
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={terminalId} className="text-sm font-semibold text-fg">
            Terminal
          </h2>
          {error ? (
            <p className="mt-1 max-w-3xl text-sm text-coral">{error}</p>
          ) : (
            <p className="mt-1 font-mono text-xs text-fg-muted">
              {provider ? `${provider} sandbox` : "Sandbox terminal"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${statusClasses(status)}`}>
            {statusLabel(status)}
          </span>
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={reconnect}
            aria-label="Reconnect terminal"
          >
            <ArrowPathIcon className="size-4" aria-hidden="true" />
            Reconnect
          </button>
          {canCopySsh && (
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => void copySshCommand()}
              aria-label="Copy SSH command"
            >
              <ClipboardDocumentIcon className="size-4" aria-hidden="true" />
              SSH
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded border border-line bg-page">
        <div ref={terminalEl} className="h-full min-h-0 p-3" />
      </div>
    </main>
  );
}
