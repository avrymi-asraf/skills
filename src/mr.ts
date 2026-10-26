import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { cp, rm } from 'fs/promises';
import { basename, dirname, join } from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { cleanupTempDir, cloneRepo } from './git.ts';
import { getCanonicalSkillsDir } from './installer.ts';
import { computeSkillFolderHash, readLocalLock } from './local-lock.ts';
import { readSkillLock } from './skill-lock.ts';

export interface MrOptions {
  skills: string[];
  message?: string;
  base?: string;
  draft?: boolean;
  global?: boolean;
  yes?: boolean;
  help?: boolean;
}

export interface ParseMrOptionsResult {
  options: MrOptions;
  errors: string[];
}

export function parseMrOptions(args: string[]): ParseMrOptionsResult {
  const options: MrOptions = { skills: [] };
  const errors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--draft' || arg === '-d') options.draft = true;
    else if (arg === '--global' || arg === '-g') options.global = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--message' || arg === '-m' || arg === '--base' || arg === '-b') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        errors.push(`${arg} requires a value`);
        continue;
      }
      if (arg === '--message' || arg === '-m') options.message = value;
      else options.base = value;
      i++;
    } else if (arg.startsWith('-')) errors.push(`Unknown option: ${arg}`);
    else options.skills.push(arg);
  }

  return { options, errors };
}

/** Turn a title into a safe branch name segment. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'skills'
  );
}

export function generateTitle(skills: string[]): string {
  if (skills.length <= 3) return `Update ${skills.join(', ')}`;
  return `Update ${skills.length} skills`;
}

/** Folder of a skill inside its source repo, derived from the locked SKILL.md path. */
export function skillFolder(skillPath: string): string {
  const normalized = skillPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = /(^|\/)SKILL\.md$/i.test(normalized) ? dirname(normalized) : normalized;
  return dir === '.' ? '' : dir;
}

export function isGitLab(url: string): boolean {
  return /gitlab/i.test(url);
}

