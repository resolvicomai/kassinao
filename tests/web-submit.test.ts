import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { contextPage } from '../src/web/page';

it('preserves the clicked snooze button in the submitted payload and removes its copy on pageshow', () => {
  const html = contextPage({
    user: { id: '123', name: 'Pessoa', avatar: null, scope: 'full', exp: Date.now() + 60_000 },
    lang: 'pt',
    configured: false,
    entries: [
      {
        id: 'a'.repeat(32),
        meetingId: 'test-meeting',
        guildId: '1',
        channelId: '2',
        meetingStartedAt: Date.now(),
        task: 'Revisar',
        sourcePresent: true,
        status: 'confirmed',
        createdAt: 1,
        updatedAt: 1,
        links: [],
        preference: { mode: 'follow' },
        deadlineState: 'unknown',
      },
    ],
  });
  const script = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi), (match) => match[1]).find(
    (candidate) => candidate.includes("document.addEventListener('submit'"),
  );
  if (!script) throw new Error('Shared submit script not found');

  class Control {
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    disabled = false;
    form?: typeof form;
    constructor(
      public tagName: string,
      public name = '',
      public value = '',
      public textContent = '',
      public type = 'submit',
    ) {}
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    removeAttribute(name: string) {
      this.attributes.delete(name);
    }
    remove() {
      if (!this.form) return;
      this.form.controls.splice(this.form.controls.indexOf(this), 1);
    }
  }
  const mode = new Control('INPUT', 'mode', 'mute', '', 'hidden');
  const primary = new Control('BUTTON', '', '', 'Parar avisos por DM');
  const pause = new Control('BUTTON', 'snooze', '7', 'Pausar 7 dias');
  const form = {
    dataset: {} as Record<string, string>,
    attributes: new Map<string, string>(),
    controls: [mode, primary, pause],
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
    querySelector: () => primary,
    appendChild(control: Control) {
      expect(pause.disabled).toBe(false); // The value must be captured before disabling its successful control.
      control.form = form;
      this.controls.push(control);
    },
  };
  for (const control of form.controls) control.form = form;
  type SubmitEvent = { target: typeof form; submitter: Control; defaultPrevented: boolean; preventDefault: () => void };
  const documentListeners = new Map<string, (event: SubmitEvent) => void>();
  const windowListeners = new Map<string, (event: { persisted: boolean }) => void>();
  vm.runInNewContext(script, {
    document: {
      addEventListener: (name: string, listener: (event: SubmitEvent) => void) => documentListeners.set(name, listener),
      createElement: () => new Control('INPUT'),
      querySelectorAll: (selector: string) =>
        form.controls.filter((control) =>
          selector.includes('submit-value')
            ? control.dataset.submitValue === 'true'
            : control.dataset.submitBusy === 'true',
        ),
    },
    window: {
      addEventListener: (name: string, listener: (event: { persisted: boolean }) => void) =>
        windowListeners.set(name, listener),
      confirm: () => true,
    },
  });
  const submit = documentListeners.get('submit');
  const pageshow = windowListeners.get('pageshow');
  if (!submit || !pageshow) throw new Error('Submit/pageshow listeners were not installed');
  // Model successful form controls: disabled buttons are omitted, as in native form submission.
  const payload = (submitter?: Control) =>
    form.controls
      .filter((control) => control.name && !control.disabled && (control.tagName !== 'BUTTON' || control === submitter))
      .map((control) => [control.name, control.value]);

  submit({ target: form, submitter: pause, defaultPrevented: false, preventDefault: vi.fn() });
  expect(pause.disabled).toBe(true);
  expect(primary.disabled).toBe(false);
  expect(payload(pause)).toEqual([
    ['mode', 'mute'],
    ['snooze', '7'],
  ]);
  expect(form.attributes.get('aria-busy')).toBe('true');

  pageshow({ persisted: false });
  expect(form.controls).toEqual([mode, primary, pause]);
  expect(pause.disabled).toBe(false);
  expect(pause.textContent).toBe('Pausar 7 dias');
  expect(pause.dataset.submitBusy).toBeUndefined();
  expect(form.attributes.has('aria-busy')).toBe(false);
  submit({ target: form, submitter: primary, defaultPrevented: false, preventDefault: vi.fn() });
  expect(payload(primary)).toEqual([['mode', 'mute']]); // The previous snooze cannot survive a new action.
});
