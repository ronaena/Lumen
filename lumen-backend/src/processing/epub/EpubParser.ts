import { XMLParser } from 'fast-xml-parser';
import { dirname, posix } from 'node:path';
import type { EpubArchive } from './EpubArchive.js';
import { EpubValidationError } from '../errors/ProcessingErrors.js';

export interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

export interface EpubSpineItem {
  idref: string;
  linear: boolean;
}

export interface EpubMetadata {
  title?: string;
  author?: string;
  language?: string;
}

export interface EpubSpineDocument {
  /** Deterministic order — this is the authoritative chapter-processing order. */
  orderIndex: number;
  /** Path within the archive, resolved relative to the OPF directory. Used as sourceLocation. */
  path: string;
  /** Best-effort only, from NCX/nav — never overrides spine order. */
  title: string | null;
}

export interface ParsedEpub {
  metadata: EpubMetadata;
  spineDocuments: EpubSpineDocument[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Resolves a manifest href (relative to the OPF's directory) into an archive-absolute path. */
function resolveAgainstOpf(opfPath: string, href: string): string {
  const opfDir = dirname(opfPath);
  const resolved = posix.normalize(posix.join(opfDir === '.' ? '' : opfDir, href));
  return resolved.replace(/^\//, '');
}

function findOpfPath(archive: EpubArchive): string {
  const containerXml = archive.readText('META-INF/container.xml');
  if (!containerXml) {
    throw new EpubValidationError('MISSING_CONTAINER_XML');
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(containerXml);
  } catch (cause) {
    throw new EpubValidationError('INVALID_OPF_REFERENCE', { cause });
  }

  const container = (parsed as any)?.container;
  const rootfiles = toArray(container?.rootfiles?.rootfile);
  const opfPath = rootfiles[0]?.['@_full-path'];

  if (!opfPath || typeof opfPath !== 'string' || !archive.has(opfPath)) {
    throw new EpubValidationError('INVALID_OPF_REFERENCE');
  }

  return opfPath;
}

function parseOpf(archive: EpubArchive, opfPath: string) {
  const opfXml = archive.readText(opfPath);
  if (!opfXml) {
    throw new EpubValidationError('INVALID_OPF_REFERENCE');
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(opfXml);
  } catch (cause) {
    throw new EpubValidationError('UNPARSEABLE_STRUCTURE', { cause });
  }

  const pkg = (parsed as any)?.package;
  if (!pkg) {
    throw new EpubValidationError('UNPARSEABLE_STRUCTURE');
  }

  const metadataNode = pkg.metadata ?? {};
  const metadata: EpubMetadata = {
    title: extractDcText(metadataNode['dc:title']),
    author: extractDcText(metadataNode['dc:creator']),
    language: extractDcText(metadataNode['dc:language']),
  };

  const manifestItems: EpubManifestItem[] = toArray(pkg.manifest?.item).map((item: any) => ({
    id: item['@_id'],
    href: item['@_href'],
    mediaType: item['@_media-type'],
    properties: item['@_properties'],
  }));

  const spineItems: EpubSpineItem[] = toArray(pkg.spine?.itemref).map((item: any) => ({
    idref: item['@_idref'],
    linear: item['@_linear'] !== 'no',
  }));

  const spineTocAttr: string | undefined = pkg.spine?.['@_toc'];

  if (manifestItems.length === 0 || spineItems.length === 0) {
    throw new EpubValidationError('UNPARSEABLE_STRUCTURE');
  }

  return { metadata, manifestItems, spineItems, spineTocAttr };
}

function extractDcText(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node.trim() || undefined;
  if (typeof node === 'object' && '#text' in (node as any)) {
    return String((node as any)['#text']).trim() || undefined;
  }
  return undefined;
}

/** Best-effort chapter titles from an EPUB2 NCX file. Never authoritative over spine order. */
function parseNcxTitles(archive: EpubArchive, ncxPath: string): Map<string, string> {
  const titles = new Map<string, string>();
  const ncxXml = archive.readText(ncxPath);
  if (!ncxXml) return titles;

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(ncxXml);
  } catch {
    return titles; // best-effort only — an unparseable NCX must not fail the whole book
  }

  const navMap = (parsed as any)?.ncx?.navMap;
  if (!navMap) return titles;

  // content@src in an NCX is relative to the NCX file's own location, not the OPF's —
  // must be resolved against ncxDir before it can be matched against spine paths (which
  // are already resolved relative to the OPF).
  const ncxDir = dirname(ncxPath);
  const collect = (navPoint: any): void => {
    for (const point of toArray(navPoint)) {
      const label = extractDcText(point?.navLabel?.text);
      const src: string | undefined = point?.content?.['@_src'];
      if (label && src) {
        const [pathOnly] = src.split('#');
        if (pathOnly) {
          const resolved = posix
            .normalize(posix.join(ncxDir === '.' ? '' : ncxDir, pathOnly))
            .replace(/^\//, '');
          titles.set(resolved, label);
        }
      }
      if (point?.navPoint) collect(point.navPoint);
    }
  };
  collect(navMap.navPoint);

  return titles;
}

/** Best-effort chapter titles from an EPUB3 nav document (properties="nav"). */
function parseNavTitles(archive: EpubArchive, navPath: string): Map<string, string> {
  const titles = new Map<string, string>();
  const navXml = archive.readText(navPath);
  if (!navXml) return titles;

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(navXml);
  } catch {
    return titles;
  }

  const navDir = dirname(navPath);
  const anchors: any[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'a') anchors.push(...toArray(value));
        else if (!key.startsWith('@_')) walk(value);
      }
    }
  };
  walk(parsed);

