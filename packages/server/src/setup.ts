import { homedir } from 'node:os';

import type { SetupAgent, SetupStatus } from '@t3-tab/protocol';

import type { Agents } from './agents/conversations.js';
import { findExecutable } from './agents/locate.js';
import { findT3Environment } from './agents/t3-environment.js';
import { agentConfigPath, hasAgentServer, installAgent, type Agent } from './install.js';
import type { McpCommand } from './install-config.js';

const SETUP_AGENTS: readonly SetupAgent[] = ['claude', 'codex'];

export interface SetupOptions {
  env: NodeJS.ProcessEnv;
  /** The `t3-tab mcp` command an agent is told to start. */
  server: McpCommand;
  /** T3's state comes from the agents' own probe, which is cached. */
  agents: Pick<Agents, 'status'>;
  /** Where the agent CLIs are looked for; tests pass their own. */
  find?: (name: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

/**
 * What the side panel's first-run steps show and do: which agents can be wired to T3-Tab, and the one-click wiring.
 * Reading the status reads each agent's config file and starts no agent command; only adding one does.
 */
export class Setup {
  private readonly find: NonNullable<SetupOptions['find']>;

  constructor(private readonly options: SetupOptions) {
    this.find = options.find ?? findExecutable;
  }

  async status(refresh = false): Promise<SetupStatus> {
    const { env } = this.options;
    const home = homeOf(env);
    const [agents, t3] = await Promise.all([
      Promise.all(
        SETUP_AGENTS.map(async (id) => ({
          id,
          found: (await this.find(id, env)) !== undefined,
          // A config that cannot be read or parsed has no entry T3-Tab could rely on.
          registered: await hasAgentServer(id, agentConfigPath(id, home, env)).catch(() => false),
        })),
      ),
      this.options.agents.status(refresh).then(async ({ t3: state }): Promise<SetupStatus['t3']> => {
        if (state.state !== 'running') return { state: state.state };
        const environment = await findT3Environment(env);
        return 'origin' in environment ? { state: state.state, origin: environment.origin } : { state: state.state };
      }),
    ]);
    return { agents, t3 };
  }

  /** Registers T3-Tab in one agent's user config, exactly as `t3-tab install --claude|--codex` does; the browser link is left alone. */
  async addAgent(value: unknown): Promise<SetupStatus> {
    if (value !== 'claude' && value !== 'codex') throw new Error('Choose Claude Code or Codex.');
    const agent: Agent = value;
    await installAgent({ agent, home: homeOf(this.options.env), env: this.options.env, server: this.options.server });
    return await this.status();
  }
}

function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim();
  return home === undefined || home === '' ? homedir() : home;
}
