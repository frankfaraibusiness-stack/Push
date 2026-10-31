// api/edit-file.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const token = process.env.GITHUB_TOKEN;

    // NEW FEATURE: Intercept request to list user repositories automatically
    if (req.method === 'GET' && req.query.fetchRepos === 'true') {
        try {
            // Fetch list sorted by most recently updated projects
            const repoListRes = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!repoListRes.ok) return res.status(repoListRes.status).json({ error: "Could not pull repository directories." });

            const data = await repoListRes.json();
            // Filter out just the clean name info data needed for dropdown rendering
            const cleanRepos = data.map(r => ({ name: r.name, full_name: r.full_name }));
            return res.status(200).json(cleanRepos);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: List branches for a repo (powers the branch selector)
    if (req.method === 'GET' && req.query.listBranches) {
        try {
            const response = await fetch(`https://api.github.com/repos/${req.query.listBranches}/branches?per_page=100`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "Could not list branches." });
            const data = await response.json();
            return res.status(200).json(data.map(b => ({ name: b.name, protected: !!b.protected })));
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: Create a brand-new repository
    if (req.method === 'POST' && req.body && req.body.createRepo) {
        const { name, description, isPrivate } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: "Repository name is required." });
        }
        try {
            const response = await fetch('https://api.github.com/user/repos', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: name.trim(),
                    description: description || undefined,
                    private: !!isPrivate,
                    auto_init: true // so it has a default branch immediately, ready to push into
                })
            });
            const data = await response.json();
            if (!response.ok) return res.status(response.status).json({ error: data.message || "Could not create repository." });
            return res.status(200).json({ name: data.name, full_name: data.full_name, default_branch: data.default_branch });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: List contents of a repo path (used by the file browser drawer)
    // Frontend calls: GET ${BACKEND}?listFiles=${encodeURIComponent(`${repo}/contents/${path}`)}
    if (req.method === 'GET' && req.query.listFiles) {
        try {
            const url = `https://api.github.com/repos/${req.query.listFiles}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "Could not list directory contents." });

            const data = await response.json();
            // GitHub returns a single object (not array) if the path points to a file.
            // Normalize to an array so the frontend's `.sort()`/`.map()` always works.
            return res.status(200).json(Array.isArray(data) ? data : [data]);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: List the ENTIRE repo tree in one request, instead of the
    // frontend recursing directory-by-directory through the Contents API
    // (one round trip per folder, awaited sequentially — slow on repos
    // with lots of nested folders, e.g. Next.js's app/ and components/
    // trees). Uses the same Git Data API recursive-tree call the
    // deleteFolder route below already relies on.
    // Frontend calls: GET ${BACKEND}?listTree=${encodeURIComponent(repo)}&branch=${branch}
    if (req.method === 'GET' && req.query.listTree) {
        try {
            const repo = req.query.listTree;
            const ghHeaders = { 'Authorization': `Bearer ${token}` };

            let branch = req.query.branch;
            if (!branch) {
                const repoInfoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
                if (!repoInfoRes.ok) return res.status(repoInfoRes.status).json({ error: "Could not read repository info." });
                const repoInfo = await repoInfoRes.json();
                branch = repoInfo.default_branch;
            }

            const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`, { headers: ghHeaders });
            if (!refRes.ok) return res.status(refRes.status).json({ error: "Could not resolve branch ref." });
            const refData = await refRes.json();

            const commitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits/${refData.object.sha}`, { headers: ghHeaders });
            if (!commitRes.ok) return res.status(commitRes.status).json({ error: "Could not read base commit." });
            const commitData = await commitRes.json();

            const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${commitData.tree.sha}?recursive=1`, { headers: ghHeaders });
            if (!treeRes.ok) return res.status(treeRes.status).json({ error: "Could not read repository tree." });
            const treeData = await treeRes.json();

            const files = treeData.tree
                .filter(entry => entry.type === 'blob')
                .map(entry => ({ path: entry.path, sha: entry.sha, size: entry.size }));

            return res.status(200).json({ files, truncated: !!treeData.truncated, branch });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: Bulk upload — push many files to a repo in ONE commit instead of
    // one PUT (contents API) per file. This is the counterpart to
    // deleteFolder below: it uses the Git Data API to create a blob per
    // file (in parallel, capped concurrency), build a single tree on top
    // of the current HEAD, make one commit, and fast-forward the branch —
    // so uploading 1,000 files costs one commit, not 1,000.
    // Pulls GitHub's actual error message out of a failed response body
    // instead of letting callers fall back to a generic string. GitHub
    // error bodies are normally { message: "...", errors: [...] }.
    async function ghError(response, fallback) {
        try {
            const body = await response.json();
            if (body && body.message) {
                return `${fallback} (${response.status}): ${body.message}`;
            }
        } catch (_) {
            // body wasn't JSON — fall through to the generic message below.
        }
        return `${fallback} (${response.status})`;
    }

    if (req.method === 'POST' && req.body && req.body.bulkCommit) {
        const { repo: bcRepo, files, message, branch: bcBranchOverride } = req.body;
        if (!bcRepo || !Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: "Missing required parameters: repo or files." });
        }
        // Basic sanity cap — GitHub blobs max out at 100MB each and a single
        // request body this large would be impractical anyway; chunk on the
        // client if you have truly massive payloads.
        if (files.length > 5000) {
            return res.status(413).json({ error: "Too many files in one bulk commit (max 5000)." });
        }

        try {
            const ghHeaders = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };

            // 1. Resolve the target branch (explicit override, or the repo's
            //    default branch), current commit, and base tree sha.
            let branch = bcBranchOverride;
            if (!branch) {
                const repoInfoRes = await fetch(`https://api.github.com/repos/${bcRepo}`, { headers: ghHeaders });
                if (!repoInfoRes.ok) return res.status(repoInfoRes.status).json({ error: await ghError(repoInfoRes, "Could not read repository info.") });
                const repoInfo = await repoInfoRes.json();
                branch = repoInfo.default_branch;
            }

            const refRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/ref/heads/${branch}`, { headers: ghHeaders });
            if (!refRes.ok) return res.status(refRes.status).json({ error: await ghError(refRes, "Could not resolve branch ref.") });
            const refData = await refRes.json();
            const baseCommitSha = refData.object.sha;

            const commitRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/commits/${baseCommitSha}`, { headers: ghHeaders });
            if (!commitRes.ok) return res.status(commitRes.status).json({ error: await ghError(commitRes, "Could not read base commit.") });
            const commitData = await commitRes.json();
            const baseTreeSha = commitData.tree.sha;

            // 2. Create a blob for every file. Run with capped concurrency
            //    (5 at a time, down from 10 — GitHub's secondary rate limit
            //    triggers on bursts of rapid writes, and 10-wide concurrency
            //    across many back-to-back chunks tripped it in practice) and
            //    retry individual 403 "secondary rate limit" hits with
            //    backoff instead of giving up on the whole chunk immediately.
            const CONCURRENCY = 5;
            const blobResults = new Array(files.length);
            const errors = [];
            let nextIndex = 0;

            function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

            async function createBlobWithRetry(f, attempt = 0) {
                const blobRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/blobs`, {
                    method: 'POST',
                    headers: ghHeaders,
                    body: JSON.stringify({ content: f.content, encoding: 'base64' })
                });
                if (blobRes.ok) return { ok: true, data: await blobRes.json() };

                const isRateLimit = blobRes.status === 403 || blobRes.status === 429;
                if (isRateLimit && attempt < 3) {
                    // Respect Retry-After if GitHub sent one, else back off
                    // 2s / 5s / 12s.
                    const retryAfter = Number(blobRes.headers.get('retry-after'));
                    const waitMs = retryAfter > 0 ? retryAfter * 1000 : [2000, 5000, 12000][attempt];
                    await sleep(waitMs);
                    return createBlobWithRetry(f, attempt + 1);
                }
                return { ok: false, error: await ghError(blobRes, "Blob creation failed") };
            }

            async function worker() {
                while (nextIndex < files.length) {
                    const i = nextIndex++;
                    const f = files[i];
                    if (!f || !f.path || typeof f.content !== 'string') {
                        errors.push({ path: f && f.path, error: 'Missing path or content' });
                        continue;
                    }
                    try {
                        const result = await createBlobWithRetry(f);
                        if (!result.ok) {
                            errors.push({ path: f.path, error: result.error });
                            continue;
                        }
                        blobResults[i] = { path: f.path, mode: '100644', type: 'blob', sha: result.data.sha };
                    } catch (err) {
                        errors.push({ path: f.path, error: err.message });
                    }
                }
            }
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

            const treeEntries = blobResults.filter(Boolean);
            if (treeEntries.length === 0) {
                return res.status(422).json({ error: "No blobs could be created.", details: errors });
            }

            // 3. Create one new tree on top of the current tree (base_tree
            //    merges these paths in / overwrites existing ones; anything
            //    not mentioned stays untouched).
            const newTreeRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/trees`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
            });
            if (!newTreeRes.ok) return res.status(newTreeRes.status).json({ error: await ghError(newTreeRes, "Could not create new tree."), details: errors });
            const newTree = await newTreeRes.json();

            // 4. One commit for the whole batch.
            const newCommitRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/commits`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({
                    message: message || `Add ${treeEntries.length} file${treeEntries.length === 1 ? '' : 's'}`,
                    tree: newTree.sha,
                    parents: [baseCommitSha]
                })
            });
            if (!newCommitRes.ok) return res.status(newCommitRes.status).json({ error: await ghError(newCommitRes, "Could not create new commit."), details: errors });
            const newCommit = await newCommitRes.json();

            // 5. Fast-forward the branch ref.
            const updateRefRes = await fetch(`https://api.github.com/repos/${bcRepo}/git/refs/heads/${branch}`, {
                method: 'PATCH',
                headers: ghHeaders,
                body: JSON.stringify({ sha: newCommit.sha })
            });
            if (!updateRefRes.ok) return res.status(updateRefRes.status).json({ error: await ghError(updateRefRes, "Could not update branch ref."), details: errors });

            return res.status(200).json({
                success: true,
                committedCount: treeEntries.length,
                failedCount: errors.length,
                errors,
                commitSha: newCommit.sha
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    const { repo, path, content, sha, deleteRepo, deleteFile, deleteFolder, deletePaths, deleteAll, branch: branchOverride, message: customMessage } = req.method === 'GET' ? req.query : req.body;

    // NEW: Delete an entire repository
    if (req.method === 'DELETE' && deleteRepo) {
        try {
            const response = await fetch(`https://api.github.com/repos/${deleteRepo}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "Could not delete repository." });
            return res.status(200).json({ success: true });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: Delete an entire folder from a repository in ONE commit.
    // Instead of looping over every file inside the folder and firing a
    // separate contents-API DELETE (one commit per file, slow for repos
    // with many nested files), this walks the repo's current tree via the
    // Git Data API, drops every blob under the folder prefix, and writes
    // a single new tree + commit that removes them all at once.
    if (req.method === 'DELETE' && deleteFolder) {
        if (!repo || !path) {
            return res.status(400).json({ error: "Missing required parameters: repo or path." });
        }
        try {
            const ghHeaders = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };
            const folderPrefix = path.endsWith('/') ? path : `${path}/`;

            // 1. Resolve the target branch: explicit override, or the repo's default.
            let branch = branchOverride;
            if (!branch) {
                const repoInfoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
                if (!repoInfoRes.ok) return res.status(repoInfoRes.status).json({ error: await ghError(repoInfoRes, "Could not read repository info.") });
                const repoInfo = await repoInfoRes.json();
                branch = repoInfo.default_branch;
            }

            // 2. Resolve that branch to its current commit + tree sha.
            const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`, { headers: ghHeaders });
            if (!refRes.ok) return res.status(refRes.status).json({ error: await ghError(refRes, "Could not resolve branch ref.") });
            const refData = await refRes.json();
            const commitSha = refData.object.sha;

            const commitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits/${commitSha}`, { headers: ghHeaders });
            if (!commitRes.ok) return res.status(commitRes.status).json({ error: await ghError(commitRes, "Could not read base commit.") });
            const commitData = await commitRes.json();
            const baseTreeSha = commitData.tree.sha;

            // 3. Get the FULL recursive tree so we can see every file under the folder.
            const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`, { headers: ghHeaders });
            if (!treeRes.ok) return res.status(treeRes.status).json({ error: await ghError(treeRes, "Could not read repository tree.") });
            const treeData = await treeRes.json();

            if (treeData.truncated) {
                return res.status(422).json({ error: "Repository tree is too large to process in one request." });
            }

            const removed = treeData.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith(folderPrefix));
            if (removed.length === 0) {
                return res.status(404).json({ error: "No files found under that folder." });
            }

            // 4. Build the new tree: everything NOT under the folder, unchanged.
            //    IMPORTANT: keep every entry type here, not just 'blob'.
            //    A recursive tree listing can include 'commit' entries
            //    (submodules / gitlinks, mode 160000) and, in repos with
            //    certain history, stray 'tree' entries. Filtering those out
            //    by only keeping type === 'blob' silently dropped them from
            //    newTreeEntries, and POSTing a tree that omits a path whose
            //    parent directory still has other children confuses GitHub's
            //    tree builder on larger trees — that's what was surfacing as
            //    the generic "Could not create new tree" error on folders
            //    with 100+ files. Only drop entries that are actually inside
            //    the deleted folder; keep every other type as-is.
            const newTreeEntries = treeData.tree
                .filter(entry => !entry.path.startsWith(folderPrefix))
                .map(entry => ({
                    path: entry.path,
                    mode: entry.mode,
                    type: entry.type,
                    sha: entry.sha
                }));

            const newTreeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({ tree: newTreeEntries })
            });
            if (!newTreeRes.ok) return res.status(newTreeRes.status).json({ error: await ghError(newTreeRes, "Could not create new tree.") });
            const newTree = await newTreeRes.json();

            // 5. Commit the new tree on top of the current commit.
            const newCommitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({
                    message: `Delete folder ${path} (${removed.length} file${removed.length === 1 ? '' : 's'})`,
                    tree: newTree.sha,
                    parents: [commitSha]
                })
            });
            if (!newCommitRes.ok) return res.status(newCommitRes.status).json({ error: await ghError(newCommitRes, "Could not create new commit.") });
            const newCommit = await newCommitRes.json();

            // 6. Fast-forward the branch ref to the new commit.
            const updateRefRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
                method: 'PATCH',
                headers: ghHeaders,
                body: JSON.stringify({ sha: newCommit.sha })
            });
            if (!updateRefRes.ok) return res.status(updateRefRes.status).json({ error: await ghError(updateRefRes, "Could not update branch ref.") });

            return res.status(200).json({
                success: true,
                deletedCount: removed.length,
                deletedPaths: removed.map(e => e.path),
                commitSha: newCommit.sha
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: Delete an arbitrary set of files (e.g. "selected" files, or
    // literally every file in the repo) in ONE commit. Same approach as
    // deleteFolder above (Git Data API: rewrite the tree, make one commit,
    // fast-forward the ref) but driven by an explicit path list, or by
    // deleteAll to wipe every blob currently in the tree. This is what
    // "Delete selected" and "Delete ALL files" should use instead of
    // looping a single-file DELETE per path (one commit per file).
    if (req.method === 'DELETE' && (deletePaths || deleteAll)) {
        if (!repo) {
            return res.status(400).json({ error: "Missing required parameter: repo." });
        }
        if (!deleteAll && (!Array.isArray(deletePaths) || deletePaths.length === 0)) {
            return res.status(400).json({ error: "deletePaths must be a non-empty array." });
        }
        try {
            const ghHeaders = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };

            // 1. Resolve the target branch: explicit override, or the repo's default.
            let branch = branchOverride;
            if (!branch) {
                const repoInfoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
                if (!repoInfoRes.ok) return res.status(repoInfoRes.status).json({ error: await ghError(repoInfoRes, "Could not read repository info.") });
                const repoInfo = await repoInfoRes.json();
                branch = repoInfo.default_branch;
            }

            // 2. Resolve that branch to its current commit + tree sha.
            const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`, { headers: ghHeaders });
            if (!refRes.ok) return res.status(refRes.status).json({ error: await ghError(refRes, "Could not resolve branch ref.") });
            const refData = await refRes.json();
            const commitSha = refData.object.sha;

            const commitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits/${commitSha}`, { headers: ghHeaders });
            if (!commitRes.ok) return res.status(commitRes.status).json({ error: await ghError(commitRes, "Could not read base commit.") });
            const commitData = await commitRes.json();
            const baseTreeSha = commitData.tree.sha;

            // 3. Get the FULL recursive tree so we can see every file.
            const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`, { headers: ghHeaders });
            if (!treeRes.ok) return res.status(treeRes.status).json({ error: await ghError(treeRes, "Could not read repository tree.") });
            const treeData = await treeRes.json();

            if (treeData.truncated) {
                return res.status(422).json({ error: "Repository tree is too large to process in one request." });
            }

            // 4. Figure out which blobs to remove (files only — never
            //    match a 'tree' or 'commit'/submodule entry here).
            let removed;
            if (deleteAll) {
                removed = treeData.tree.filter(entry => entry.type === 'blob');
            } else {
                const targetSet = new Set(deletePaths);
                removed = treeData.tree.filter(entry => entry.type === 'blob' && targetSet.has(entry.path));
            }
            if (removed.length === 0) {
                return res.status(404).json({ error: "No matching files found to delete." });
            }

            // 5. Build the new tree: everything NOT being removed, unchanged.
            //    Keep every entry type here (blob, tree, commit/submodule) —
            //    only filtering type === 'blob' would silently drop
            //    submodule (gitlink, mode 160000) or stray 'tree' entries
            //    from the payload. On a large tree that mismatch is what
            //    GitHub's tree builder rejected with a generic 422, which
            //    surfaced here as "Could not create new tree."
            const removedSet = new Set(removed.map(e => e.path));
            const newTreeEntries = treeData.tree
                .filter(entry => !removedSet.has(entry.path))
                .map(entry => ({
                    path: entry.path,
                    mode: entry.mode,
                    type: entry.type,
                    sha: entry.sha
                }));

            // GitHub accepts an empty tree array fine (e.g. deleting every
            // file leaves nothing behind) — no special-casing needed.
            const newTreeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({ tree: newTreeEntries })
            });
            if (!newTreeRes.ok) return res.status(newTreeRes.status).json({ error: await ghError(newTreeRes, "Could not create new tree.") });
            const newTree = await newTreeRes.json();

            // 6. Commit the new tree on top of the current commit.
            const commitMessage = customMessage || (deleteAll
                ? `Delete all files (${removed.length} file${removed.length === 1 ? '' : 's'})`
                : `Delete ${removed.length} file${removed.length === 1 ? '' : 's'}`);

            const newCommitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({
                    message: commitMessage,
                    tree: newTree.sha,
                    parents: [commitSha]
                })
            });
            if (!newCommitRes.ok) return res.status(newCommitRes.status).json({ error: await ghError(newCommitRes, "Could not create new commit.") });
            const newCommit = await newCommitRes.json();

            // 7. Fast-forward the branch ref to the new commit.
            const updateRefRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branch}`, {
                method: 'PATCH',
                headers: ghHeaders,
                body: JSON.stringify({ sha: newCommit.sha })
            });
            if (!updateRefRes.ok) return res.status(updateRefRes.status).json({ error: await ghError(updateRefRes, "Could not update branch ref.") });

            return res.status(200).json({
                success: true,
                deletedCount: removed.length,
                deletedPaths: removed.map(e => e.path),
                commitSha: newCommit.sha
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // NEW: Delete a single file from a repository
    if (req.method === 'DELETE' && deleteFile) {
        if (!repo || !path || !sha) {
            return res.status(400).json({ error: "Missing required parameters: repo, path, or sha." });
        }
        try {
            const body = {
                message: customMessage || `Delete ${path}`,
                sha
            };
            if (branchOverride) body.branch = branchOverride;

            const response = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!response.ok) return res.status(response.status).json({ error: "Could not delete file." });
            const data = await response.json();
            return res.status(200).json(data);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (!repo || !path) {
        return res.status(400).json({ error: "Missing required parameters: repo or path." });
    }

    let url = `https://api.github.com/repos/${repo}/contents/${path}`;
    if (req.method === 'GET' && branchOverride) {
        url += `?ref=${encodeURIComponent(branchOverride)}`;
    }

    try {
        if (req.method === 'GET') {
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return res.status(response.status).json({ error: "File tracking data absent." });

            const data = await response.json();
            return res.status(200).json(data);
        }

        if (req.method === 'PUT') {
            const bodyData = {
                message: customMessage || "Production Pipeline Update",
                content: content,
                sha: sha || undefined
            };
            if (branchOverride) bodyData.branch = branchOverride;

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(bodyData)
            });

            const data = await response.json();
            return res.status(200).json(data);
        }
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