  for (const anchor of anchors) {
    const href: string | undefined = anchor?.['@_href'];
    const label = extractDcText(anchor);
    if (href && label) {
      const [hrefOnly] = href.split('#');
      if (!hrefOnly) continue;
      const resolved = posix.normalize(posix.join(navDir === '.' ? '' : navDir, hrefOnly)).replace(/^\//, '');
      titles.set(resolved, label);
    }
  }

  return titles;
}

/**
 * Parses a validated EPUB archive into spine-ordered documents with best-effort titles.
 * Spine order is authoritative and is never overridden by NCX/nav — per approved
 * decision, chapter detection uses spine order only.
 */
export function parseEpub(archive: EpubArchive): ParsedEpub {
  const opfPath = findOpfPath(archive);
  const { metadata, manifestItems, spineItems, spineTocAttr } = parseOpf(archive, opfPath);

  const manifestById = new Map(manifestItems.map((item) => [item.id, item]));

  let titlesByPath = new Map<string, string>();
  const ncxItem = spineTocAttr
    ? manifestById.get(spineTocAttr)
    : manifestItems.find((item) => item.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const ncxPath = resolveAgainstOpf(opfPath, ncxItem.href);
    titlesByPath = parseNcxTitles(archive, ncxPath);
  }
  if (titlesByPath.size === 0) {
    const navItem = manifestItems.find((item) => item.properties?.includes('nav'));
    if (navItem) {
      const navPath = resolveAgainstOpf(opfPath, navItem.href);
      titlesByPath = parseNavTitles(archive, navPath);
    }
  }

  const spineDocuments: EpubSpineDocument[] = spineItems
    .filter((item) => item.linear)
    .map((item, index) => {
      const manifestItem = manifestById.get(item.idref);
      if (!manifestItem) {
        throw new EpubValidationError('UNPARSEABLE_STRUCTURE');
      }
      const path = resolveAgainstOpf(opfPath, manifestItem.href);
      return {
        orderIndex: index,
        path,
        title: titlesByPath.get(path) ?? null,
      };
    });

  if (spineDocuments.length === 0) {
    throw new EpubValidationError('UNPARSEABLE_STRUCTURE');
  }

  return { metadata, spineDocuments };
}
