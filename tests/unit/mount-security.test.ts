import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Minimal mocks: only config path and logger ---

let allowlistPath = '';

vi.mock('../../src/config.js', () => ({
  get MOUNT_ALLOWLIST_PATH() {
    return allowlistPath;
  },
}));

vi.mock('pino', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { default: () => logger };
});

// --- Helpers ---

interface AllowlistOptions {
  allowedRoots?: Array<
    { path: string; allowReadWrite: boolean; description?: string } | string
  >;
  blockedPatterns?: string[];
  nonMainReadOnly?: boolean;
}

function writeAllowlist(dir: string, opts: AllowlistOptions = {}): void {
  const content = {
    allowedRoots: opts.allowedRoots ?? [
      { path: dir, allowReadWrite: true, description: 'Test root' },
    ],
    blockedPatterns: opts.blockedPatterns ?? [],
    nonMainReadOnly: opts.nonMainReadOnly ?? false,
  };
  fs.writeFileSync(allowlistPath, JSON.stringify(content, null, 2));
}

// --- Test suite ---

describe('mount-security', () => {
  let tmpDir: string;
  let loadMountAllowlist: typeof import('../../src/mount-security.js').loadMountAllowlist;
  let validateMount: typeof import('../../src/mount-security.js').validateMount;
  let validateAdditionalMounts: typeof import('../../src/mount-security.js').validateAdditionalMounts;
  let generateAllowlistTemplate: typeof import('../../src/mount-security.js').generateAllowlistTemplate;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-sec-'));
    allowlistPath = path.join(tmpDir, 'mount-allowlist.json');

    vi.resetModules();
    const mod = await import('../../src/mount-security.js');
    loadMountAllowlist = mod.loadMountAllowlist;
    validateMount = mod.validateMount;
    validateAdditionalMounts = mod.validateAdditionalMounts;
    generateAllowlistTemplate = mod.generateAllowlistTemplate;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── loadMountAllowlist ──────────────────────────────────────────────

  describe('loadMountAllowlist', () => {
    it('returns null when allowlist file does not exist', () => {
      // Don't create the file
      const result = loadMountAllowlist();
      expect(result).toBeNull();
    });

    it('caches the load error and returns null on subsequent calls', () => {
      const first = loadMountAllowlist();
      const second = loadMountAllowlist();
      expect(first).toBeNull();
      expect(second).toBeNull();
    });

    it('returns parsed allowlist when file is valid', () => {
      writeAllowlist(tmpDir);
      const result = loadMountAllowlist();
      expect(result).not.toBeNull();
      expect(result!.allowedRoots).toHaveLength(1);
      expect(result!.nonMainReadOnly).toBe(false);
    });

    it('caches a successful load and returns same reference on subsequent calls', () => {
      writeAllowlist(tmpDir);
      const first = loadMountAllowlist();
      const second = loadMountAllowlist();
      expect(first).toBe(second);
      expect(first).not.toBeNull();
    });

    it('normalizes string allowedRoots entries to AllowedRoot objects', () => {
      writeAllowlist(tmpDir, { allowedRoots: [tmpDir] });
      const result = loadMountAllowlist();
      expect(result!.allowedRoots[0]).toEqual({
        path: tmpDir,
        allowReadWrite: true,
      });
    });

    it('merges user blockedPatterns with default blocked patterns', () => {
      writeAllowlist(tmpDir, { blockedPatterns: ['custom_secret'] });
      const result = loadMountAllowlist();
      expect(result!.blockedPatterns).toContain('.ssh');
      expect(result!.blockedPatterns).toContain('custom_secret');
    });

    it('returns null when JSON is invalid', () => {
      fs.writeFileSync(allowlistPath, 'not valid json {{{');
      const result = loadMountAllowlist();
      expect(result).toBeNull();
    });

    it('returns null when allowedRoots is not an array', () => {
      fs.writeFileSync(
        allowlistPath,
        JSON.stringify({
          allowedRoots: 'nope',
          blockedPatterns: [],
          nonMainReadOnly: false,
        }),
      );
      const result = loadMountAllowlist();
      expect(result).toBeNull();
    });

    it('returns null when blockedPatterns is not an array', () => {
      fs.writeFileSync(
        allowlistPath,
        JSON.stringify({
          allowedRoots: [],
          blockedPatterns: 'nope',
          nonMainReadOnly: false,
        }),
      );
      const result = loadMountAllowlist();
      expect(result).toBeNull();
    });

    it('returns null when nonMainReadOnly is not a boolean', () => {
      fs.writeFileSync(
        allowlistPath,
        JSON.stringify({
          allowedRoots: [],
          blockedPatterns: [],
          nonMainReadOnly: 'yes',
        }),
      );
      const result = loadMountAllowlist();
      expect(result).toBeNull();
    });
  });

  // ── validateMount: container path validation ────────────────────────

  describe('validateMount — container path validation', () => {
    beforeEach(() => {
      writeAllowlist(tmpDir);
      fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    });

    it('rejects container path containing ".."', () => {
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'data'), containerPath: '../escape' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('..');
    });

    it('rejects absolute container path', () => {
      const result = validateMount(
        {
          hostPath: path.join(tmpDir, 'data'),
          containerPath: '/absolute/path',
        },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('must be relative');
    });

    it('falls back to hostPath basename when containerPath is empty string', () => {
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'data'), containerPath: '' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('data');
    });

    it('rejects whitespace-only container path', () => {
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'data'), containerPath: '   ' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('non-empty');
    });

    it('rejects container path with embedded ".." component', () => {
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'data'), containerPath: 'a/../b' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('..');
    });
  });

  // ── validateMount: blocked patterns (real filesystem) ───────────────

  describe('validateMount — blocked patterns', () => {
    beforeEach(() => {
      writeAllowlist(tmpDir);
    });

    it('rejects path matching .ssh', () => {
      fs.mkdirSync(path.join(tmpDir, '.ssh'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.ssh') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.ssh');
    });

    it('rejects path matching .env', () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), '');
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.env') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.env');
    });

    it('rejects path matching .aws', () => {
      fs.mkdirSync(path.join(tmpDir, '.aws'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.aws') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.aws');
    });

    it('rejects path matching credentials in a component', () => {
      fs.mkdirSync(path.join(tmpDir, 'credentials'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'credentials') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('credentials');
    });

    it('rejects path matching private_key', () => {
      fs.writeFileSync(path.join(tmpDir, 'private_key'), '');
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'private_key') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('private_key');
    });

    it('rejects path matching .docker', () => {
      fs.mkdirSync(path.join(tmpDir, '.docker'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.docker') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.docker');
    });

    it('rejects path matching .gnupg', () => {
      fs.mkdirSync(path.join(tmpDir, '.gnupg'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.gnupg') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.gnupg');
    });

    it('rejects path matching .kube', () => {
      fs.mkdirSync(path.join(tmpDir, '.kube'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.kube') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.kube');
    });

    it('rejects path matching .secret', () => {
      fs.mkdirSync(path.join(tmpDir, '.secret'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.secret') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.secret');
    });

    it('rejects path containing blocked pattern in parent directory', () => {
      fs.mkdirSync(path.join(tmpDir, '.ssh', 'authorized_keys'), {
        recursive: true,
      });
      const result = validateMount(
        { hostPath: path.join(tmpDir, '.ssh', 'authorized_keys') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.ssh');
    });

    it('rejects path where component contains blocked pattern as substring', () => {
      fs.mkdirSync(path.join(tmpDir, 'my_credentials_backup'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'my_credentials_backup') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('credentials');
    });

    it('rejects custom blocked patterns from allowlist', () => {
      writeAllowlist(tmpDir, { blockedPatterns: ['super_secret'] });
      fs.mkdirSync(path.join(tmpDir, 'super_secret'));
      const result = validateMount(
        { hostPath: path.join(tmpDir, 'super_secret') },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('super_secret');
    });
  });

  // ── validateMount: symlink traversal (real symlinks!) ───────────────

  describe('validateMount — symlink traversal', () => {
    beforeEach(() => {
      writeAllowlist(tmpDir);
    });

    it('rejects symlink that resolves to a blocked path', () => {
      const sshDir = path.join(tmpDir, '.ssh');
      fs.mkdirSync(sshDir);
      fs.symlinkSync(sshDir, path.join(tmpDir, 'innocent'));

      const result = validateMount(
        { hostPath: path.join(tmpDir, 'innocent'), containerPath: 'data' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.ssh');
    });

    it('rejects symlink that resolves outside allowed root', () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        fs.symlinkSync(outsideDir, path.join(tmpDir, 'escape'));

        const result = validateMount(
          { hostPath: path.join(tmpDir, 'escape'), containerPath: 'data' },
          true,
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not under any allowed root');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('rejects chained symlinks (A → B → blocked path)', () => {
      const sshDir = path.join(tmpDir, '.ssh');
      fs.mkdirSync(sshDir);
      // chain: link-b → .ssh, link-a → link-b
      fs.symlinkSync(sshDir, path.join(tmpDir, 'link-b'));
      fs.symlinkSync(path.join(tmpDir, 'link-b'), path.join(tmpDir, 'link-a'));

      const result = validateMount(
        { hostPath: path.join(tmpDir, 'link-a'), containerPath: 'data' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.ssh');
    });

    it('allows symlink that resolves to a safe path under allowed root', () => {
      const safeDir = path.join(tmpDir, 'safe-data');
      fs.mkdirSync(safeDir);
      fs.symlinkSync(safeDir, path.join(tmpDir, 'link-safe'));

      const result = validateMount(
        { hostPath: path.join(tmpDir, 'link-safe'), containerPath: 'data' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.realHostPath).toBe(fs.realpathSync(safeDir));
    });

    it('rejects broken symlink (target does not exist)', () => {
      fs.symlinkSync(
        path.join(tmpDir, 'nonexistent'),
        path.join(tmpDir, 'broken-link'),
      );

      const result = validateMount(
        { hostPath: path.join(tmpDir, 'broken-link'), containerPath: 'data' },
        true,
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('does not exist');
    });
  });

  // ── validateMount: host path does not exist ─────────────────────────

  it('rejects mounts where host path does not exist', () => {
    writeAllowlist(tmpDir);
    const result = validateMount(
      { hostPath: path.join(tmpDir, 'nonexistent'), containerPath: 'data' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  // ── validateMount: no allowlist ─────────────────────────────────────

  it('blocks all mounts when no allowlist file exists', () => {
    // allowlistPath points to tmpDir file that doesn't exist
    const result = validateMount(
      { hostPath: '/some/path', containerPath: 'data' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist');
  });

  // ── validateMount: not under allowed root ───────────────────────────

  describe('validateMount — allowed root', () => {
    it('rejects mounts not under any allowed root', () => {
      writeAllowlist(tmpDir);
      // Create a dir outside tmpDir
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-allowed-'));
      try {
        const result = validateMount(
          { hostPath: outsideDir, containerPath: 'data' },
          true,
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not under any allowed root');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('allows valid mount under an allowed root', () => {
      writeAllowlist(tmpDir);
      const projectDir = path.join(tmpDir, 'project');
      fs.mkdirSync(projectDir);

      const result = validateMount(
        { hostPath: projectDir, containerPath: 'proj' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.realHostPath).toBe(projectDir);
      expect(result.resolvedContainerPath).toBe('proj');
      expect(result.reason).toContain('Allowed under root');
    });

    it('includes root description in reason', () => {
      writeAllowlist(tmpDir);
      const dir = path.join(tmpDir, 'data');
      fs.mkdirSync(dir);

      const result = validateMount(
        { hostPath: dir, containerPath: 'data' },
        true,
      );
      expect(result.reason).toContain('Test root');
    });

    it('allows mount in a subdirectory of the allowed root', () => {
      writeAllowlist(tmpDir);
      const deep = path.join(tmpDir, 'a', 'b', 'c');
      fs.mkdirSync(deep, { recursive: true });

      const result = validateMount(
        { hostPath: deep, containerPath: 'nested' },
        true,
      );
      expect(result.allowed).toBe(true);
    });

    it('allows mount at the exact allowed root path', () => {
      writeAllowlist(tmpDir);
      const result = validateMount(
        { hostPath: tmpDir, containerPath: 'root' },
        true,
      );
      expect(result.allowed).toBe(true);
    });

    it('allows mount under any of multiple allowed roots', () => {
      const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'second-root-'));
      try {
        writeAllowlist(tmpDir, {
          allowedRoots: [
            { path: tmpDir, allowReadWrite: true },
            { path: secondRoot, allowReadWrite: false },
          ],
        });
        const dir = path.join(secondRoot, 'data');
        fs.mkdirSync(dir);

        const result = validateMount(
          { hostPath: dir, containerPath: 'data' },
          true,
        );
        expect(result.allowed).toBe(true);
      } finally {
        fs.rmSync(secondRoot, { recursive: true, force: true });
      }
    });
  });

  // ── validateMount: readonly enforcement ─────────────────────────────

  describe('validateMount — readonly enforcement', () => {
    let dataDir: string;

    beforeEach(() => {
      dataDir = path.join(tmpDir, 'data');
      fs.mkdirSync(dataDir);
    });

    it('defaults to readonly when mount.readonly is not specified', () => {
      writeAllowlist(tmpDir);
      const result = validateMount(
        { hostPath: dataDir, containerPath: 'data' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('allows read-write when requested, root allows it, and isMain', () => {
      writeAllowlist(tmpDir);
      const result = validateMount(
        { hostPath: dataDir, containerPath: 'data', readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });

    it('forces readonly for non-main when nonMainReadOnly is true', () => {
      writeAllowlist(tmpDir, { nonMainReadOnly: true });
      const result = validateMount(
        { hostPath: dataDir, containerPath: 'data', readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('allows read-write for non-main when nonMainReadOnly is false', () => {
      writeAllowlist(tmpDir, { nonMainReadOnly: false });
      const result = validateMount(
        { hostPath: dataDir, containerPath: 'data', readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(false);
    });

    it('forces readonly when root.allowReadWrite is false', () => {
      writeAllowlist(tmpDir, {
        allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      });
      const result = validateMount(
        { hostPath: dataDir, containerPath: 'data', readonly: false },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });

    it('nonMainReadOnly takes precedence over root.allowReadWrite for non-main', () => {
      writeAllowlist(tmpDir, {
        allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
        nonMainReadOnly: true,
      });
      const result = validateMount(
        { hostPath: dataDir, containerPath: 'data', readonly: false },
        false,
      );
      expect(result.allowed).toBe(true);
      expect(result.effectiveReadonly).toBe(true);
    });
  });

  // ── validateMount: container path derivation ────────────────────────

  describe('validateMount — container path derivation', () => {
    it('derives containerPath from hostPath basename when not specified', () => {
      writeAllowlist(tmpDir);
      const dir = path.join(tmpDir, 'my-data');
      fs.mkdirSync(dir);

      const result = validateMount({ hostPath: dir }, true);
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('my-data');
    });

    it('uses explicit containerPath when provided', () => {
      writeAllowlist(tmpDir);
      const dir = path.join(tmpDir, 'src');
      fs.mkdirSync(dir);

      const result = validateMount(
        { hostPath: dir, containerPath: 'custom-name' },
        true,
      );
      expect(result.allowed).toBe(true);
      expect(result.resolvedContainerPath).toBe('custom-name');
    });
  });

  // ── validateAdditionalMounts ────────────────────────────────────────

  describe('validateAdditionalMounts', () => {
    it('returns only valid mounts and filters out rejected ones', () => {
      writeAllowlist(tmpDir);
      const good = path.join(tmpDir, 'good');
      const alsoGood = path.join(tmpDir, 'also-good');
      fs.mkdirSync(good);
      fs.mkdirSync(alsoGood);
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-'));

      try {
        const result = validateAdditionalMounts(
          [
            { hostPath: good, containerPath: 'good' },
            { hostPath: outsideDir, containerPath: 'bad' },
            { hostPath: alsoGood, containerPath: 'also-good' },
          ],
          'test-group',
          true,
        );
        expect(result).toHaveLength(2);
        expect(result[0].hostPath).toBe(good);
        expect(result[1].hostPath).toBe(alsoGood);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('prefixes containerPath with /workspace/extra/', () => {
      writeAllowlist(tmpDir);
      const dir = path.join(tmpDir, 'data');
      fs.mkdirSync(dir);

      const result = validateAdditionalMounts(
        [{ hostPath: dir, containerPath: 'mydata' }],
        'test-group',
        true,
      );
      expect(result).toHaveLength(1);
      expect(result[0].containerPath).toBe('/workspace/extra/mydata');
    });

    it('returns empty array when no mounts are valid', () => {
      // No allowlist file → all blocked
      const result = validateAdditionalMounts(
        [{ hostPath: '/some/path', containerPath: 'data' }],
        'test-group',
        true,
      );
      expect(result).toHaveLength(0);
    });

    it('returns empty array for empty input', () => {
      writeAllowlist(tmpDir);
      const result = validateAdditionalMounts([], 'test-group', true);
      expect(result).toHaveLength(0);
    });

    it('propagates effective readonly status to output', () => {
      writeAllowlist(tmpDir, { nonMainReadOnly: true });
      const dir = path.join(tmpDir, 'data');
      fs.mkdirSync(dir);

      const result = validateAdditionalMounts(
        [{ hostPath: dir, containerPath: 'data', readonly: false }],
        'worker-group',
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].readonly).toBe(true);
    });
  });

  // ── generateAllowlistTemplate ───────────────────────────────────────

  describe('generateAllowlistTemplate', () => {
    it('returns valid JSON', () => {
      expect(() => JSON.parse(generateAllowlistTemplate())).not.toThrow();
    });

    it('has expected top-level keys', () => {
      const parsed = JSON.parse(generateAllowlistTemplate());
      expect(parsed).toHaveProperty('allowedRoots');
      expect(parsed).toHaveProperty('blockedPatterns');
      expect(parsed).toHaveProperty('nonMainReadOnly');
    });

    it('allowedRoots is an array of objects with path and allowReadWrite', () => {
      const parsed = JSON.parse(generateAllowlistTemplate());
      expect(Array.isArray(parsed.allowedRoots)).toBe(true);
      expect(parsed.allowedRoots.length).toBeGreaterThan(0);
      for (const root of parsed.allowedRoots) {
        expect(root).toHaveProperty('path');
        expect(typeof root.allowReadWrite).toBe('boolean');
      }
    });

    it('blockedPatterns is an array of strings', () => {
      const parsed = JSON.parse(generateAllowlistTemplate());
      expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
      for (const p of parsed.blockedPatterns) {
        expect(typeof p).toBe('string');
      }
    });

    it('nonMainReadOnly is true by default in template', () => {
      const parsed = JSON.parse(generateAllowlistTemplate());
      expect(parsed.nonMainReadOnly).toBe(true);
    });
  });

  // ── Default blocked patterns ────────────────────────────────────────

  describe('default blocked patterns', () => {
    const ALL_DEFAULT_BLOCKED = [
      '.ssh',
      '.gnupg',
      '.gpg',
      '.aws',
      '.azure',
      '.gcloud',
      '.kube',
      '.docker',
      'credentials',
      '.env',
      '.netrc',
      '.npmrc',
      '.pypirc',
      'id_rsa',
      'id_ed25519',
      'private_key',
      '.secret',
    ];

    it('all 17 default patterns are present in loaded allowlist', () => {
      writeAllowlist(tmpDir, { blockedPatterns: [] });
      const allowlist = loadMountAllowlist();
      expect(allowlist).not.toBeNull();
      for (const pattern of ALL_DEFAULT_BLOCKED) {
        expect(allowlist!.blockedPatterns).toContain(pattern);
      }
    });

    it.each(ALL_DEFAULT_BLOCKED)(
      'blocks mount containing default pattern: %s',
      (pattern) => {
        writeAllowlist(tmpDir);
        // Create the actual path on disk
        const target = path.join(tmpDir, pattern);
        fs.mkdirSync(target, { recursive: true });

        const result = validateMount(
          { hostPath: target, containerPath: 'test' },
          true,
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain(pattern);
      },
    );
  });
});
