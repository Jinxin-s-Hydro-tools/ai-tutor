import { $, addPage, NamedPage } from '@hydrooj/ui-default';

// Inject "AI 刷题建议" button right after the "Download" button in the Code section
// of the record_detail page. Pattern: NamedPage + querySelector targeting Hydro's
// existing DOM, so we don't have to override record_detail.html.
addPage(new NamedPage(['record_detail'], () => {
  const rid = (window as any).UiContext?.rdoc?._id
    || (window.location.pathname.match(/\/record\/([a-f0-9]{24})/) || [])[1];
  if (!rid) return;

  // Find the "Code" section by locating the download anchor (?download=true)
  const $downloadBtn = $('a[href*="download=true"]').first();
  if (!$downloadBtn.length) return;
  if ($downloadBtn.siblings('.ai-tutor-btn').length) return; // already injected

  const $aiBtn = $(
    `<a class="primary rounded button ai-tutor-btn" style="margin-left: 4px;"
        href="/record/${rid}/ai">
       <span class="icon icon-comment--multiple"></span>
       刷题建议
     </a>`,
  );
  $downloadBtn.after($aiBtn);
}));
