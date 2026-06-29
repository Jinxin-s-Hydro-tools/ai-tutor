import { addPage, NamedPage } from '@hydrooj/ui-default';

declare const UiContext: any;

function domainPrefix() {
  const match = window.location.pathname.match(/^(\/d\/[^/]+)/);
  return match ? match[1] : '';
}

function effectiveLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('//'))
    .filter((line) => !/^\/\*|\*|\*\/$/.test(line))
    .filter((line) => !/^[{}]+;?$/.test(line))
    .length;
}

function isEditorTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (['TEXTAREA', 'INPUT'].includes(el.tagName)) return true;
  if (el.isContentEditable) return true;
  return !!el.closest('.CodeMirror, .monaco-editor, [data-editor], form[action*="submit"]');
}

function startCollector() {
  const tdoc = UiContext?.tdoc;
  const pid = UiContext?.problemNumId || UiContext?.problemId;
  if (!tdoc?._id && !tdoc?.docId) return;
  if (!pid) return;

  const tid = String(tdoc._id || tdoc.docId);
  if (!/^[a-f0-9]{24}$/i.test(tid)) return;
  const endpoint = `${domainPrefix()}/domain/ai-tutor/proctor/event`;
  let lastState: 'active' | 'away' = document.visibilityState === 'visible' && document.hasFocus() ? 'active' : 'away';
  let keyCount = 0;
  let lastSubmitAt = 0;

  function send(payload: Record<string, any>, beacon = false) {
    const body = JSON.stringify({
      tid,
      pid,
      ts: new Date().toISOString(),
      ...payload,
    });
    if (beacon && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(endpoint, blob);
      return;
    }
    fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    }).catch(() => {});
  }

  function setState(next: 'active' | 'away') {
    if (next === lastState) return;
    lastState = next;
    send({ type: next === 'active' ? 'return' : 'leave' }, next === 'away');
  }

  send({ type: 'enter' });

  window.addEventListener('blur', () => setState('away'));
  window.addEventListener('focus', () => {
    if (document.visibilityState === 'visible') setState('active');
  });
  document.addEventListener('visibilitychange', () => {
    setState(document.visibilityState === 'visible' && document.hasFocus() ? 'active' : 'away');
  });
  window.addEventListener('beforeunload', () => {
    send({ type: 'leave' }, true);
  });

  document.addEventListener('paste', (event) => {
    if (!isEditorTarget(event.target)) return;
    const text = event.clipboardData?.getData('text') || '';
    if (!text) return;
    send({
      type: 'paste',
      text,
      length: text.length,
      lines: effectiveLines(text),
      truncated: text.length > 64 * 1024,
    });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!isEditorTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1 && !['Backspace', 'Delete', 'Enter', 'Tab'].includes(event.key)) return;
    keyCount++;
  }, true);

  document.addEventListener('submit', () => {
    const now = Date.now();
    if (now - lastSubmitAt < 1000) return;
    lastSubmitAt = now;
    send({ type: 'submit' }, true);
  }, true);
  document.addEventListener('click', (event) => {
    const el = event.target as HTMLElement | null;
    if (!el?.closest('input[type="submit"], button[type="submit"], .button.primary')) return;
    const now = Date.now();
    if (now - lastSubmitAt < 1000) return;
    lastSubmitAt = now;
    send({ type: 'submit' }, true);
  }, true);

  window.setInterval(() => {
    if (keyCount > 0) {
      send({ type: 'keystroke', count: keyCount });
      keyCount = 0;
    }
  }, 5000);

  window.setInterval(() => {
    if (document.visibilityState === 'visible' && document.hasFocus()) send({ type: 'heartbeat' });
  }, 15000);
}

addPage(new NamedPage([
  'contest_detail_problem',
  'homework_detail_problem',
  'contest_detail_problem_submit',
  'homework_detail_problem_submit',
], startCollector));
