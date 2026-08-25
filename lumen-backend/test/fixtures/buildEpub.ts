import JSZip from 'jszip';

export interface ChapterFixture {
  id: string;
  filename: string;
  title?: string;
  paragraphs: string[];
}

export interface BuildEpubOptions {
  title?: string;
  author?: string;
  language?: string;
  chapters: ChapterFixture[];
  includeNcx?: boolean;
  includeNav?: boolean;
}

function chapterXhtml(chapter: ChapterFixture): string {
  const body = chapter.paragraphs.map((p) => `<p>${p}</p>`).join('\n    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${chapter.title ?? chapter.id}</title></head>
  <body>
    ${body}
  </body>
</html>`;
}

/** Builds a real, valid, minimal EPUB2-or-3-style archive as a Buffer for integration tests. */
export async function buildValidEpub(options: BuildEpubOptions): Promise<Buffer> {
  const zip = new JSZip();

  // The mimetype entry must be the first entry and stored uncompressed per the EPUB spec.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );

  for (const chapter of options.chapters) {
    zip.file(`OEBPS/${chapter.filename}`, chapterXhtml(chapter));
  }

  const manifestItems = options.chapters
    .map((c) => `<item id="${c.id}" href="${c.filename}" media-type="application/xhtml+xml"/>`)
    .join('\n    ');
  const spineItems = options.chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ');

  let ncxItem = '';
  let navItem = '';
  let spineTocAttr = '';

  if (options.includeNcx ?? true) {
    ncxItem = `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;
    spineTocAttr = ' toc="ncx"';
    const navPoints = options.chapters
      .map(
        (c, i) => `<navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${c.title ?? c.id}</text></navLabel>
      <content src="${c.filename}"/>
    </navPoint>`,
      )
      .join('\n    ');
    zip.file(
      'OEBPS/toc.ncx',
      `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`,
    );
  }

  if (options.includeNav) {
    navItem = `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`;
    const navLis = options.chapters
      .map((c) => `<li><a href="${c.filename}">${c.title ?? c.id}</a></li>`)
      .join('\n        ');
    zip.file(
      'OEBPS/nav.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        ${navLis}
      </ol>
    </nav>
  </body>
</html>`,
    );
  }

  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${options.title ?? 'Untitled'}</dc:title>
    <dc:creator>${options.author ?? 'Unknown'}</dc:creator>
    <dc:language>${options.language ?? 'en'}</dc:language>
  </metadata>
  <manifest>
    ${manifestItems}
    ${ncxItem}
    ${navItem}
  </manifest>
  <spine${spineTocAttr}>
    ${spineItems}
  </spine>
</package>`,
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return buffer;
}

export async function buildCorruptZip(): Promise<Buffer> {
  return Buffer.from('this is not a zip file at all, just garbage bytes');
}

export async function buildZipMissingMimetype(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container></container>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function buildZipMissingContainer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function buildZipInvalidOpfReference(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/does-not-exist.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