interface SkillSource {
  name: string;
  url: string;
  ref?: string;
  folder: string;
  localDir: string;
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function showMrHelp(): void {
  console.log(`
Usage: skills mr [skills...] [options]

Send local edits to installed skills back to the repo they came from,
as a pull request (GitHub, via gh) or merge request (GitLab, via glab).

Only skills whose files differ from their source are included. With no
skill names, every modified skill is considered.

Options:
  -m, --message <text>   Commit message and MR title (default: generated)
  -b, --base <branch>    Target branch (default: the ref the skill was installed from)
  -d, --draft            Open as a draft
  -g, --global           Use globally installed skills
  -y, --yes              Skip the confirmation prompt
`);
}

async function loadSources(options: MrOptions): Promise<SkillSource[]> {
  const cwd = process.cwd();
  const skillsDir = getCanonicalSkillsDir(!!options.global, cwd);
  const entries = options.global
    ? Object.entries((await readSkillLock()).skills)
    : Object.entries((await readLocalLock(cwd)).skills);

  const sources: SkillSource[] = [];
  for (const [name, entry] of entries) {
    if (options.skills.length > 0 && !options.skills.includes(name)) continue;
    if (!entry.skillPath) continue;
    const url =
      entry.sourceUrl ??
      (entry.sourceType === 'github' ? `https://github.com/${entry.source}.git` : undefined);
    if (!url || !/^(https?:|git@|ssh:|file:)/.test(url)) continue;
    const localDir = join(skillsDir, name);
    if (!existsSync(localDir)) continue;
    sources.push({ name, url, ref: entry.ref, folder: skillFolder(entry.skillPath), localDir });
  }
  return sources;
}

/** Push the branch, falling back to a personal fork (GitHub) when there is no write access. */
function pushBranch(repoDir: string, branch: string, github: boolean): { head: string } {
  try {
    run('git', ['push', '-u', 'origin', branch], repoDir);
    return { head: branch };
  } catch (error) {
    if (!github) throw error;
    run('gh', ['repo', 'fork', '--remote', '--remote-name', 'fork'], repoDir);
    const me = run('gh', ['api', 'user', '-q', '.login']);
    run('git', ['push', '-u', 'fork', branch], repoDir);
    return { head: `${me}:${branch}` };
  }
}

export async function runMr(options: MrOptions, errors: string[] = []): Promise<void> {
  if (options.help) return showMrHelp();
  if (errors.length > 0) {
    for (const error of errors) console.error(`Error: ${error}`);
    process.exitCode = 1;
    return;
  }

  p.intro(pc.bgCyan(pc.black(' skills mr ')));

  const sources = await loadSources(options);
  if (sources.length === 0) {
    p.log.warn('No installed skills with a git source found. Install some with `skills add`.');
    p.outro('Nothing to do');
    return;
  }

  // Group by repo so each source gets one clone and one MR.
  const groups = new Map<string, SkillSource[]>();
  for (const s of sources) {
    const key = `${s.url}#${s.ref ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  let opened = 0;
  for (const group of groups.values()) {
    const { url, ref } = group[0]!;
    const spinner = p.spinner();
    spinner.start(`Comparing with ${url}`);
    let repoDir: string | undefined;
    try {
      repoDir = await cloneRepo(url, ref);

      const changed: SkillSource[] = [];
      for (const s of group) {
        const repoSkillDir = join(repoDir, s.folder);
        if (!existsSync(repoSkillDir)) continue;
        const [local, remote] = await Promise.all([
          computeSkillFolderHash(s.localDir),
          computeSkillFolderHash(repoSkillDir),
        ]);
        if (local !== remote) changed.push(s);
      }
      spinner.stop(`${url}: ${changed.length} modified skill${changed.length === 1 ? '' : 's'}`);
      if (changed.length === 0) continue;

      const names = changed.map((s) => s.name);
      p.log.message(names.map((n) => `  ${pc.cyan(n)}`).join('\n'));
      if (!options.yes) {
        const ok = await p.confirm({ message: `Open a MR on ${url}?` });
        if (p.isCancel(ok) || !ok) continue;
      }

      const title = options.message ?? generateTitle(names);
      const github = !isGitLab(url);
      const cli = github ? 'gh' : 'glab';
      const base =
        options.base ??
        ref ??
        run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir).replace(
          /^origin\//,
          ''
        );
      const branch = `skills/${slugify(title)}-${Date.now().toString(36)}`;

      run('git', ['checkout', '-b', branch], repoDir);
      for (const s of changed) {
        const target = join(repoDir, s.folder);
        await rm(target, { recursive: true, force: true });
        await cp(s.localDir, target, {
          recursive: true,
          filter: (src) => !['.git', 'node_modules'].includes(basename(src)),
        });
      }
      run('git', ['add', '-A'], repoDir);
      run('git', ['commit', '-m', title], repoDir);

      const push = p.spinner();
      push.start('Pushing');
      const { head } = pushBranch(repoDir, branch, github);
      push.stop(`Pushed ${pc.cyan(head)}`);

      const body = `Updated from a project using \`skills mr\`:\n\n${names.map((n) => `- ${n}`).join('\n')}`;
      const args = github
        ? ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body', body]
        : [
            'mr',
            'create',
            '--source-branch',
            branch,
            '--target-branch',
            base,
            '--title',
            title,
            '--description',
            body,
            '--yes',
          ];
      if (options.draft) args.push('--draft');
      const output = run(cli, args, repoDir);
      p.log.success(output.split('\n').find((l) => l.startsWith('http')) ?? output);
      opened++;
    } catch (error) {
      spinner.stop(pc.red('Failed'));
      const err = error as { stderr?: Buffer | string; message?: string };
      p.log.error(err.stderr?.toString().trim() || err.message || String(error));
      process.exitCode = 1;
    } finally {
      if (repoDir) await cleanupTempDir(repoDir).catch(() => {});
    }
  }

  p.outro(opened > 0 ? pc.green(`Opened ${opened} request${opened === 1 ? '' : 's'}`) : 'Done');
}
