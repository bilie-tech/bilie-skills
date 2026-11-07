// CV files: DOCX master -> markdown (so the model can read it cheaply), and
// tailored markdown -> a plain, ATS-friendly DOCX (single column, real
// headings, no tables or text boxes).
import { readFileSync, writeFileSync } from 'node:fs';
import { need } from './deps.mjs';

export async function docxToMarkdown(file) {
  const mammoth = need('mammoth');
  const { value } = await mammoth.convertToMarkdown({ path: file });
  return value
    .replace(/__(.+?)__/g, '**$1**')
    .replace(/\\([-.()#+!])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

const inline = (docx, text, base = {}) => {
  const runs = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(new docx.TextRun({ text: text.slice(last, m.index), ...base }));
    runs.push(new docx.TextRun({ text: m[1] || m[2], bold: Boolean(m[1]) || base.bold, italics: Boolean(m[2]), ...(m[1] ? {} : {}) }));
    last = re.lastIndex;
  }
  if (last < text.length) runs.push(new docx.TextRun({ text: text.slice(last), ...base }));
  return runs;
};

export async function markdownToDocx(mdFile, outFile) {
  const docx = need('docx');
  const lines = readFileSync(mdFile, 'utf8').split(/\r?\n/);
  const children = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^#\s+(.*)/))) children.push(new docx.Paragraph({ heading: docx.HeadingLevel.TITLE, children: inline(docx, m[1], { bold: true, size: 32 }) }));
    else if ((m = line.match(/^##\s+(.*)/))) children.push(new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_1, spacing: { before: 240, after: 80 }, children: inline(docx, m[1], { bold: true, size: 24 }) }));
    else if ((m = line.match(/^###\s+(.*)/))) children.push(new docx.Paragraph({ heading: docx.HeadingLevel.HEADING_2, spacing: { before: 160, after: 40 }, children: inline(docx, m[1], { bold: true, size: 21 }) }));
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) children.push(new docx.Paragraph({ bullet: { level: 0 }, children: inline(docx, m[1], { size: 21 }) }));
    else children.push(new docx.Paragraph({ children: inline(docx, line.trim(), { size: 21 }) }));
  }
  const doc = new docx.Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children }],
  });
  writeFileSync(outFile, await docx.Packer.toBuffer(doc));
  return outFile;
}
