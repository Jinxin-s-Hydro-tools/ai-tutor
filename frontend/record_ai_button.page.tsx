import { $, addPage, NamedPage } from '@hydrooj/ui-default';

// Inject "AI 刷题建议" button right after the "Download" button in the Code section
// of the record_detail page.
//
// IMPORTANT: records in contests/homeworks usually live in a non-system domain.
// Their URL is `/d/<domain>/record/<rid>`. We MUST preserve the `/d/<domain>/`
// prefix when building the AI page URL — otherwise the backend resolves
// domainId to 'system' and RecordModel.get returns null (NotFoundError).
addPage(new NamedPage(['record_detail'], async () => {
  const m = window.location.pathname.match(/^(\/d\/[^/]+)?\/record\/([a-f0-9]{24})/);
  if (!m) return;
  const domainPrefix = m[1] || '';        // e.g. "/d/class1" or "" for system
  const rid = m[2];

  try {
    const resp = await fetch(`${domainPrefix}/record/${rid}/ai/available`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data?.ok) return;
  } catch {
    return;
  }

  // Find the "Code" section by locating the download anchor (?download=true)
  const $downloadBtn = $('a[href*="download=true"]').first();
  if (!$downloadBtn.length) return;
  if ($downloadBtn.siblings('.ai-tutor-btn').length) return; // already injected

  const $aiBtn = $(
    `<a class="primary rounded button ai-tutor-btn" style="margin-left: 4px;"
        href="${domainPrefix}/record/${rid}/ai">
       <span class="icon icon-comment--multiple"></span>
       AI 刷题建议
     </a>`,
  );
  $downloadBtn.after($aiBtn);
}));
