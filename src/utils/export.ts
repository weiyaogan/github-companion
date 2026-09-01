export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

export function exportNotesHTML(notes: any, filename: string) {
  const title = notes?.topicTitle || notes?.title || filename || 'Study Notes';
  const summary = notes?.summaryMarkdown || notes?.coreSummary || 'No summary provided.';
  
  const formulasHtml = notes?.formulasAndDefinitions?.length
    ? `<h2>Key Formulas & Academic Definitions</h2>
       <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; margin-bottom: 2rem;">
         <thead>
           <tr style="background: #f3f4f6;">
             <th align="left">Term / Variable</th>
             <th align="left">Formula / Definition</th>
             <th align="left">Exam Application Notes</th>
           </tr>
         </thead>
         <tbody>
           ${notes.formulasAndDefinitions.map((f: any) => `
             <tr>
               <td><strong>${f.term || ''}</strong></td>
               <td><code>${f.formulaOrMeaning || ''}</code></td>
               <td>${f.notes || ''}</td>
             </tr>
           `).join('')}
         </tbody>
       </table>`
    : '';

  const cheatSheetHtml = notes?.quickCheatSheet?.length
    ? `<h2>Quick Exam Cheat Sheet & High-Yield Rules</h2>
       <ul>
         ${notes.quickCheatSheet.map((rule: string) => `<li>${rule}</li>`).join('')}
       </ul>`
    : '';

  const flashcardsHtml = notes?.flashcards?.length
    ? `<h2>Active Recall Flashcards (${notes.flashcards.length})</h2>
       ${notes.flashcards.map((f: any, idx: number) => `
         <div class="flashcard">
           <div class="flashcard-q">Card ${idx + 1}: ${f.front}</div>
           <div class="flashcard-a">Answer: ${f.back}</div>
         </div>
       `).join('')}`
    : '';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 860px; margin: 0 auto; padding: 2.5rem 1.5rem; color: #1e293b; background: #ffffff; }
    h1 { color: #1e40af; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
    h2 { color: #3730a3; margin-top: 2rem; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem; }
    h3 { color: #0f172a; margin-top: 1.25rem; }
    p, li { color: #334155; }
    .flashcard { border: 1px solid #cbd5e1; padding: 1.25rem; border-radius: 8px; margin-bottom: 1rem; background: #f8fafc; page-break-inside: avoid; }
    .flashcard-q { font-weight: 600; color: #1e293b; margin-bottom: 0.5rem; }
    .flashcard-a { margin-top: 0.5rem; color: #475569; }
    pre, code { font-family: Consolas, Monaco, monospace; background: #f1f5f9; padding: 0.2rem 0.4rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  
  <h2>Academic Study Guide & Comprehensive Notes</h2>
  <div style="white-space: pre-wrap; font-size: 1.05rem; line-height: 1.7;">${summary}</div>

  ${formulasHtml}
  ${cheatSheetHtml}
  ${flashcardsHtml}
</body>
</html>`;
  downloadFile(html, `${filename}.html`, 'text/html');
}

export function exportNotesDoc(notes: any, filename: string) {
  const title = notes?.topicTitle || notes?.title || filename || 'Study Notes';
  const summary = notes?.summaryMarkdown || notes?.coreSummary || '';

  const formulasHtml = notes?.formulasAndDefinitions?.length
    ? `<h2>Key Formulas & Academic Definitions</h2>
       <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse; width: 100%;">
         <tr style="background-color: #eee;">
           <th>Term</th><th>Formula / Definition</th><th>Exam Notes</th>
         </tr>
         ${notes.formulasAndDefinitions.map((f: any) => `
           <tr>
             <td><b>${f.term || ''}</b></td>
             <td>${f.formulaOrMeaning || ''}</td>
             <td>${f.notes || ''}</td>
           </tr>
         `).join('')}
       </table>`
    : '';

  const cheatSheetHtml = notes?.quickCheatSheet?.length
    ? `<h2>Quick Exam Cheat Sheet</h2>
       <ul>${notes.quickCheatSheet.map((rule: string) => `<li>${rule}</li>`).join('')}</ul>`
    : '';

  const flashcardsHtml = notes?.flashcards?.length
    ? `<h2>Active Recall Flashcards</h2>
       ${notes.flashcards.map((f: any, idx: number) => `
         <p><b>Card ${idx + 1}:</b> ${f.front}</p>
         <p><b>Answer:</b> ${f.back}</p>
         <hr/>
       `).join('')}`
    : '';

  const html = `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><title>${title}</title></head>
<body style="font-family: Arial, sans-serif;">
  <h1>${title}</h1>
  <h2>Study Guide & Core Concepts</h2>
  <div style="white-space: pre-wrap;">${summary}</div>
  ${formulasHtml}
  ${cheatSheetHtml}
  ${flashcardsHtml}
</body>
</html>`;
  downloadFile(html, `${filename}.doc`, 'application/msword');
}

export function exportNotesMarkdown(notes: any, filename: string) {
  const title = notes?.topicTitle || notes?.title || filename || 'Study Notes';
  const summary = notes?.summaryMarkdown || notes?.coreSummary || '';

  let md = `# ${title}\n\n`;
  md += `## Study Guide & Core Notes\n\n${summary}\n\n`;

  if (notes?.formulasAndDefinitions && notes.formulasAndDefinitions.length > 0) {
    md += `## Key Formulas & Academic Definitions\n\n`;
    md += `| Term / Concept | Formula / Meaning | Exam Notes |\n`;
    md += `| --- | --- | --- |\n`;
    notes.formulasAndDefinitions.forEach((f: any) => {
      md += `| **${f.term || ''}** | \`${f.formulaOrMeaning || ''}\` | ${f.notes || ''} |\n`;
    });
    md += `\n`;
  }

  if (notes?.quickCheatSheet && notes.quickCheatSheet.length > 0) {
    md += `## Quick Exam Cheat Sheet\n\n`;
    notes.quickCheatSheet.forEach((rule: string) => {
      md += `- ${rule}\n`;
    });
    md += `\n`;
  }

  if (notes?.flashcards && notes.flashcards.length > 0) {
    md += `## Active Recall Flashcards (${notes.flashcards.length})\n\n`;
    notes.flashcards.forEach((f: any, idx: number) => {
      md += `### Card ${idx + 1}: ${f.front}\n**Answer**: ${f.back}\n\n`;
    });
  }

  downloadFile(md, `${filename}.md`, 'text/markdown');
}
