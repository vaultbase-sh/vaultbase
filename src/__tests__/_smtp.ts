/**
 * Minimal in-process SMTP sink for tests: accepts every message and keeps
 * the raw DATA. Point the `smtp.*` settings at `port` to capture mail.
 */
import type { Socket, TCPSocketListener } from "bun";
import { setSetting } from "../api/settings.ts";
import { invalidateEmailCache } from "../core/email.ts";

export interface SmtpSink {
  port: number;
  messages: string[];
  stop(): void;
  /** Last message whose text contains `needle`. */
  last(needle?: string): string | undefined;
}

export function startSmtpSink(): SmtpSink {
  const messages: string[] = [];
  const state = new WeakMap<Socket<unknown>, { data: boolean; buf: string; msg: string }>();
  const server: TCPSocketListener<unknown> = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        state.set(s, { data: false, buf: "", msg: "" });
        s.write("220 sink ESMTP\r\n");
      },
      data(s, chunk) {
        const st = state.get(s)!;
        st.buf += new TextDecoder().decode(chunk);
        let i: number;
        while ((i = st.buf.indexOf("\r\n")) >= 0) {
          const line = st.buf.slice(0, i);
          st.buf = st.buf.slice(i + 2);
          if (st.data) {
            if (line === ".") {
              st.data = false;
              messages.push(st.msg);
              st.msg = "";
              s.write("250 OK queued\r\n");
            } else {
              st.msg += (line.startsWith("..") ? line.slice(1) : line) + "\n";
            }
            continue;
          }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") s.write("250 sink\r\n");
          else if (cmd === "DATA") { st.data = true; s.write("354 go\r\n"); }
          else if (cmd === "QUIT") { s.write("221 bye\r\n"); s.end(); }
          else s.write("250 OK\r\n");
        }
      },
    },
  });
  setSetting("smtp.enabled", "1");
  setSetting("smtp.host", "127.0.0.1");
  setSetting("smtp.port", String(server.port));
  setSetting("smtp.from", "noreply@test.local");
  invalidateEmailCache();
  return {
    port: server.port,
    messages,
    stop: () => server.stop(true),
    last: (needle) => [...messages].reverse().find((m) => !needle || m.includes(needle)),
  };
}

/** Pull the `token=` value out of a link in a captured message (handles QP soft breaks). */
export function tokenFrom(message: string | undefined): string {
  const flat = (message ?? "").replace(/=\n/g, "").replace(/=3D/g, "=");
  const m = /[?&]token=([0-9a-f]{64})/.exec(flat);
  if (!m) throw new Error(`no token in message:\n${message}`);
  return m[1]!;
}
