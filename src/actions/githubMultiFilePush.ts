// plugins/scaffolder-backend-module-github-push-files/src/actions/githubMultiFilePush.ts

import { createTemplateAction, TemplateActionContext } from '@backstage/plugin-scaffolder-node';
import { Config } from '@backstage/config';
import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import { globby } from 'globby';
import { readFile } from 'fs/promises';
import path from 'path';

export const githubMultiFilePush = ({ config }: { config: Config }) =>
    createTemplateAction({
        id: 'github:multi-file-push',
        description: 'Pushes files or folders to GitHub via REST API (no git clone).',
        examples: [
            {
                description: 'Publish dist/ into the `assets/` folder on main',
                example: `
steps:
  - id: publish
    action: github:multi-file-push
    input:
      repoUrl: 'github.com?owner=my-org&repo=my-repo'
      branch: main
      sourcePath: ./dist
      targetPath: assets
      commitMessage: 'Deploy assets'
        `,
            },
        ],

        schema: {
            input: z.object({
                repoUrl: z
                    .string()
                    .describe('URL like github.com?owner=ORG&repo=REPO'),
                branch: z.string().describe('Branch name (must already exist)'),
                sourcePath: z
                    .string()
                    .describe('Folder in the workspace to upload'),
                targetPath: z
                    .string()
                    .default('.')
                    .describe('Path inside the repo to place files'),
                commitMessage: z
                    .string()
                    .default('Scaffolder commit')
                    .describe('Commit message'),
            }),
        },

        async handler(ctx: TemplateActionContext<z.infer<typeof this.schema.input>>) {
            const { repoUrl, branch, sourcePath, targetPath, commitMessage } = ctx.input;

            // Ensure URL has a scheme
            const full = repoUrl.startsWith('http')
                ? repoUrl
                : `https://${repoUrl}`;
            const u = new URL(full);
            const owner = u.searchParams.get('owner');
            const repo = u.searchParams.get('repo');
            if (!owner || !repo) {
                throw new Error(
                    "repoUrl must look like 'https://github.com?owner=ORG&repo=REPO'",
                );
            }

            // Pick the matching integration by host, or fallback to the first
            const integrations = config.getConfigArray('integrations.github');
            const ghInt =
                integrations.find(i => i.getString('host') === u.host) ||
                integrations[0];
            const token = ghInt.getString('token');
            const octokit = new Octokit({ auth: token });

            // Get latest commit SHA and base tree
            const { data: ref } = await octokit.git.getRef({
                owner,
                repo,
                ref: `heads/${branch}`,
            });
            const latestSha = ref.object.sha;
            const { data: commit } = await octokit.git.getCommit({
                owner,
                repo,
                commit_sha: latestSha,
            });
            const baseTreeSha = commit.tree.sha;

            // Collect files to push
            const absSource = path.resolve(ctx.workspacePath, sourcePath);
            const files = await globby(['**/*'], {
                cwd: absSource,
                absolute: true,
                dot: true,
                onlyFiles: true,
            });

            // Upload blobs and build tree entries
            const treeEntries = await Promise.all(
                files.map(async file => {
                    const content = await readFile(file);
                    const { data: blob } = await octokit.git.createBlob({
                        owner,
                        repo,
                        content: content.toString('base64'),
                        encoding: 'base64',
                    });

                    const rel = path
                        .relative(absSource, file)
                        .replace(/\\/g, '/');
                    // prefix with targetPath
                    const repoPath = targetPath === '.'
                        ? rel
                        : `${targetPath.replace(/\/+$/, '')}/${rel}`;

                    return {
                        path: repoPath,
                        mode: '100644',
                        type: 'blob',
                        sha: blob.sha,
                    };
                }),
            );

            // Create new tree, commit, and update the branch ref
            const { data: newTree } = await octokit.git.createTree({
                owner,
                repo,
                base_tree: baseTreeSha,
                tree: treeEntries,
            });

            const { data: newCommit } = await octokit.git.createCommit({
                owner,
                repo,
                message: commitMessage,
                tree: newTree.sha,
                parents: [latestSha],
            });

            await octokit.git.updateRef({
                owner,
                repo,
                ref: `heads/${branch}`,
                sha: newCommit.sha,
            });

            ctx.logger.info(
                `Pushed ${treeEntries.length} file(s) to ${owner}/${repo}@${branch}/${targetPath}`,
            );
        },
    });
