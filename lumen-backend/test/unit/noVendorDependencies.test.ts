import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(fullPath);
    if (entry.name.endsWith('.ts')) return [fullPath];
    return [];
  });
}

// Matches actual import/require specifiers, not arbitrary substrings — a type-level
// example like `'elevenlabs' | 'google_cloud_tts' | string` in ProviderId is exactly the
// correct provider-neutral design (an open string type) and must NOT trip this check.
// What must never appear is an import FROM a vendor package.
const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+['"]elevenlabs/i,
  /from\s+['"]@?google-cloud/i,
  /from\s+['"]googleapis/i,
  /require\(\s*['"]elevenlabs/i,
  /require\(\s*['"]@?google-cloud/i,
];

describe('domain and tts layers have zero vendor SDK dependencies', () => {
  const domainFiles = collectTsFiles(join(process.cwd(), 'src/domain'));
  const ttsFiles = collectTsFiles(join(process.cwd(), 'src/tts')).filter(
    (f) => !f.includes('providers'), // the empty adapter directory is exempt by design
  );

  it.each([...domainFiles, ...ttsFiles])('%s imports no vendor SDK', (file) => {
    const content = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      expect(pattern.test(content)).toBe(false);
    }
  });
});

describe('concrete vendor provider classes stay inside their own adapter directory', () => {
  // Matches actual import statements, not arbitrary substrings — a code comment
  // mentioning "ElevenLabsProvider" in prose (e.g. explaining an architectural
  // decision) is not a coupling violation, only a real `import { ElevenLabsProvider }`
  // is. Mirrors the same precise-pattern precedent already used above for vendor SDK
  // imports, for the same reason.
  const FORBIDDEN_CONCRETE_IMPORT_PATTERNS = [/import\s*\{[^}]*\bElevenLabsProvider\b/, /import\s*\{[^}]*\bGoogleCloudTtsProvider\b/];

  const everyOtherSourceFile = collectTsFiles(join(process.cwd(), 'src')).filter(
    (f) => !f.includes(join('tts', 'providers')) && !f.endsWith(join('src', 'main.ts')),
    // src/main.ts is the composition root — the one place in the whole codebase whose
    // actual job is to construct concrete provider implementations and register them
    // into the provider-neutral ProviderRegistry. This is correct, standard
    // architecture (something has to wire concrete classes into an abstraction), not a
    // violation of "narration/domain/API stay provider-neutral" — that invariant is
    // verified separately below and remains fully intact.
  );

  it.each(everyOtherSourceFile)('%s does not import ElevenLabsProvider or GoogleCloudTtsProvider directly', (file) => {
    const content = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_CONCRETE_IMPORT_PATTERNS) {
      expect(pattern.test(content)).toBe(false);
    }
  });

  it('narration, domain, and API layers specifically have zero references to either concrete provider class, confirming the real invariant this file protects', () => {
    const criticalLayers = [
      ...collectTsFiles(join(process.cwd(), 'src/narration')),
      ...collectTsFiles(join(process.cwd(), 'src/domain')),
      ...collectTsFiles(join(process.cwd(), 'src/api')),
    ];
    for (const file of criticalLayers) {
      const content = readFileSync(file, 'utf8');
      expect(content.includes('ElevenLabsProvider')).toBe(false);
      expect(content.includes('GoogleCloudTtsProvider')).toBe(false);
    }
  });
});
