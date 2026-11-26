import type { AgentConversation } from '@t3-tab/protocol';
import { Check, FolderPlus, Search } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';

import { Composer, dictateInto, ModelPicker, TabChip, useComposerAttachments } from './Composer';
import { useDictation } from './Dictation';
import { askerName, Banner, bindClaim, TopBar, useCatalog, useNeedsOwner, withdrawClaim, type Screen } from './Frame';
import { PromptCards } from './PromptCards';
import { errorText, panel } from './lib/api';
import { resolveChoice, selectionFor, type Choice } from './lib/catalog';
import { DEFAULT_PROJECT_KEY, NO_PROJECT, pickableProjects, resolveProject } from './lib/new-thread';
import { refreshRunsNow, useShareTargets, useStored, useTabStored, type LiveState } from './lib/store';
import { t3, type Project, type T3State } from './lib/t3-client';
import { ICON, ProjectAvatar, useDismiss, useInkCentre } from './ui';

function ProjectPicker({
  projects,
  value,
  noProject,
  onChange,
}: {
  projects: Project[];
  value: Project | undefined;
  /** T3 can run a thread without a project. */
  noProject: boolean;
  onChange: (id: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  const needle = query.trim().toLowerCase();
  const shown = projects.filter((project) => needle === '' || project.title.toLowerCase().includes(needle) || project.workspaceRoot.toLowerCase().includes(needle));
  const pick = (id: string): void => {
    onChange(id);
    setOpen(false);
  };
  const add = async (): Promise<void> => {
    setError(undefined);
    try {
      pick(await t3.createProject(folder.trim()));
      setAdding(false);
      setFolder('');
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <div className="picker hero-picker" ref={box}>
      {/* T3 names the project in plain text that underlines on hover and while its list is open: no icon or chevron to pull it off centre. */}
      <button type="button" className={value === undefined ? 'inline-picker' : 'inline-picker named'} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {value?.title ?? (noProject ? 'No project' : 'Choose a project')}
      </button>
      {open ? (
        <div className="popover project-popover">
          <label className="model-search">
            <Search size={ICON.md} aria-hidden="true" />
            <input autoFocus placeholder="Search projects…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="project-list" role="listbox" aria-label="Projects">
            {shown.map((project) => (
              <button type="button" role="option" aria-selected={project.id === value?.id} key={project.id} className={project.id === value?.id ? 'model-row active' : 'model-row'} title={project.workspaceRoot} onClick={() => pick(project.id)}>
                <ProjectAvatar name={project.title} />
                <span className="project-name">{project.title}</span>
                {project.id === value?.id ? <Check size={ICON.sm} className="row-check" aria-hidden="true" /> : null}
              </button>
            ))}
            {shown.length === 0 ? <p className="model-note">{needle === '' ? 'No projects yet.' : 'No projects found.'}</p> : null}
          </div>
          {adding ? (
            <form
              className="project-add"
              onSubmit={(event) => {
                event.preventDefault();
                if (folder.trim() !== '') void add();
              }}
            >
              <input autoFocus placeholder="/path/to/folder" value={folder} onChange={(event) => setFolder(event.target.value)} />
              <button type="submit" className="row-btn" disabled={folder.trim() === ''}>
                Add
              </button>
            </form>
          ) : (
            <button type="button" className="model-row add" onClick={() => setAdding(true)}>
              <FolderPlus size={ICON.md} aria-hidden="true" />
              Add project
            </button>
          )}
          {error === undefined ? null : <p className="error-line">{error}</p>}
        </div>
      ) : null}
    </div>
  );
}

function FolderPicker({ value, onChange }: { value: string; onChange: (folder: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  return (
    <div className="picker hero-picker" ref={box}>
      <button
        type="button"
        className="inline-picker"
        aria-expanded={open}
        onClick={() => {
          setDraft(value);
          setOpen(!open);
        }}
      >
        {value === '' ? 'Home folder' : (value.replace(/\/+$/, '').split('/').at(-1) ?? value)}
      </button>
      {open ? (
        <form
          className="popover project-popover project-add"
          onSubmit={(event) => {
            event.preventDefault();
            onChange(draft.trim());
            setOpen(false);
          }}
        >
          <input autoFocus aria-label="Working folder" placeholder="/path/to/folder (blank for home)" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="row-btn">
            Use
          </button>
        </form>
      ) : null}
    </div>
  );
}

export function NewThread({ live, state, onOpen, onNav }: { live: LiveState; state: T3State; onOpen: (screen: Screen) => void; onNav: (screen: Screen) => void }): ReactNode {
  const catalog = useCatalog(live, state);
  const [text, setText] = useTabStored('draft', '');
  const [savedChoice, setSavedChoice] = useStored<Choice | undefined>(`composer.choice.${catalog.source}`, undefined);
  const [defaultProject] = useStored<string>(DEFAULT_PROJECT_KEY, NO_PROJECT);
  const [lastProject, setLastProject] = useStored<string | undefined>('composer.project', undefined);
  const [tabProject, setTabProject] = useTabStored<string | undefined>('project', undefined);
  const [folder, setFolder] = useStored('composer.folder', '');
  const [runtimeMode, setRuntimeMode] = useStored('composer.runtime', 'full-access');
  const [shareTab, setShareTab] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const choice = resolveChoice(catalog.providers, savedChoice);
  const projects = pickableProjects(state.projects, state.scratchRoot);
  const noProject = state.scratchRoot !== undefined;
  const project = resolveProject({ projects, tabChoice: tabProject, defaultProject, lastProject, noProjectAvailable: noProject });
  const provider = catalog.providers.find((entry) => entry.id === choice?.provider);
  const tab = live.currentTab;
  const shareable = tab !== undefined && /^https?:/.test(tab.url);
  const targets = useShareTargets(tab, live.changes);
  const needsYou = useNeedsOwner(live, state);
  const latestText = useRef(text);
  latestText.current = text;
  const hero = useInkCentre<HTMLDivElement>();
  const target = useMemo(() => (catalog.source === 't3' ? ({ kind: 't3' } as const) : ({ kind: 'direct', agent: provider?.name ?? 'this agent' } as const)), [catalog.source, provider?.name]);
  const attachments = useComposerAttachments(target);
  const dictation = useDictation(state, (spoken) => setText(dictateInto(latestText.current, spoken)), setNotice);
  // A direct agent has only the browser tools, so it is asked about the page rather than about building something.
  // T3 asks what to work on while no project is chosen, and what to build once one is.
  const heading = catalog.source === 't3' ? (project === undefined ? 'What should we work on?' : 'What should we build?') : !shareable || !shareTab ? 'What should we do?' : targets.tabs.length > 1 ? 'What should we do in these tabs?' : 'What should we do in this tab?';
  const chooseProject = (id: string): void => {
    setTabProject(id);
    if (id !== NO_PROJECT) setLastProject(id);
  };

  const send = async (): Promise<void> => {
    if (choice === undefined) return;
    setBusy(true);
    setError(undefined);
    const message = text.trim();
    try {
      if (catalog.source === 't3') {
        const projectId = project?.id ?? (noProject ? await t3.ensureScratchProject() : undefined);
        if (projectId === undefined) throw new Error('Choose a project first.');
        let code: string | undefined;
        let note = '';
        if (shareTab && shareable) {
          const claim = await panel<{ code: string; note: string }>({ type: 'panel.t3Claim', tabId: tab.id });
          code = claim.code;
          note = claim.note;
        }
        let threadId: string;
        let uploaded: Awaited<ReturnType<typeof attachments.forT3>> = [];
        try {
          uploaded = await attachments.forT3();
          threadId = await t3.launchThread({ projectId, model: selectionFor(choice), runtimeMode, text: `${message}${note}`, attachments: uploaded });
        } catch (failure) {
          for (const attachment of uploaded) await t3.discardAttachment(attachment.id);
          if (code !== undefined) await withdrawClaim(code);
          throw failure;
        }
        if (code !== undefined) await bindClaim(code, threadId);
        setText('');
        attachments.clear();
        onOpen({ name: 'thread', id: threadId, source: 't3' });
      } else {
        const images = await attachments.forDirect();
        const { conversation } = await panel<{ conversation: AgentConversation }>({
          type: 'panel.agentStart',
          via: choice.provider,
          message,
          ...(folder === '' ? {} : { project: folder }),
          ...(choice.model === '' ? {} : { model: choice.model }),
          ...(tab === undefined ? {} : { tabId: tab.id }),
          ...(shareTab && shareable ? {} : { noTabs: true }),
          ...(images.length === 0 ? {} : { images }),
        });
        setText('');
        attachments.clear();
        await refreshRunsNow();
        onOpen({ name: 'thread', id: conversation.id, source: 'direct' });
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title={<strong>New thread</strong>} onThreads={() => onNav({ name: 'threads' })} onSettings={() => onNav({ name: 'settings', tab: 'general' })} sessions={live.sessions.length} needsYou={needsYou} />
      <Banner live={live} state={state} onConnections={() => onNav({ name: 'settings', tab: 'general', connections: true })} />
      <main className="home">
        <div className="hero" ref={hero}>
          <h1>{heading}</h1>
          {catalog.source === 't3' ? <ProjectPicker projects={projects} value={project} noProject={noProject} onChange={chooseProject} /> : <FolderPicker value={folder} onChange={setFolder} />}
          {catalog.source === 't3' && noProject && project !== undefined ? (
            <button type="button" className="no-project-link" onClick={() => chooseProject(NO_PROJECT)}>
              or start without a project
            </button>
          ) : null}
          {catalog.note === undefined ? null : <p className="hero-note">{catalog.note}</p>}
        </div>
      </main>
      <div className="dock">
        {/* Over the hero's lower part, so a prompt arriving never moves the heading or the composer. */}
        <PromptCards prompts={live.prompts} currentTabId={tab?.id} askerName={askerName(live, state)} onManageSites={() => onNav({ name: 'settings', tab: 'sites' })} overlay />
        {error === undefined ? null : <p className="error-line">{error}</p>}
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void send()}
          running={false}
          busy={busy || choice === undefined}
          autoFocus
          placeholder="Ask anything"
          chip={shareable ? <TabChip title={tab.title} state={shareTab ? 'pending' : 'off'} tabs={targets.tabs} group={targets.groupTitle} onToggle={() => setShareTab(!shareTab)} /> : null}
          picker={
            <ModelPicker
              providers={catalog.providers}
              choice={choice}
              onChoice={setSavedChoice}
              access={catalog.source === 't3' ? { value: runtimeMode, modes: provider?.runtimeModes, onChange: setRuntimeMode } : undefined}
            />
          }
          attachments={attachments}
          dictation={dictation}
          notice={notice}
        />
      </div>
    </div>
  );
}
