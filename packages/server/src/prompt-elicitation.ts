import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ControlEvent, ElicitedDecision, PromptNotice } from '@t3-tab/protocol';

import { elicitationMessage, supportsFormElicitation } from './prompt-message.js';

// Longer than a prompt waits in the browser; the prompt closing aborts the question first.
const ELICITATION_TIMEOUT_MS = 10 * 60_000;

/**
 * Puts a permission prompt of this MCP server's own session to the agent's thread as an MCP form with no fields: the
 * client shows its Allow and Decline buttons. The first answer wins, because the side panel decides the same prompt
 * and the browser then tells the daemon it is over, which aborts the question here.
 */
export class ThreadPrompts {
  private readonly asking = new Map<string, AbortController>();

  constructor(
    private readonly server: Pick<Server, 'elicitInput' | 'getClientCapabilities'>,
    private readonly answer: (promptId: string, decision: ElicitedDecision) => Promise<void>,
  ) {}

  handle(event: ControlEvent): void {
    if (event.event === 'prompt.opened') void this.ask(event.prompt);
    else this.asking.get(event.promptId)?.abort();
  }

  private async ask(prompt: PromptNotice): Promise<void> {
    // A client that cannot show a form (or has not said so) is left to the side panel.
    if (!supportsFormElicitation(this.server.getClientCapabilities()?.elicitation) || this.asking.has(prompt.id)) return;
    const controller = new AbortController();
    this.asking.set(prompt.id, controller);
    try {
      const reply = await this.server.elicitInput(
        { message: elicitationMessage(prompt), requestedSchema: { type: 'object', properties: {} } },
        { signal: controller.signal, timeout: ELICITATION_TIMEOUT_MS },
      );
      // `cancel` (what `codex exec` answers on its own) and any failure send nothing: the prompt stays open in the side panel.
      const decision: ElicitedDecision | undefined = reply.action === 'accept' ? 'allow-once' : reply.action === 'decline' ? 'decline' : undefined;
      if (decision !== undefined) await this.answer(prompt.id, decision);
    } catch {
      // Decided elsewhere, timed out, or the client could not ask: nothing to send.
    } finally {
      if (this.asking.get(prompt.id) === controller) this.asking.delete(prompt.id);
    }
  }
}
