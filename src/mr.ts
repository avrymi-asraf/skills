import { execFileSync } from 'child_process';
import * as p from '@clack/prompts';
import pc from 'picocolors';

export interface MrOptions {
  message?: string;
  base?: string;
  draft?: boolean;
  help?: boolean;
}

export interface ParseMrOptionsResult {
  options: MrOptions;
  errors: string[];
}

export function parseMrOptions(args: string[]): ParseMrOptionsResult {
  const options: MrOptions = {};
  const errors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--draft' || arg === '-d') {
      options.draft = true;
    } else if (arg === '--message' || arg === '-m' || arg === '--base' || arg === '-b') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        errors.push(`${arg} requires a value`);
        continue;
      }
      if (arg === '--message' || arg === '-m') options.message = value;
      else options.base = value;
      i++;
    } else if (arg.startsWith('-')) {
      errors.push(`Unknown option: ${arg}`);
    } else {
      errors.push(`Unexpected argument: ${arg} (use -m to set the title)`);
    }
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
      .replace(/-+$/, '') || 'changes'
  );
}

/** Build a short commit/MR title from the changed file paths. */
export function generateTitle(files: string[]): string {
  if (files.length === 0) return 'Update';
  if (files.length === 1) return `Update ${files[0]}`;
  const dirs = new Set(files.map((f) => (f.includes('/') ? f.split('/')[0]! : '.')));
  if (dirs.size === 1) {
    const dir = [...dirs][0]!;
    return dir === '.' ? `Update ${files.length} files` : `Update ${files.length} files in ${dir}`;
  }
  return `Update ${files.length} files`;
}

export type Forge = 'github' | 'gitlab';

export function detectForge(remoteUrl: string): Forge {
  return /gitlab/i.test(remoteUrl) ? 'gitlab' : 'github';
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function defaultBranch(): string {
  const head = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (tryGit(['rev-parse', '--verify', `refs/remotes/origin/${name}`]) !== null) return name;
  }
  return 'main';
}

function showMrHelp(): void {
  console.log(`
Usage: skills mr [options]

Commit your local changes, push them, and open a pull/merge request.

Options:
  -m, --message <text>   Commit message and MR title (default: generated from changes)
  -b, --base <branch>    Target branch (default: the repository's default branch)
  -d, --draft            Open the MR as a draft

Notes:
  - On the default branch, a new branch is created for you.
  - Uses the gh CLI for GitHub remotes and glab for GitLab remotes.
`);
}

export async function runMr(options: MrOptions, errors: string[] = []): Promise<void> {
  if (options.help) {
    showMrHelp();
    return;
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`Error: ${error}`);
    process.exitCode = 1;
    return;
  }

  p.intro(pc.bgCyan(pc.black(' skills mr ')));

  try {
    if (tryGit(['rev-parse', '--is-inside-work-tree']) !== 'true') {
      throw new Error('Not inside a git repository');
    }
    const remoteUrl = tryGit(['remote', 'get-url', 'origin']);
    if (!remoteUrl) throw new Error("No 'origin' remote configured");

    const forge = detectForge(remoteUrl);
    const cli = forge === 'gitlab' ? 'glab' : 'gh';
    try {
      execFileSync(cli, ['--version'], { stdio: 'ignore' });
    } catch {
      throw new Error(`The '${cli}' CLI is required for ${forge} remotes (not found in PATH)`);
    }

    const base = options.base ?? defaultBranch();
    let branch = tryGit(['branch', '--show-current']) ?? '';

    const changed = git(['status', '--porcelain', '-uall'])
      .split('\n')
      .filter(Boolean)
      .map((line) =>
        line
          .slice(3)
          .replace(/^.* -> /, '')
          .replace(/^"|"$/g, '')
      );

    const title = options.message ?? generateTitle(changed);

    // Never put the MR on the base branch itself: move to a fresh branch.
    if (!branch || branch === base) {
      if (changed.length === 0) throw new Error(`No local changes to open a MR for`);
      branch = `skills/${slugify(title)}-${Date.now().toString(36)}`;
      git(['checkout', '-b', branch]);
      p.log.info(`Created branch ${pc.cyan(branch)}`);
    }

    if (changed.length > 0) {
      git(['add', '-A']);
      git(['commit', '-m', title]);
      p.log.success(`Committed ${changed.length} file${changed.length === 1 ? '' : 's'}`);
    }

    const baseRef = tryGit(['rev-parse', '--verify', `refs/remotes/origin/${base}`])
      ? `origin/${base}`
      : base;
    const ahead = tryGit(['rev-list', '--count', `${baseRef}..HEAD`]);
    if (ahead === '0') throw new Error(`Nothing to open: no commits ahead of ${base}`);

    const spinner = p.spinner();
    spinner.start(`Pushing ${branch}`);
    git(['push', '-u', 'origin', branch]);
    spinner.stop(`Pushed ${pc.cyan(branch)}`);

    // Body: the commits that make up the MR.
    const body = git(['log', '--reverse', '--format=- %s', `${baseRef}..HEAD`]);
    const mrTitle = options.message ?? tryGit(['log', '-1', '--format=%s']) ?? title;

    const createArgs =
      forge === 'gitlab'
        ? [
            'mr',
            'create',
            '--source-branch',
            branch,
            '--target-branch',
            base,
            '--title',
            mrTitle,
            '--description',
            body,
            '--yes',
            ...(options.draft ? ['--draft'] : []),
          ]
        : [
            'pr',
            'create',
            '--head',
            branch,
            '--base',
            base,
            '--title',
            mrTitle,
            '--body',
            body,
            ...(options.draft ? ['--draft'] : []),
          ];

    let output: string;
    try {
      output = execFileSync(cli, createArgs, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      // An MR for this branch may already exist; the push has updated it.
      const viewArgs = forge === 'gitlab' ? ['mr', 'view', branch] : ['pr', 'view', branch];
      try {
        output = execFileSync(
          cli,
          [...viewArgs, ...(forge === 'github' ? ['--json', 'url', '-q', '.url'] : [])],
          {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        ).trim();
        p.log.info('MR already exists; it was updated with the new commits');
      } catch {
        throw error;
      }
    }

    const url = output.split('\n').find((l) => l.startsWith('http')) ?? output;
    p.outro(`${pc.green('Done')} ${url}`);
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = err.stderr?.toString().trim() || err.message || String(error);
    p.log.error(detail);
    p.outro(pc.red('Failed'));
    process.exitCode = 1;
  }
}
