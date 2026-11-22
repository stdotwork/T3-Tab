/*
 * Settings view for the T3-Tab side panel (pushed from Home, with Back).
 * Holds T3 Code sign-in (read-only catalog access) and per-site permissions (ask / read / allow).
 */
import type { T3Access } from '@t3-tab/protocol';

import type { PanelRequest, PanelState } from '../../src/panel';
import { siteChoices, siteStatus } from './prompt-choices';
import type { SitePermission } from '../../src/permissions';
import { icon } from './icons';
import { accessText, el, type PanelActions } from './shared';

export class SettingsView {
  readonly element: HTMLElement;
  readonly heading: HTMLHeadingElement;
  private readonly accessBadge: HTMLSpanElement;
  private readonly accessLine: HTMLParagraphElement;
  private readonly signInBtn: HTMLButtonElement;
  private readonly reloadBtn: HTMLButtonElement;
  private readonly signOutBtn: HTMLButtonElement;
  private readonly accessError: HTMLParagraphElement;
  private readonly sitesCount: HTMLSpanElement;
  private readonly sitesContainer: HTMLDivElement;
  private readonly siteError: HTMLParagraphElement;

  private lastSitesKey = '';

  constructor(private readonly actions: PanelActions) {
    this.element = el('section', 'panel-view pushed');
    this.element.id = 'view-settings';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Settings');

    // Header
    const header = el('header', 'panel-header');
    const left = el('div', 'header-left');
    const backBtn = el('button', 'btn btn-ghost btn-sm');
    backBtn.id = 'btn-settings-back';
    backBtn.type = 'button';
    backBtn.append(icon('arrow-left', 14), document.createTextNode('Back'));
    backBtn.addEventListener('click', () => this.actions.goBack());

    this.heading = el('h1', 'view-title', 'Settings');
    this.heading.tabIndex = -1;
    left.append(backBtn, this.heading);
    header.append(left);

    const scroll = el('div', 'panel-scroll');

    // T3 Code account card
    const accountCard = el('section', 'surface-card');
    accountCard.id = 't3-access';
    const accountTop = el('div', 'card-top');
    this.accessBadge = el('span', 'badge badge-neutral', 'Signed out');
    accountTop.append(el('h2', 'card-title', 'T3 Code account'), this.accessBadge);

    this.accessLine = el('p', 'muted-text', 'Checking T3 Code sign-in…');
    this.accessLine.id = 't3-access-line';

    this.signInBtn = el('button', 'btn btn-primary btn-sm');
    this.signInBtn.id = 't3-sign-in';
    this.signInBtn.type = 'button';
    this.signInBtn.append(icon('log-in', 14), document.createTextNode('Sign in to T3 Code'));

    this.reloadBtn = el('button', 'btn btn-sm');
    this.reloadBtn.id = 't3-reload';
    this.reloadBtn.type = 'button';
    this.reloadBtn.hidden = true;
    this.reloadBtn.append(icon('refresh', 14), document.createTextNode('Reload lists'));

    this.signOutBtn = el('button', 'btn btn-sm');
    this.signOutBtn.id = 't3-sign-out';
    this.signOutBtn.type = 'button';
    this.signOutBtn.hidden = true;
    this.signOutBtn.append(icon('log-out', 14), document.createTextNode('Sign out of T3'));

    const btnRow = el('div', 'btn-row');
    btnRow.append(this.signInBtn, this.reloadBtn, this.signOutBtn);

    this.accessError = el('p', 'error-text');
    accountCard.append(accountTop, this.accessLine, btnRow, this.accessError);

    this.bindAccessAction(this.signInBtn, { type: 'panel.t3SignIn' }, false);
    this.bindAccessAction(this.reloadBtn, { type: 'panel.agents', refresh: true }, true);
    this.bindAccessAction(this.signOutBtn, { type: 'panel.t3SignOut' }, false);

    // Site permissions section
    const sitesSection = el('section', 'section');
    sitesSection.id = 'site-permissions';
    const sitesHeader = el('div', 'section-header');
    this.sitesCount = el('span', 'count-pill', '0');
    sitesHeader.append(el('h2', 'section-title', 'Site permissions'), this.sitesCount);
    this.sitesContainer = el('div');
    this.siteError = el('p', 'error-text');
    sitesSection.append(sitesHeader, this.sitesContainer, this.siteError);

    scroll.append(accountCard, sitesSection);
    this.element.append(header, scroll);
  }

