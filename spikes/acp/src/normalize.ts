// Proposta di mappatura da ACP agli eventi normalizzati di Blue (piano, sezione 4.3).
// Stato minimo per sessione: il messaggio o il ragionamento aperto e le tool call viste.
import type * as acp from "@agentclientprotocol/sdk";

export type BlueEvent = { type: string; payload: Record<string, unknown> };

type Open = { kind: "message" | "reasoning"; messageId?: string | null; text: string };

export class AcpNormalizer {
  private open: Open | null = null;
  private tools = new Map<string, { title?: string; kind?: string | null; status?: string | null }>();
  readonly unknown: string[] = [];

  turnStarted(text: string): BlueEvent[] {
    return [{ type: "turn.started", payload: { input: text } }];
  }

  update(u: acp.SessionUpdate): BlueEvent[] {
    const out: BlueEvent[] = [];
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const kind = u.sessionUpdate === "agent_message_chunk" ? "message" : "reasoning";
        const text = u.content.type === "text" ? u.content.text : `[${u.content.type}]`;
        if (!this.open || this.open.kind !== kind || (u.messageId && u.messageId !== this.open.messageId)) {
          out.push(...this.closeOpen());
          this.open = { kind, messageId: u.messageId, text: "" };
        }
        this.open.text += text;
        out.push({ type: kind === "message" ? "message.delta" : "reasoning.delta", payload: { messageId: u.messageId, text } });
        break;
      }
      case "user_message_chunk":
        // Arriva solo nella ripetizione della storia (session/load).
        out.push(...this.closeOpen());
        out.push({ type: "history.user_message", payload: { content: u.content } });
        break;
      case "tool_call":
        out.push(...this.closeOpen());
        this.tools.set(u.toolCallId, { title: u.title, kind: u.kind, status: u.status });
        out.push({
          type: "tool.started",
          payload: { toolCallId: u.toolCallId, title: u.title, kind: u.kind, status: u.status, locations: u.locations, rawInput: u.rawInput },
        });
        out.push(...this.toolContent(u.toolCallId, u.content, u._meta));
        if (u.status === "completed" || u.status === "failed") out.push(this.toolDone(u.toolCallId, u.status, u.rawOutput));
        break;
      case "tool_call_update": {
        out.push(...this.closeOpen());
        const prev = this.tools.get(u.toolCallId) ?? {};
        this.tools.set(u.toolCallId, { ...prev, title: u.title ?? prev.title, kind: u.kind ?? prev.kind, status: u.status ?? prev.status });
        out.push(...this.toolContent(u.toolCallId, u.content, u._meta));
        if (u.status === "completed" || u.status === "failed") out.push(this.toolDone(u.toolCallId, u.status, u.rawOutput));
        else if (u.status || u.title) out.push({ type: "tool.updated", payload: { toolCallId: u.toolCallId, status: u.status, title: u.title } });
        break;
      }
      case "plan":
        out.push({ type: "plan.updated", payload: { entries: u.entries } });
        break;
      case "usage_update":
        out.push({ type: "usage", payload: { contextUsed: u.used, contextSize: u.size, cost: u.cost } });
        break;
      case "available_commands_update":
        out.push({ type: "commands.updated", payload: { commands: u.availableCommands.map((c) => c.name) } });
        break;
      case "current_mode_update":
        out.push({ type: "config.updated", payload: { modeId: u.currentModeId } });
        break;
      case "config_option_update":
        out.push({ type: "config.updated", payload: { configOptions: u.configOptions.map((o) => [o.id, o.currentValue]) } });
        break;
      case "session_info_update":
        out.push({ type: "session.info", payload: { title: u.title, updatedAt: u.updatedAt } });
        break;
      case "notice":
        out.push({ type: "notice", payload: { severity: u.severity, title: u.title, description: u.description } });
        break;
      default:
        this.unknown.push((u as { sessionUpdate: string }).sessionUpdate);
        out.push({ type: "unknown", payload: { sessionUpdate: (u as { sessionUpdate: string }).sessionUpdate } });
    }
    return out;
  }

  permissionOpened(req: acp.RequestPermissionRequest, requestId: unknown): BlueEvent[] {
    return [
      ...this.closeOpen(),
      {
        type: "request.opened",
        payload: {
          requestId,
          kind: "permission",
          toolCallId: req.toolCall.toolCallId,
          title: req.toolCall.title ?? this.tools.get(req.toolCall.toolCallId)?.title,
          options: req.options.map((o) => ({ id: o.optionId, kind: o.kind, name: o.name })),
        },
      },
    ];
  }

  permissionResolved(requestId: unknown, res: acp.RequestPermissionResponse): BlueEvent[] {
    return [{ type: "request.resolved", payload: { requestId, outcome: res.outcome } }];
  }

  turnEnded(r: { stopReason?: acp.StopReason; error?: { message: string } }): BlueEvent[] {
    const out = this.closeOpen();
    if (r.error) out.push({ type: "turn.failed", payload: { error: r.error.message } });
    else if (r.stopReason === "cancelled") out.push({ type: "turn.completed", payload: { status: "interrupted", stopReason: r.stopReason } });
    else out.push({ type: "turn.completed", payload: { status: r.stopReason === "end_turn" ? "completed" : "stopped", stopReason: r.stopReason } });
    return out;
  }

  private closeOpen(): BlueEvent[] {
    if (!this.open) return [];
    const o = this.open;
    this.open = null;
    return [{ type: o.kind === "message" ? "message.completed" : "reasoning.completed", payload: { messageId: o.messageId, text: o.text } }];
  }

  private toolContent(toolCallId: string, content: acp.ToolCallContent[] | null | undefined, meta: Record<string, unknown> | null | undefined): BlueEvent[] {
    const out: BlueEvent[] = [];
    for (const c of content ?? []) {
      if (c.type === "diff") out.push({ type: "tool.diff", payload: { toolCallId, path: c.path, oldText: c.oldText, newText: c.newText } });
      else if (c.type === "content") out.push({ type: "tool.output", payload: { toolCallId, content: c.content } });
      else if (c.type === "terminal") out.push({ type: "tool.output", payload: { toolCallId, terminalId: c.terminalId } });
    }
    // Output dei comandi fuori standard: alcuni adapter lo mandano in _meta (es. terminal_output_delta).
    for (const [k, v] of Object.entries(meta ?? {})) {
      if (/terminal_output/.test(k)) out.push({ type: "tool.output", payload: { toolCallId, meta: k, value: v } });
    }
    return out;
  }

  private toolDone(toolCallId: string, status: "completed" | "failed", rawOutput: unknown): BlueEvent {
    return { type: "tool.completed", payload: { toolCallId, status, title: this.tools.get(toolCallId)?.title, rawOutput } };
  }
}
