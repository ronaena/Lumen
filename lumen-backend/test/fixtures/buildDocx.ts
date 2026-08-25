import JSZip from 'jszip';

/**
 * Builds a real, minimal, valid DOCX (Office Open XML) archive as a Buffer for
 * integration tests -- same approach as buildEpub.ts, using the already-installed
 * jszip dev dependency rather than a DOCX-generation library.
 */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function buildValidDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  const bodyParagraphs = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(p)}</w:t></w:r></w:p>`)
    .join('');

  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyParagraphs}</w:body>
</w:document>`,
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A file that is a valid ZIP but has no word/document.xml -- structurally invalid as DOCX. */
export async function buildInvalidDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('not-a-docx.txt', 'this zip has no word/document.xml');
  return zip.generateAsync({ type: 'nodebuffer' });
}