  update(panelState: PanelState | undefined, t3Access: T3Access | undefined): void {
    this.updateAccess(t3Access);
    this.updateSites(panelState);
  }

  private updateAccess(access: T3Access | undefined): void {
    if (access === undefined) {
      this.accessBadge.textContent = 'Unavailable';
      this.accessBadge.className = 'badge badge-neutral';
      this.accessLine.textContent = 'Connect to T3-Tab to manage T3 Code sign-in.';
      this.signInBtn.hidden = true;
      this.reloadBtn.hidden = true;
      this.signOutBtn.hidden = true;
      return;
    }

    if (access.state === 'signed-in') {
      this.accessBadge.textContent = 'Signed in';
      this.accessBadge.className = 'badge badge-success';
    } else if (access.state === 'signing-in') {
      this.accessBadge.textContent = 'Signing in…';
      this.accessBadge.className = 'badge badge-warning';
    } else {
      this.accessBadge.textContent = 'Signed out';
      this.accessBadge.className = 'badge badge-neutral';
    }

    this.accessLine.textContent = accessText(access);
    this.signInBtn.hidden = access.state === 'signed-in';
    const signInLabel = access.state === 'signing-in' ? 'Start the sign-in again' : 'Sign in to T3 Code';
    this.signInBtn.replaceChildren(icon('log-in', 14), document.createTextNode(signInLabel));
    this.reloadBtn.hidden = access.state !== 'signed-in';
    this.signOutBtn.hidden = access.state !== 'signed-in';
  }

  private updateSites(panelState: PanelState | undefined): void {
    const sites = panelState?.sites ?? [];
    const key = JSON.stringify([panelState === undefined, sites]);
    if (key === this.lastSitesKey) return;
    this.lastSitesKey = key;

    this.sitesCount.textContent = String(sites.length);

    if (panelState === undefined) {
      const box = el('div', 'empty-card');
      box.append(el('p', '', 'Loading site permissions…'));
      this.sitesContainer.replaceChildren(box);
      return;
    }

    if (sites.length === 0) {
      const box = el('div', 'empty-card');
      box.append(el('p', '', 'No sites yet. Sites default to ask.'));
      this.sitesContainer.replaceChildren(box);
      return;
    }

    const list = el('ul', 'card-list');
    for (const site of sites) {
      const item = el('li', 'surface-card');
      const top = el('div', 'card-top');
      const badgeTone = site.setting === 'allow' ? 'success' : site.setting === 'read' ? 'accent' : 'neutral';
      const badgeLabel = site.setting === 'allow' ? 'Allow' : site.setting === 'read' ? 'Read' : 'Ask';
      top.append(el('span', 'origin-text', site.origin), el('span', `badge badge-${badgeTone}`, badgeLabel));

      const status = el('p', 'muted-text', siteStatus(site.setting));
      const buttons = el('div', 'btn-row');
      for (const choice of siteChoices(site.setting)) {
        const btn = el('button', 'btn btn-sm', choice.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          void this.setSite(site.origin, choice.setting, btn);
        });
        buttons.append(btn);
      }

      item.append(top, status, buttons);
      list.append(item);
    }
    this.sitesContainer.replaceChildren(list);
  }

  private bindAccessAction(button: HTMLButtonElement, request: PanelRequest, force: boolean): void {
    button.addEventListener('click', () => {
      void (async () => {
        this.accessError.textContent = '';
        button.disabled = true;
        try {
          await this.actions.send(request);
          await this.actions.refreshAgents(force);
        } catch (failure) {
          this.accessError.textContent = failure instanceof Error ? failure.message : String(failure);
        } finally {
          button.disabled = false;
        }
      })();
    });
  }

  private async setSite(origin: string, setting: SitePermission, button: HTMLButtonElement): Promise<void> {
    this.siteError.textContent = '';
    button.disabled = true;
    try {
      await this.actions.send({ type: 'panel.setSite', origin, setting });
      this.actions.announce(`Updated permission for ${origin} to ${setting}.`);
      await this.actions.refreshPanel();
    } catch (failure) {
      this.siteError.textContent = failure instanceof Error ? failure.message : String(failure);
      button.disabled = false;
    }
  }
}
