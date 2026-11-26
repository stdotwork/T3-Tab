/*
 * The browser permission cards, in the one approval card (`Approval.tsx`). Safeguards kept from T3-Tab's permission
 * policy: the answers say exactly what they grant (`promptChoices`), answers stay disabled for 500 ms when a card
 * appears and whenever rows shift (the screen's `ApprovalStack`), cards are keyed so they never swap under the pointer,
 * and a card never takes focus, so no key press meant for the composer can answer it.
 */
import type { ToolSession } from '@t3-tab/protocol';
import type { ReactNode } from 'react';

import type { PermissionPrompt } from '../../src/permissions';
import { ApprovalCard } from './Approval';
import { promptApproval } from './approval-model';
import { panel } from './lib/api';

const showTab = (tabId: number): void => {
  void chrome.tabs
    .update(tabId, { active: true })
    .then(async (tab) => {
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    })
    .catch(() => undefined);
};

/** A browser prompt's id in its screen's `ApprovalStack`. */
export const promptCardId = (promptId: string): string => `prompt:${promptId}`;

export function PromptCards({
  prompts,
  currentTabId,
  askerName,
  onManageSites,
  overlay = false,
}: {
  prompts: PermissionPrompt[];
  currentTabId?: number | undefined;
  askerName?: ((session: ToolSession) => string) | undefined;
  onManageSites?: (() => void) | undefined;
  /** Floats over the screen above the composer instead of taking room from it (the new-thread screen). */
  overlay?: boolean;
}): ReactNode {
  if (prompts.length === 0) return null;
  return (
    <ul className={overlay ? 'prompt-list overlay' : 'prompt-list'} aria-label="Pending permission prompts">
      {prompts.map((prompt) => {
        const tab = prompt.tab;
        const here = currentTabId === undefined || tab === undefined || tab.id === currentTabId;
        return (
          <li key={prompt.id} className="prompt-card" data-prompt-id={prompt.id} data-tab-id={tab?.id}>
            <ApprovalCard
              id={promptCardId(prompt.id)}
              model={promptApproval(prompt, askerName?.(prompt.session) ?? prompt.session.name)}
              presentation="dock"
              onDecide={async (decision) => {
                await panel({ type: 'panel.decide', promptId: prompt.id, decision });
              }}
              onGoToTab={here || tab === undefined ? undefined : () => showTab(tab.id)}
              onManage={onManageSites === undefined ? undefined : { label: 'Manage sites', run: onManageSites }}
              data={{ 'data-here': here ? 'true' : 'false' }}
            />
          </li>
        );
      })}
    </ul>
  );
}
